/**
 * pnpm-lock.yaml reader for the three formats in the wild:
 *
 *   lockfileVersion 5.x  (pnpm 7)    dependencies: { axios: 1.1.3, react-dom: 18.2.0_react@18.2.0 }
 *                                    packages:     /@scope/name/1.0.0_peers
 *   lockfileVersion 6.0  (pnpm 8)    dependencies: { axios: { specifier, version: 18.2.0(react@18.2.0) } }
 *                                    packages:     /@scope/name@1.0.0(peers)
 *   lockfileVersion 9.0  (pnpm 9+)   importers: { '.': { dependencies: … } }
 *                                    packages:     '@scope/name@1.0.0'   snapshots: '…@1.0.0(peers)'
 *
 * Workspaces list one importer per package ('.', 'packages/web', …). The
 * importer matching --cwd decides what the app actually loads, so its direct
 * dependencies are reported as top-level.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import semver from 'semver';
import type { Dependent, InstalledPackage, LockfileReader } from './index.js';
import { LockfileError } from './index.js';
import { parseYamlSubset, splitDocuments, YamlSubsetError, type YamlMap, type YamlValue } from './yaml.js';

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

export interface PnpmRef {
  name: string;
  version: string;
}

/** "18.2.0(react@18.2.0)" / "18.2.0_react@18.2.0" → "18.2.0" */
export function stripPeerSuffix(v: string, major: number): string {
  if (major >= 6) {
    const i = v.indexOf('(');
    return i === -1 ? v : v.slice(0, i);
  }
  const i = v.indexOf('_');
  return i === -1 ? v : v.slice(0, i);
}

/**
 * Parse a `packages:`/`snapshots:` key into name + version.
 *   v5: /@tanstack/react-query/5.0.0_hash     v6: /@tanstack/react-query@5.0.0(peers)     v9: @tanstack/react-query@5.0.0
 */
export function parsePackageKey(key: string, major: number): PnpmRef | undefined {
  const k = key.startsWith('/') ? key.slice(1) : key;
  if (major < 6) {
    const parts = k.split('/');
    const last = parts.pop();
    if (!last || parts.length === 0) return undefined;
    return { name: parts.join('/'), version: stripPeerSuffix(last, major) };
  }
  const bare = stripPeerSuffix(k, major);
  const at = bare.lastIndexOf('@');
  if (at <= 0) return undefined;
  return { name: bare.slice(0, at), version: bare.slice(at + 1) };
}

/**
 * Resolve an importer dependency's `version` field. It may be a plain version
 * (with peer suffix), a workspace link, or an `npm:` alias that points at a
 * differently named package.
 */
export function resolveDepVersion(
  depName: string,
  raw: string,
  major: number,
): { kind: 'version'; ref: PnpmRef } | { kind: 'link'; path: string } | { kind: 'other'; raw: string } {
  if (raw.startsWith('link:')) return { kind: 'link', path: raw.slice(5) };
  if (/^(file:|https?:|git[+:]|github:)/.test(raw)) return { kind: 'other', raw };
  // Alias: v5 "/string-width/4.2.3", v6 "/string-width@4.2.3", v9 "string-width@4.2.3"
  if (raw.startsWith('/')) {
    const ref = parsePackageKey(raw, major);
    return ref ? { kind: 'version', ref } : { kind: 'other', raw };
  }
  const bare = stripPeerSuffix(raw, major);
  const at = bare.lastIndexOf('@');
  if (at > 0) return { kind: 'version', ref: { name: bare.slice(0, at), version: bare.slice(at + 1) } };
  return { kind: 'version', ref: { name: depName, version: bare } };
}

function asMap(v: YamlValue | undefined): YamlMap | undefined {
  return v && typeof v === 'object' ? v : undefined;
}

/** The main lockfile document (pnpm ≥9.7 may prepend a config-dependencies document). */
function mainDocument(text: string, path: string): YamlMap {
  const docs = splitDocuments(text);
  let parsed: YamlMap[];
  try {
    parsed = docs.map((d) => parseYamlSubset(d));
  } catch (err) {
    const why = err instanceof YamlSubsetError ? err.message : (err as Error).message;
    throw new LockfileError(`Could not parse ${path}: ${why}`, [path]);
  }
  const main = [...parsed].reverse().find((d) => d.importers || d.packages || d.dependencies || d.devDependencies);
  if (!main) throw new LockfileError(`${path} has no importers, dependencies or packages section.`, [path]);
  return main;
}

export function lockfileMajor(doc: YamlMap, path: string): number {
  const v = doc.lockfileVersion;
  const n = typeof v === 'string' ? Number.parseFloat(v) : Number.NaN;
  if (!Number.isFinite(n)) throw new LockfileError(`${path} has no readable lockfileVersion.`, [path]);
  if (n < 5 || n >= 10) {
    throw new LockfileError(`${path} is lockfileVersion ${v}; supported pnpm lockfile versions are 5.x, 6.0 and 9.0.`, [path]);
  }
  return Math.floor(n);
}

