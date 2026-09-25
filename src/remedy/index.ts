/**
 * remedy/: turn "fixed in X" into something the user can actually do.
 *
 * For a direct dependency that's simply "upgrade to >=X". For a transitive one
 * the project can't upgrade it directly — its parent decides — so:
 *
 *   refresh         the parent's range already allows a fixed version; the lockfile
 *                   just pinned an older one → re-resolve it
 *   upgrade-parent  a newer parent release allows a fixed version (or drops the
 *                   dependency) → upgrade the parent to that release
 *   override        no parent release does → force the version, at your own risk
 *
 * Every command and override syntax below was checked against the real package
 * managers (npm 11, pnpm 10, yarn 1.22 and 4.18, bun 1.4, deno 2.9). Notably
 * `yarn upgrade <pkg>` does NOT refresh a transitive dependency in yarn 1, and
 * deleting deno.lock entries leaves Deno's lockfile broken — hence the steps.
 */
import semver from 'semver';
import type { Dependent, LockfileReader } from '../lockfile/index.js';
import type { NetClient } from '../net/client.js';
import type { Relation } from '../relation.js';
import { candidateVersions, fetchPackument, type Packument } from '../release/index.js';
import { registryUrl } from '../resolve/index.js';

export type PackageManager = 'npm' | 'pnpm' | 'yarn-classic' | 'yarn-berry' | 'bun' | 'deno';

export function packageManagerOf(lockfile: { kind: LockfileReader['kind']; flavor?: LockfileReader['flavor'] } | undefined): PackageManager {
  switch (lockfile?.kind) {
    case 'pnpm':
      return 'pnpm';
    case 'yarn':
      return lockfile.flavor === 'classic' ? 'yarn-classic' : 'yarn-berry';
    case 'bun':
      return 'bun';
    case 'deno':
      return 'deno';
    default:
      return 'npm';
  }
}

export interface Remedy {
  kind: 'refresh' | 'upgrade-parent' | 'override';
  /** The package that pulled in the vulnerable copy, and the range it declares. */
  parent: { name: string; version: string; range: string };
  /** One command that does it, when there is one. */
  command?: string;
  /** What to do when there's no single command, or a caveat about the command. */
  note?: string;
  /** For upgrade-parent. */
  upgradeParentTo?: { version: string; range: string | null; majorBump: boolean };
  /** A package.json override that forces a fixed version (for upgrade-parent and override; a refresh needs none). */
  override?: { snippet: string; note: string };
  /** One-line advice. */
  summary: string;
}

export function refreshCommand(pm: PackageManager, name: string): { command?: string; note?: string } {
  switch (pm) {
    case 'npm':
      return { command: `npm update ${name}` };
    case 'pnpm':
      return { command: `pnpm update ${name}` };
    case 'yarn-berry':
      return { command: `yarn up -R ${name}` };
    case 'bun':
      return { command: `bun update ${name}` };
    case 'yarn-classic':
      // `yarn upgrade <pkg>` only touches direct dependencies in yarn 1.
      return { note: `delete the "${name}@…" entries from yarn.lock, then run \`yarn install\`` };
    case 'deno':
      return { command: 'rm deno.lock && deno install', note: 'this re-resolves every package, not just this one' };
  }
}

export function overrideFor(pm: PackageManager, parent: string, name: string, range: string): { snippet: string; note: string } {
  const risk = `${parent} doesn't declare support for ${name} ${range}; run its tests after forcing it`;
  switch (pm) {
    case 'npm':
      return { snippet: JSON.stringify({ overrides: { [parent]: { [name]: range } } }), note: risk };
    case 'pnpm':
      return { snippet: JSON.stringify({ pnpm: { overrides: { [`${parent}>${name}`]: range } } }), note: risk };
    case 'yarn-classic':
    case 'yarn-berry':
      return { snippet: JSON.stringify({ resolutions: { [`${parent}/${name}`]: range } }), note: risk };
    case 'bun':
      return { snippet: JSON.stringify({ overrides: { [name]: range } }), note: `Bun overrides apply to every copy of ${name}; ${risk}` };
    case 'deno':
      return { snippet: JSON.stringify({ overrides: { [parent]: { [name]: range } } }), note: `goes in package.json (Deno reads its overrides); ${risk}` };
  }
}

