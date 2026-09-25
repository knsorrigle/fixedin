/**
 * yarn.lock reader for both formats:
 *
 * Classic (yarn 1) — a custom text format. It does not record which packages
 * are direct dependencies, so top-level versions are found by looking up the
 * `name@range` strings from the nearest package.json:
 *
 *     "string-width-cjs@npm:string-width@^4.2.0", semver@^7.5.4:
 *       version "4.2.3"
 *
 * Berry (yarn 2+, `__metadata:`) — YAML. Workspaces are entries themselves
 * ("app@workspace:.") listing their dependencies, and every key is a
 * protocol-qualified descriptor ("axios@npm:1.1.3"). yarn 2 writes dependency
 * ranges without the protocol ("axios: 1.1.3"); later versions write "npm:1.1.3".
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import semver from 'semver';
import type { InstalledPackage, LockfileReader } from './index.js';
import { LockfileError } from './index.js';
import { selectImporter } from './pnpm.js';
import { parseYamlSubset, YamlSubsetError, type YamlMap } from './yaml.js';

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

interface PackageJson {
  name?: string;
  version?: string;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** "@scope/pkg@npm:^1.0.0" → { name: "@scope/pkg", range: "npm:^1.0.0" } */
export function splitDescriptor(d: string): { name: string; range: string } | undefined {
  const at = d.indexOf('@', d.startsWith('@') ? 1 : 0);
  if (at <= 0) return undefined;
  return { name: d.slice(0, at), range: d.slice(at + 1) };
}

/** The real package behind a range: "npm:string-width@^4.2.0" → "string-width", "^1.0.0" → undefined. */
export function aliasTarget(range: string): string | undefined {
  const m = range.match(/^npm:(@?[^@]+)@/);
  return m?.[1];
}

/** Keys are comma-separated descriptor lists, each optionally quoted. */
export function splitKeyList(key: string): string[] {
  return key
    .split(',')
    .map((k) => k.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

export function isYarnBerry(text: string): boolean {
  return /^__metadata:\s*$/m.test(text);
}

/** undefined if the file doesn't exist; an error naming the file if it's unreadable. */
function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    throw new LockfileError(`Could not read ${path}: ${(err as Error).message}`, [path]);
  }
}

/** Nearest package.json from cwd up to (and including) the lockfile directory. */
function nearestPackageJson(cwd: string, lockDir: string): { path: string; json: PackageJson } | undefined {
  let dir = resolve(cwd);
  const stop = resolve(lockDir);
  for (;;) {
    const p = join(dir, 'package.json');
    const json = readJson<PackageJson>(p);
    if (json) return { path: p, json };
    if (dir === stop || dirname(dir) === dir) return undefined;
    dir = dirname(dir);
  }
}

/** Workspace directories from the root package.json (supports "dir/*" and exact paths). */
function workspaceDirs(lockDir: string): string[] {
  const root = readJson<PackageJson>(join(lockDir, 'package.json'));
  const globs = Array.isArray(root?.workspaces) ? root.workspaces : (root?.workspaces?.packages ?? []);
  const dirs: string[] = [];
  for (const g of globs) {
    if (g.endsWith('/*')) {
      const base = join(lockDir, g.slice(0, -2));
      if (!existsSync(base)) continue;
      for (const e of readdirSync(base, { withFileTypes: true })) if (e.isDirectory()) dirs.push(join(base, e.name));
    } else if (!/[*?{[]/.test(g)) {
      dirs.push(join(lockDir, g));
    }
  }
  return dirs;
}

function sortedCopies(name: string, versions: Iterable<string>, exclude: string | undefined, path: string): InstalledPackage[] {
  const vs = [...new Set(versions)].filter((v) => v !== exclude);
  vs.sort((a, b) => (semver.valid(a) && semver.valid(b) ? semver.rcompare(a, b) : a.localeCompare(b)));
  return vs.map((version) => ({ name, version, location: `node_modules/${name}`, topLevel: false, source: path }));
}

// ---------------------------------------------------------------------------
// Classic (v1)
// ---------------------------------------------------------------------------

export interface ClassicEntry {
  keys: string[];
  version: string;
}

export function parseClassic(text: string, path: string): ClassicEntry[] {
  const entries: ClassicEntry[] = [];
  let current: { keys: string[]; version?: string; line: number } | undefined;
  const flush = () => {
    if (!current) return;
    if (!current.version) throw new LockfileError(`Could not parse ${path}: entry at line ${current.line} has no version.`, [path]);
    entries.push({ keys: current.keys, version: current.version });
    current = undefined;
  };
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || line.startsWith('#')) return;
    if (!/^\s/.test(line)) {
      flush();
      if (!line.endsWith(':')) throw new LockfileError(`Could not parse ${path}: line ${i + 1} is not an entry header.`, [path]);
      current = { keys: splitKeyList(line.slice(0, -1)), line: i + 1 };
      return;
    }
    const m = line.match(/^ {2}version:? "?([^"\s]+)"?\s*$/);
    if (m && current) current.version = m[1]!;
  });
  flush();
  return entries;
}