/** Importer id for cwd: '.', 'packages/web', … — the deepest importer containing cwd. */
export function selectImporter(importerIds: string[], lockDir: string, cwd: string): string | undefined {
  const rel = relative(resolve(lockDir), resolve(cwd)).split(/[\\/]/).filter(Boolean).join('/');
  const depth = (id: string) => (id === '.' ? 0 : id.length + 1);
  const inside = importerIds.filter((id) => id === '.' || rel === id || rel.startsWith(`${id}/`));
  return inside.sort((a, b) => depth(b) - depth(a))[0];
}

export function readPnpmLock(path: string, cwd: string = dirname(path)): LockfileReader {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new LockfileError(`Could not read ${path}: ${(err as Error).message}`, [path]);
  }
  return parsePnpmLock(text, path, cwd);
}

export function parsePnpmLock(text: string, path: string, cwd: string = dirname(path)): LockfileReader {
  const doc = mainDocument(text, path);
  const major = lockfileMajor(doc, path);
  const lockDir = dirname(path);

  // Importers: v9 always, v5/v6 only for workspaces. A single-project v5/v6
  // lockfile keeps its dependencies at the top level (importer '.').
  const importers: Record<string, YamlMap> = {};
  const importersMap = asMap(doc.importers);
  if (importersMap) {
    for (const [id, v] of Object.entries(importersMap)) {
      const m = asMap(v);
      if (m) importers[id] = m;
    }
  } else {
    importers['.'] = doc;
  }
  const importerId = selectImporter(Object.keys(importers), lockDir, cwd);

  // name → version → true for everything in packages/snapshots.
  const all = new Map<string, Set<string>>();
  for (const section of ['packages', 'snapshots'] as const) {
    for (const key of Object.keys(asMap(doc[section]) ?? {})) {
      const ref = parsePackageKey(key, major);
      if (!ref) continue;
      if (!all.has(ref.name)) all.set(ref.name, new Set());
      all.get(ref.name)!.add(ref.version);
    }
  }

  const directOf = (id: string, name: string): InstalledPackage | undefined => {
    const imp = importers[id];
    if (!imp) return undefined;
    for (const field of DEP_FIELDS) {
      const deps = asMap(imp[field]);
      if (!deps) continue;
      for (const [depName, value] of Object.entries(deps)) {
        // v5: "1.2.3"; v6/v9: { specifier, version }
        const raw = typeof value === 'string' ? value : asMap(value)?.version;
        if (typeof raw !== 'string' || !raw) continue;
        const r = resolveDepVersion(depName, raw, major);
        const location = id === '.' ? `node_modules/${depName}` : `${id}/node_modules/${depName}`;
        if (r.kind === 'version' && r.ref.name === name) {
          return { name, version: r.ref.version, location, topLevel: true, source: path };
        }
        if (r.kind === 'link' && depName === name) {
          // Workspace package: its version lives in its own package.json.
          const pkgJson = join(lockDir, id, r.path, 'package.json');
          const version = existsSync(pkgJson) ? (JSON.parse(readFileSync(pkgJson, 'utf8')) as { version?: string }).version : undefined;
          if (version) return { name, version, location, topLevel: true, source: pkgJson };
        }
      }
    }
    return undefined;
  };

  return {
    kind: 'pnpm',
    file: path,
    find(name) {
      const out: InstalledPackage[] = [];
      const direct = importerId ? directOf(importerId, name) : undefined;
      if (direct) out.push(direct);
      // Every other resolved copy, newest first, as non-top-level.
      const versions = [...(all.get(name) ?? [])].filter((v) => v !== direct?.version);
      versions.sort((a, b) => (semver.valid(a) && semver.valid(b) ? semver.rcompare(a, b) : a.localeCompare(b)));
      for (const version of versions) {
        out.push({ name, version, location: `node_modules/.pnpm/${name.replace('/', '+')}@${version}/node_modules/${name}`, topLevel: false, source: path });
      }
      return out;
    },
    dependents(name, version) {
      // v9 keeps each copy's dependencies under `snapshots`; v5/v6 under `packages`.
      // Values are exact resolved versions (with peer suffixes), so no range here.
      const section = asMap(doc[major >= 9 ? 'snapshots' : 'packages']) ?? {};
      const out: Dependent[] = [];
      for (const [key, value] of Object.entries(section)) {
        const self = parsePackageKey(key, major);
        const entry = asMap(value);
        if (!self || !entry) continue;
        const deps = { ...asMap(entry.optionalDependencies), ...asMap(entry.dependencies) };
        const hit = Object.entries(deps).some(([dep, raw]) => {
          if (typeof raw !== 'string') return false;
          const r = resolveDepVersion(dep, raw, major);
          return r.kind === 'version' && r.ref.name === name && r.ref.version === version;
        });
        if (hit && !out.some((d) => d.name === self.name && d.version === self.version)) out.push({ name: self.name, version: self.version });
      }
      return out;
    },
  };
}
