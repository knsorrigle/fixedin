/**
 * M1 pipeline: parse → lockfile → resolve.
 * Produces the list of packages implicated by the error, with installed
 * versions and GitHub repos.
 */
import { basename, dirname } from 'node:path';
import { Diagnostics } from './diagnostics.js';
import { declaredDependencies, relationOf, type Relation } from './relation.js';
import {
  findInNodeModules,
  locateLockfile,
  LockfileError,
  openLockfile,
  type InstalledPackage,
  type LockfileReader,
} from './lockfile/index.js';
import type { NetClient } from './net/client.js';
import { parseError, type FrameCopy, type PackageCandidate, type ParsedError } from './parse/index.js';
import { parseGitHubUrl, ResolveError, resolveRepo, type RepoRef, type ResolvedRepo } from './resolve/index.js';

export interface DetectedPackage {
  candidate: PackageCandidate;
  /** The copy the app most likely loaded (top-level first). */
  installed?: InstalledPackage;
  /** Other copies at different versions (nested node_modules). */
  otherCopies: InstalledPackage[];
  repo?: ResolvedRepo;
  /** Direct dependency, or pulled in by something else (and by what). */
  relation: Relation;
}

export interface DetectResult {
  parsed: ParsedError;
  lockfile?: { kind: LockfileReader['kind']; flavor?: LockfileReader['flavor']; file: string };
  packages: DetectedPackage[];
  /** Set when --repo was given. */
  explicitRepo?: RepoRef;
  diagnostics: Diagnostics;
  /** Look up another package's installed version (used to link --repo to a package). */
  lookupInstalled: (name: string) => { installed?: InstalledPackage; otherCopies: InstalledPackage[] };
  /** Relation of another package (used when --repo links to a package not in the trace). */
  relationOf: (name: string, installed: InstalledPackage | undefined) => Relation;
}

/** Every known copy of `name`: lockfile first, then node_modules (capped at the lockfile's directory). */
function findCopies(
  cwd: string,
  reader: LockfileReader | undefined,
  name: string,
  diagnostics: Diagnostics,
): { copies: InstalledPackage[]; tried: string[] } {
  const copies = reader?.find(name) ?? [];
  if (copies.length) return { copies, tried: [] };
  const nm = findInNodeModules(cwd, name, reader ? dirname(reader.file) : undefined);
  if (nm.found) {
    if (reader) diagnostics.info('lockfile', `${name} is not in ${reader.file}; using ${nm.found.source}.`);
    return { copies: [nm.found], tried: [] };
  }
  return { copies: [], tried: reader ? [`${reader.file} (no entry)`, ...nm.tried] : nm.tried };
}

function notInstalledWarning(name: string, reader: LockfileReader | undefined, tried: string[], diagnostics: Diagnostics) {
  diagnostics.warn(
    'lockfile',
    `${name} is not installed in this project${reader ? ` (not in ${basename(reader.file)} or node_modules)` : ''}; its version can't be compared. Wrong --cwd?`,
    tried,
  );
}

/** Top-level copy (what the app itself loads). Warns when nothing is found. */
export function lookupInstalled(
  cwd: string,
  reader: LockfileReader | undefined,
  name: string,
  diagnostics: Diagnostics,
): { installed?: InstalledPackage; otherCopies: InstalledPackage[] } {
  const { copies, tried } = findCopies(cwd, reader, name, diagnostics);
  if (!copies.length) {
    notInstalledWarning(name, reader, tried, diagnostics);
    return { otherCopies: [] };
  }
  return { installed: copies[0]!, otherCopies: copies.slice(1).filter((c) => c.version !== copies[0]!.version) };
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * Pick the copy the stack trace actually ran, not just the hoisted one:
 *   1. a version embedded in the frame path (pnpm/bun store, yarn zip cache, Deno cache)
 *   2. the frame's install path matched against lockfile locations (longest wins,
 *      so ".../wait-on/node_modules/axios" beats "node_modules/axios")
 *   3. the top-level copy
 */
export function selectCopy(
  name: string,
  frame: FrameCopy | undefined,
  copies: InstalledPackage[],
): InstalledPackage | undefined {
  const top = copies[0];
  const mark = (c: InstalledPackage, selectedBy: InstalledPackage['selectedBy']): InstalledPackage => ({
    ...c,
    ...(selectedBy ? { selectedBy } : {}),
    ...(top && top.version !== c.version ? { topLevelVersion: top.version } : {}),
  });

  if (frame?.version) {
    const same = copies.filter((c) => c.version === frame.version);
    const byPath = frame.installPath ? same.find((c) => norm(frame.installPath!).endsWith(`/${norm(c.location)}`)) : undefined;
    const hit = byPath ?? same[0];
    if (hit) return mark(hit, 'frame-version');
    // Not in the lockfile (or no lockfile at all): the path itself is the evidence.
    return mark(
      {
        name,
        version: frame.version,
        location: frame.installPath ?? `(${frame.versionFrom} path)`,
        topLevel: false,
        source: frame.installPath ?? 'stack trace',
      },
      'frame-version',
    );
  }

  if (frame?.installPath) {
    const path = norm(frame.installPath);
    const matches = copies.filter((c) => {
      const loc = norm(c.location);
      return path === loc || path.endsWith(`/${loc}`);
    });
    const best = matches.sort((a, b) => b.location.length - a.location.length)[0];
    if (best && best !== top) return mark(best, 'frame-install-path');
  }
  return top;
}