function classicReader(text: string, path: string, cwd: string): LockfileReader {
  const entries = parseClassic(text, path);
  const lockDir = dirname(path);
  const byKey = new Map<string, ClassicEntry>();
  const versionsByName = new Map<string, Set<string>>();
  for (const e of entries) {
    for (const k of e.keys) {
      byKey.set(k, e);
      const d = splitDescriptor(k);
      if (!d) continue;
      const real = aliasTarget(d.range) ?? d.name;
      if (!versionsByName.has(real)) versionsByName.set(real, new Set());
      versionsByName.get(real)!.add(e.version);
    }
  }
  const pkg = nearestPackageJson(cwd, lockDir);

  const direct = (name: string): InstalledPackage | undefined => {
    if (!pkg) return undefined;
    const pkgDir = relative(lockDir, dirname(pkg.path)).split(/[\\/]/).filter(Boolean).join('/');
    const location = pkgDir ? `${pkgDir}/node_modules/${name}` : `node_modules/${name}`;
    for (const field of DEP_FIELDS) {
      for (const [dep, range] of Object.entries(pkg.json[field] ?? {})) {
        const real = aliasTarget(range) ?? dep;
        if (real !== name) continue;
        const e = byKey.get(`${dep}@${range}`);
        if (e) return { name, version: e.version, location, topLevel: true, source: path };
        // Workspace sibling: classic yarn doesn't lock it; read its package.json.
        for (const ws of workspaceDirs(lockDir)) {
          const wsPkg = readJson<PackageJson>(join(ws, 'package.json'));
          if (wsPkg?.name === dep && wsPkg.version) {
            return { name, version: wsPkg.version, location, topLevel: true, source: join(ws, 'package.json') };
          }
        }
      }
    }
    return undefined;
  };

  return {
    kind: 'yarn',
    file: path,
    find(name) {
      const d = direct(name);
      return [...(d ? [d] : []), ...sortedCopies(name, versionsByName.get(name) ?? [], d?.version, path)];
    },
  };
}

// ---------------------------------------------------------------------------
// Berry (v2+)
// ---------------------------------------------------------------------------

interface BerryEntry {
  descriptors: string[];
  name: string;
  version: string;
  /** "workspace:packages/web" for workspace entries. */
  workspacePath?: string;
  dependencies: Record<string, string>;
}

/** yarn 2 omits the default protocol in dependency ranges: "1.1.3" means "npm:1.1.3". */
export function normalizeBerryRange(range: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(range) ? range : `npm:${range}`;
}

export function parseBerry(text: string, path: string): BerryEntry[] {
  let doc: YamlMap;
  try {
    doc = parseYamlSubset(text);
  } catch (err) {
    throw new LockfileError(`Could not parse ${path}: ${err instanceof YamlSubsetError ? err.message : (err as Error).message}`, [path]);
  }
  const entries: BerryEntry[] = [];
  for (const [key, value] of Object.entries(doc)) {
    if (key === '__metadata' || typeof value !== 'object') continue;
    const resolution = typeof value.resolution === 'string' ? value.resolution : undefined;
    const version = typeof value.version === 'string' ? value.version : undefined;
    const res = resolution ? splitDescriptor(resolution) : undefined;
    if (!res || !version) {
      throw new LockfileError(`Could not parse ${path}: entry "${key.slice(0, 80)}" has no resolution or version.`, [path]);
    }
    const deps: Record<string, string> = {};
    const d = value.dependencies;
    if (d && typeof d === 'object') for (const [k, v] of Object.entries(d)) if (typeof v === 'string') deps[k] = v;
    entries.push({
      descriptors: splitKeyList(key),
      name: res.name,
      version,
      ...(res.range.startsWith('workspace:') ? { workspacePath: res.range.slice('workspace:'.length) } : {}),
      dependencies: deps,
    });
  }
  return entries;
}

/**
 * Yarn catalogs (yarn ≥4.10): a dependency written as "catalog:" or
 * "catalog:<name>" takes its range from .yarnrc.yml (`catalog:` / `catalogs.<name>`).
 */
