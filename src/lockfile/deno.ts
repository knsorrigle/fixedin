/**
 * deno.lock reader — npm and JSR packages (https: imports have no version to
 * compare). Plain JSON. JSR packages are named "jsr:@scope/name" (see src/jsr.ts).
 *
 *   version "3" (Deno 1.4x):  packages.specifiers { "npm:axios@1.1.3": "npm:axios@1.1.3" }, packages.npm { … }, packages.jsr { … }
 *   version "4" (Deno 2.0–2.2), "5" (Deno 2.3+):
 *                             specifiers { "npm:axios@1.1.3": "1.1.3", "jsr:@hono/hono@^4": "4.5.1" },
 *                             npm { "axios@1.1.3": … }, jsr { "@hono/hono@4.5.1": … }
 *
 * Resolved versions may carry a peer suffix: "18.2.0_react@18.2.0".
 * Direct dependencies are specifiers listed under `workspace` (deno.json
 * imports) and `workspace.packageJson` (package.json), and per member under
 * `workspace.members["packages/web"]` for Deno 2 workspaces.
 */
import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import semver from 'semver';
import type { Dependent, InstalledPackage, LockfileReader } from './index.js';
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
  jsr?: Record<string, unknown>;
  packages?: { specifiers?: Record<string, string>; npm?: Record<string, unknown>; jsr?: Record<string, unknown> };
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
  if (value.startsWith('npm:') || value.startsWith('jsr:')) {
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
  const jsr = (v === 3 ? lock.packages?.jsr : lock.jsr) ?? {};

  // All locked copies: npm by name, JSR as "jsr:@scope/name".
  const versionsByName = new Map<string, Set<string>>();
  for (const [section, prefix] of [[npm, ''], [jsr, 'jsr:']] as const) {
    for (const key of Object.keys(section)) {
      const p = splitNameAt(key);
      if (!p) continue;
      const name = `${prefix}${p.name}`;
      if (!versionsByName.has(name)) versionsByName.set(name, new Set());
      versionsByName.get(name)!.add(stripDenoPeers(p.rest));
    }
  }

  // Which dependency lists apply to cwd: the root, or a Deno 2 workspace member.
  const ws = lock.workspace ?? {};
  const members = ws.members ?? {};
  const lockDir = dirname(path);
  const memberId = selectImporter(['.', ...Object.keys(members)], lockDir, cwd);
  const lists: DepLists = memberId && memberId !== '.' ? members[memberId]! : ws;
  const direct = [...(lists.dependencies ?? []), ...(lists.packageJson?.dependencies ?? [])].filter((s) => s.startsWith('npm:') || s.startsWith('jsr:'));

  return {
    kind: 'deno',
    file: path,
    find(name) {
      const isJsr = name.startsWith('jsr:');
      const bare = isJsr ? name.slice(4) : name;
      // JSR packages have no install folder; name the locked copy instead.
      const where = (version: string, member?: string) =>
        isJsr ? `jsr:${bare}@${version}` : member ? `${member}/node_modules/${name}` : `node_modules/${name}`;
      let top: InstalledPackage | undefined;
      for (const spec of direct) {
        if (spec.startsWith('jsr:') !== isJsr) continue;
        const parsed = splitNameAt(spec.slice(4));
        const value = specifiers[spec];
        if (!parsed || value === undefined) continue;
        const r = resolveSpecifierValue(parsed.name, value);
        if (!r || r.name !== bare) continue;
        top = { name, version: r.version, location: where(r.version, memberId && memberId !== '.' ? memberId : undefined), topLevel: true, source: path };
        break;
      }
      const others = [...(versionsByName.get(name) ?? [])].filter((x) => x !== top?.version);
      others.sort((a, b) => (semver.valid(a) && semver.valid(b) ? semver.rcompare(a, b) : a.localeCompare(b)));
      return [
        ...(top ? [top] : []),
        ...others.map((version) => ({ name, version, location: where(version), topLevel: false, source: path })),
      ];
    },
    dependents(name, version) {
      const out: Dependent[] = [];
      // Only npm packages record who depends on them in a form fixedin reads.
      if (name.startsWith('jsr:')) return out;
      for (const [key, value] of Object.entries(npm)) {
        const self = splitNameAt(key);
        const raw = (value as { dependencies?: string[] | Record<string, string> } | null)?.dependencies;
        if (!self || !raw) continue;
        // v3: { dep: "dep@1.2.3_peer@4" }; v4/v5: ["dep", …] or ["dep@1.2.3", …] when ambiguous.
        const refs = Array.isArray(raw) ? raw : Object.values(raw);
        const hit = refs.some((ref) => {
          const p = splitNameAt(ref);
          if (p) return p.name === name && stripDenoPeers(p.rest) === version;
          // Bare name: only unambiguous when a single version is locked.
          const vs = versionsByName.get(ref);
          return ref === name && vs?.size === 1 && vs.has(version);
        });
        const selfVersion = stripDenoPeers(self.rest);
        if (hit && !out.some((d) => d.name === self.name && d.version === selfVersion)) out.push({ name: self.name, version: selfVersion });
      }
      return out;
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