export interface DetectOptions {
  cwd: string;
  client: NetClient;
  /** owner/name — skips package→repo detection. */
  repo?: string;
  /** Max packages to resolve against the registry. */
  maxPackages?: number;
}

export async function detect(input: string, opts: DetectOptions): Promise<DetectResult> {
  const diagnostics = new Diagnostics();
  const parsed = parseError(input);
  if (!parsed.query) diagnostics.warn('parse', 'Could not find an error message line in the input.');

  let explicitRepo: RepoRef | undefined;
  if (opts.repo) {
    explicitRepo = parseGitHubUrl(opts.repo);
    if (!explicitRepo) throw new Error(`--repo must look like owner/name, got "${opts.repo}"`);
  }

  if (parsed.packages.length === 0 && !explicitRepo) {
    diagnostics.warn(
      'parse',
      'No npm packages found in the error. fixedin looks for node_modules/<pkg>/ paths in stack frames and "Cannot find module" messages. Paste the full stack trace, or pass --repo owner/name.',
    );
  }

  // Lockfile
  let reader: LockfileReader | undefined;
  const { found, tried } = locateLockfile(opts.cwd);
  if (!found) {
    diagnostics.warn('lockfile', `No lockfile found from ${opts.cwd} upward; will read node_modules/*/package.json instead.`, tried);
  } else {
    try {
      reader = openLockfile(found, opts.cwd);
    } catch (err) {
      if (!(err instanceof LockfileError)) throw err;
      diagnostics.warn('lockfile', err.message, err.tried);
    }
  }

  const max = opts.maxPackages ?? 8;
  const selected = parsed.packages.slice(0, max);
  if (parsed.packages.length > max) {
    diagnostics.info(
      'parse',
      `Found ${parsed.packages.length} packages in the trace; only the top ${max} are resolved: skipped ${parsed.packages
        .slice(max)
        .map((p) => p.name)
        .join(', ')}.`,
    );
  }

  const declared = declaredDependencies(opts.cwd, reader ? dirname(reader.file) : undefined);
  for (const p of declared.problems) diagnostics.warn('lockfile', p);

  const packages = await Promise.all(
    selected.map(async (candidate): Promise<DetectedPackage> => {
      const det: DetectedPackage = { candidate, otherCopies: [], relation: { kind: 'unknown', reason: 'not installed' } };

      const { copies, tried } = findCopies(opts.cwd, reader, candidate.name, diagnostics);
      const chosen = selectCopy(candidate.name, candidate.copy, copies);
      if (chosen) {
        det.installed = chosen;
        det.otherCopies = copies.filter((c) => c.version !== chosen.version);
        if (chosen.selectedBy) {
          diagnostics.info(
            'lockfile',
            `${candidate.name}: using ${chosen.version} at ${chosen.location}, the copy the stack trace ran${
              chosen.topLevelVersion ? ` (the top-level copy is ${chosen.topLevelVersion})` : ''
            }.`,
          );
        }
      } else {
        notInstalledWarning(candidate.name, reader, tried, diagnostics);
      }
      det.relation = relationOf(candidate.name, det.installed, reader, declared.names);
      if (det.relation.kind === 'transitive') {
        diagnostics.info(
          'lockfile',
          `${candidate.name}@${det.installed!.version} is a transitive dependency: ${[...det.relation.chain].reverse().map((d) => `${d.name}@${d.version}`).join(' → ')} → ${candidate.name}.`,
        );
      }

      if (!explicitRepo) {
        try {
          det.repo = await resolveRepo(opts.client, candidate.name);
        } catch (err) {
          if (!(err instanceof ResolveError)) throw err;
          diagnostics.warn('resolve', err.message, err.tried);
        }
      }
      return det;
    }),
  );

  for (const w of new Set(reader?.warnings ?? [])) diagnostics.warn('lockfile', w);

  return {
    parsed,
    ...(reader ? { lockfile: { kind: reader.kind, ...(reader.flavor ? { flavor: reader.flavor } : {}), file: reader.file } } : {}),
    lookupInstalled: (name: string) => lookupInstalled(opts.cwd, reader, name, diagnostics),
    relationOf: (name: string, installed: InstalledPackage | undefined) => relationOf(name, installed, reader, declared.names),
    packages,
    ...(explicitRepo ? { explicitRepo } : {}),
    diagnostics,
  };
}
