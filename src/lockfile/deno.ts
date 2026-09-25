/**
 * deno.lock reader — only the npm packages in it (jsr:/https: imports have no
 * npm version to compare). Plain JSON.
 *
 *   version "3" (Deno 1.4x):  packages.specifiers { "npm:axios@1.1.3": "npm:axios@1.1.3" }, packages.npm { … }
 *   version "4" (Deno 2.0–2.2), "5" (Deno 2.3+):
 *                             specifiers { "npm:axios@1.1.3": "1.1.3" },               npm { "axios@1.1.3": … }
 *
 * Resolved versions may carry a peer suffix: "18.2.0_react@18.2.0".
 * Direct dependencies are specifiers listed under `workspace` (deno.json
 * imports) and `workspace.packageJson` (package.json), and per member under
 * `workspace.members["packages/web"]` for Deno 2 workspaces.
 */
import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import semver from 'semver';
import type { InstalledPackage, LockfileReader } from './index.js';
import { LockfileError } from './index.js';
import { selectImporter } from './pnpm.js';

interface DepLists {
  dependencies?: string[];
  packageJson?: { dependencies?: string[] };
}

interface DenoLock {
  version?: string;
  specifiers?: Record<string, string>;
  npm?: Record<string, unknown>;
  packages?: { specifiers?: Record<string, string>; npm?: Record<string, unknown> };
  workspace?: DepLists & { members?: Record<string, DepLists> };
}

/** "@scope/pkg@^1.0.0" → { name, rest: "^1.0.0" } (split at the first @ after a scope). */
export function splitNameAt(s: string): { name: string; rest: string } | undefined {
  const at = s.indexOf('@', s.startsWith('@') ? 1 : 0);
  if (at <= 0) return undefined;
  return { name: s.slice(0, at), rest: s.slice(at + 1) };
}

/** "18.2.0_react@18.2.0" → "18.2.0" */
export function stripDenoPeers(v: string): string {
  const i = v.indexOf('_');
  return i === -1 ? v : v.slice(0, i);
}

/**
 * Resolve a specifier-map value to name + version.
 *   v3:    "npm:@tanstack/react-query@5.0.0_react@18.2.0"
 *   v4/v5: "5.0.0_react@18.2.0" (name comes from the key)
 */
export function resolveSpecifierValue(keyName: string, value: string): { name: string; version: string } | undefined {
  if (value.startsWith('npm:')) {
    const p = splitNameAt(value.slice(4));
    return p ? { name: p.name, version: stripDenoPeers(p.rest) } : undefined;
  }
  return { name: keyName, version: stripDenoPeers(value) };
}

export function parseDenoLock(text: string, path: string, cwd: string = dirname(path)): LockfileReader {
  let lock: DenoLock;
  try {
    lock = JSON.parse(text) as DenoLock;
  } catch (err) {
    throw new LockfileError(`Could not parse ${path}: ${(err as Error).message}`, [path]);
  }
  const v = Number(lock.version);
  if (!Number.isInteger(v)) throw new LockfileError(`${path} has no readable "version".`, [path]);
  if (v < 3) {
    throw new LockfileError(`${path} is deno.lock version ${lock.version}; fixedin reads versions 3–5. Running any Deno ≥1.40 command in the project upgrades it.`, [path]);
  }
  if (v > 5) {
    throw new LockfileError(`${path} is deno.lock version ${lock.version}; fixedin reads versions 3–5. Please open an issue with a sample.`, [path]);
  }

  const specifiers = (v === 3 ? lock.packages?.specifiers : lock.specifiers) ?? {};
  const npm = (v === 3 ? lock.packages?.npm : lock.npm) ?? {};

  // All locked npm copies.
  const versionsByName = new Map<string, Set<string>>();
  for (const key of Object.keys(npm)) {
    const p = splitNameAt(key);
    if (!p) continue;
    if (!versionsByName.has(p.name)) versionsByName.set(p.name, new Set());
    versionsByName.get(p.name)!.add(stripDenoPeers(p.rest));
  }

  // Which dependency lists apply to cwd: the root, or a Deno 2 workspace member.
  const ws = lock.workspace ?? {};
  const members = ws.members ?? {};
  const lockDir = dirname(path);
  const memberId = selectImporter(['.', ...Object.keys(members)], lockDir, cwd);
  const lists: DepLists = memberId && memberId !== '.' ? members[memberId]! : ws;
  const direct = [...(lists.dependencies ?? []), ...(lists.packageJson?.dependencies ?? [])].filter((s) => s.startsWith('npm:'));

  return {
    kind: 'deno',
    file: path,
    find(name) {
      let top: InstalledPackage | undefined;
      for (const spec of direct) {
        const parsed = splitNameAt(spec.slice(4));
        const value = specifiers[spec];
        if (!parsed || value === undefined) continue;
        const r = resolveSpecifierValue(parsed.name, value);
        if (!r || r.name !== name) continue;
        const location = memberId && memberId !== '.' ? `${memberId}/node_modules/${name}` : `node_modules/${name}`;
        top = { name, version: r.version, location, topLevel: true, source: path };
        break;
      }
      const others = [...(versionsByName.get(name) ?? [])].filter((x) => x !== top?.version);
      others.sort((a, b) => (semver.valid(a) && semver.valid(b) ? semver.rcompare(a, b) : a.localeCompare(b)));
      return [
        ...(top ? [top] : []),
        ...others.map((version) => ({ name, version, location: `node_modules/${name}`, topLevel: false, source: path })),
      ];
    },
  };
}

export function readDenoLock(path: string, cwd: string = dirname(path)): LockfileReader {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new LockfileError(`Could not read ${path}: ${(err as Error).message}`, [path]);
  }
  return parseDenoLock(text, path, cwd);
}