export function loadCatalogs(lockDir: string): { get(ref: string, dep: string): string | undefined; error?: string } {
  const rc = join(lockDir, '.yarnrc.yml');
  if (!existsSync(rc)) return { get: () => undefined };
  let doc: YamlMap;
  try {
    doc = parseYamlSubset(readFileSync(rc, 'utf8'));
  } catch (err) {
    return { get: () => undefined, error: `Could not read catalogs from ${rc}: ${(err as Error).message}` };
  }
  const asMap = (v: unknown) => (v && typeof v === 'object' ? (v as YamlMap) : undefined);
  return {
    get(ref, dep) {
      const name = ref.slice('catalog:'.length);
      const catalog = !name || name === 'default' ? asMap(doc.catalog) : asMap(asMap(doc.catalogs)?.[name]);
      const range = catalog?.[dep];
      return typeof range === 'string' ? range : undefined;
    },
  };
}

function berryReader(text: string, path: string, cwd: string): LockfileReader {
  const entries = parseBerry(text, path);
  const lockDir = dirname(path);
  const warnings: string[] = [];
  let catalogs: ReturnType<typeof loadCatalogs> | undefined;
  const byDescriptor = new Map<string, BerryEntry>();
  for (const e of entries) for (const d of e.descriptors) byDescriptor.set(d, e);

  const workspaces = entries.filter((e) => e.workspacePath !== undefined);
  const wsId = selectImporter(
    workspaces.map((w) => w.workspacePath!),
    lockDir,
    cwd,
  );
  const ws = workspaces.find((w) => w.workspacePath === wsId);

  // Workspace entries say "0.0.0-use.local"; their real version is in package.json.
  const versionOf = (e: BerryEntry): { version: string; source: string } => {
    if (e.workspacePath === undefined) return { version: e.version, source: path };
    const pj = join(lockDir, e.workspacePath, 'package.json');
    const v = readJson<PackageJson>(pj)?.version;
    return v ? { version: v, source: pj } : { version: e.version, source: path };
  };

  const versionsByName = new Map<string, Set<string>>();
  for (const e of entries) {
    if (e.workspacePath !== undefined) continue;
    if (!versionsByName.has(e.name)) versionsByName.set(e.name, new Set());
    versionsByName.get(e.name)!.add(e.version);
  }

  /** The lockfile entry a workspace dependency resolved to. */
  const resolveDep = (dep: string, range: string): BerryEntry | undefined => {
    let r = range;
    if (r.startsWith('catalog:')) {
      catalogs ??= loadCatalogs(lockDir);
      if (catalogs.error) warnings.push(catalogs.error);
      const fromCatalog = catalogs.get(r, dep);
      if (fromCatalog) r = fromCatalog;
    }
    const exact = byDescriptor.get(`${dep}@${normalizeBerryRange(r)}`);
    if (exact) return exact;
    // Unmatched descriptor (e.g. catalog missing from .yarnrc.yml): only an
    // unambiguous answer is acceptable.
    const candidates = entries.filter((e) => e.workspacePath === undefined && e.name === (aliasTarget(r) ?? dep));
    const versions = new Set(candidates.map((e) => e.version));
    if (versions.size === 1) return candidates[0];
    if (versions.size > 1) {
      warnings.push(`${dep}@${range} in ${path} could not be matched to a lockfile entry and ${versions.size} versions are locked (${[...versions].join(', ')}); not guessing which is direct.`);
    }
    return undefined;
  };

  return {
    kind: 'yarn',
    file: path,
    warnings,
    find(name) {
      let direct: InstalledPackage | undefined;
      if (ws) {
        for (const [dep, range] of Object.entries(ws.dependencies)) {
          if ((aliasTarget(range) ?? dep) !== name && dep !== name) continue;
          const e = resolveDep(dep, range);
          if (!e || e.name !== name) continue;
          const { version, source } = versionOf(e);
          const location = ws.workspacePath === '.' ? `node_modules/${dep}` : `${ws.workspacePath}/node_modules/${dep}`;
          direct = { name, version, location, topLevel: true, source };
          break;
        }
      }
      return [...(direct ? [direct] : []), ...sortedCopies(name, versionsByName.get(name) ?? [], direct?.version, path)];
    },
  };
}

// ---------------------------------------------------------------------------

export function parseYarnLock(text: string, path: string, cwd: string = dirname(path)): LockfileReader {
  if (isYarnBerry(text)) return berryReader(text, path, cwd);
  if (/^# yarn lockfile v1\s*$/m.test(text)) return classicReader(text, path, cwd);
  if (!text.trim()) throw new LockfileError(`${path} is empty.`, [path]);
  throw new LockfileError(`${path} is neither a yarn classic ("# yarn lockfile v1") nor a Berry ("__metadata:") lockfile.`, [path]);
}

export function readYarnLock(path: string, cwd: string = dirname(path)): LockfileReader {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new LockfileError(`Could not read ${path}: ${(err as Error).message}`, [path]);
  }
  return parseYarnLock(text, path, cwd);
}