interface Manifest {
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** The range `manifest` declares for `name`, stripped of an "npm:" protocol. undefined = not a dependency. */
function declaredRange(m: Manifest | undefined, name: string): string | undefined {
  const r = m?.dependencies?.[name] ?? m?.optionalDependencies?.[name];
  return r?.replace(/^npm:(?=[\^~<>=*\d])/, '');
}

/** Would a fresh install of `range` pick a version that has the fix? */
export function rangeGetsFix(range: string, available: string[], fixedIn: string): string | undefined {
  const best = semver.maxSatisfying(available, range);
  return best && semver.gte(best, fixedIn) ? best : undefined;
}

export interface PlanInput {
  name: string;
  installedVersion: string;
  fixedIn: string;
  relation: Relation;
  pm: PackageManager;
  /** Packument of `name` (for which versions exist). */
  packument: Packument;
  client: NetClient;
}

export async function planRemedy(i: PlanInput): Promise<Remedy | undefined> {
  if (i.relation.kind !== 'transitive') return undefined;
  const p: Dependent = i.relation.chain[0]!;
  const available = candidateVersions(i.packument);

  // The parent's declared range: from the lockfile when it records ranges, else from npm.
  let range = p.range?.replace(/^npm:(?=[\^~<>=*\d])/, '');
  if (!range) {
    const m = await i.client.getJson<Manifest>(registryUrl(p.name, `/${p.version}`));
    range = declaredRange(m, i.name);
  }
  if (!range) return undefined;

  const target = `^${i.fixedIn}`;
  const override = overrideFor(i.pm, p.name, i.name, target);
  const parent = { name: p.name, version: p.version, range };
  const chainNote =
    i.relation.chain.length > 1
      ? ` (${p.name} itself comes from ${i.relation.chain
          .slice(1)
          .map((d) => `${d.name}@${d.version}`)
          .join(' ← ')})`
      : '';

  // 1. The range already allows a fixed version: only the lockfile is stale.
  const refreshed = rangeGetsFix(range, available, i.fixedIn);
  if (refreshed) {
    const { command, note } = refreshCommand(i.pm, i.name);
    return {
      kind: 'refresh',
      parent,
      ...(command ? { command } : {}),
      ...(note ? { note } : {}),
      summary: `Its range already allows ${refreshed}; the lockfile just pinned ${i.installedVersion}. Refresh it${command ? `: ${command}` : ` — ${note}`}`,
    };
  }

  // 2. A newer parent release that allows a fixed version, or no longer depends on it.
  const parentPackument = await fetchPackument(i.client, p.name);
  const newer = candidateVersions(parentPackument).filter((v) => semver.gt(v, p.version));
  for (const v of newer) {
    const r = declaredRange(parentPackument.versions[v] as Manifest, i.name);
    if (r !== undefined && !rangeGetsFix(r, available, i.fixedIn)) continue;
    const majorBump = semver.major(v) > semver.major(p.version) || (semver.major(p.version) === 0 && semver.minor(v) > semver.minor(p.version));
    const why = r === undefined ? `${v} no longer depends on ${i.name}` : `it requires ${i.name} ${r}, which has the fix`;
    return {
      kind: 'upgrade-parent',
      parent,
      upgradeParentTo: { version: v, range: r ?? null, majorBump },
      override,
      summary: `Upgrade ${p.name} to >=${v} (${why})${majorBump ? ` — a major upgrade: check ${p.name}'s changelog` : ''}${chainNote}`,
    };
  }

  // 3. Nothing upstream accepts a fixed version.
  return {
    kind: 'override',
    parent,
    override,
    summary: `No ${p.name} release accepts ${i.name} >=${i.fixedIn} yet. Force it with an override${chainNote}:`,
  };
}
