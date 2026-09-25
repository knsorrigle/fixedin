/**
 * bun.lock reader (Bun's text lockfile: JSON with trailing commas).
 * lockfileVersion 0 (Bun 1.1.39+ with --save-text-lockfile), 1 (Bun 1.2) and
 * 2 (Bun 1.3+) share the shape fixedin reads:
 *
 *   "workspaces": { "": { name, dependencies }, "packages/web": { name, dependencies } }
 *   "packages": {
 *     "axios":            ["axios@1.5.0", …],            ← hoisted copy
 *     "@mono/web/axios":  ["axios@1.1.3", …],            ← copy only packages/web sees
 *     "string-width-cjs": ["string-width@4.2.3", …],     ← npm: alias (key = folder name)
 *     "@mono/ui":         ["@mono/ui@workspace:packages/ui"],
 *   }
 *
 * Keys are install paths, so resolution mirrors Node's: for a dependency `d` of
 * workspace `N`, "N/d" wins over the hoisted "d".
 *
 * The older binary bun.lockb can't be read; the error says how to convert it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import semver from 'semver';
import type { InstalledPackage, LockfileReader } from './index.js';
import { LockfileError } from './index.js';
import { selectImporter } from './pnpm.js';

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

interface BunWorkspace {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface BunLock {
  lockfileVersion?: number;
  workspaces?: Record<string, BunWorkspace>;
  packages?: Record<string, unknown[]>;
}

/**
 * Make bun.lock valid JSON: drop trailing commas and // or /* comments, while
 * leaving string contents untouched.
 */
export function stripJsonc(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else if (ch === ',') {
      // Trailing comma: the next thing after whitespace and comments closes the container.
      const next = text[skipTrivia(text, i + 1)];
      if (next !== '}' && next !== ']') out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Index of the first character at or after `j` that isn't whitespace or a comment. */
function skipTrivia(text: string, j: number): number {
  for (;;) {
    while (j < text.length && /\s/.test(text[j]!)) j++;
    if (text.startsWith('//', j)) {
      const nl = text.indexOf('\n', j);
      j = nl === -1 ? text.length : nl + 1;
    } else if (text.startsWith('/*', j)) {
      const end = text.indexOf('*/', j + 2);
      j = end === -1 ? text.length : end + 2;
    } else {
      return j;
    }
  }
}

/** "axios@1.1.3" → { name, version }; "@mono/ui@workspace:packages/ui" → { name, workspace } */
export function parseBunIdent(ident: string): { name: string; version?: string; workspace?: string } | undefined {
  const at = ident.lastIndexOf('@');
  if (at <= 0) return undefined;
  const name = ident.slice(0, at);
  const spec = ident.slice(at + 1);
  if (spec.startsWith('workspace:')) return { name, workspace: spec.slice('workspace:'.length) };
  return { name, version: spec };
}

export function parseBunLock(text: string, path: string, cwd: string = dirname(path)): LockfileReader {
  let lock: BunLock;
  try {
    lock = JSON.parse(stripJsonc(text)) as BunLock;
  } catch (err) {
    throw new LockfileError(`Could not parse ${path}: ${(err as Error).message}`, [path]);
  }
  if (typeof lock.lockfileVersion !== 'number' || !lock.packages || !lock.workspaces) {
    throw new LockfileError(`${path} doesn't look like a bun.lock (missing lockfileVersion, workspaces or packages).`, [path]);
  }
  if (lock.lockfileVersion > 2) {
    throw new LockfileError(`${path} is bun lockfileVersion ${lock.lockfileVersion}; fixedin reads versions 0–2. Please open an issue with a sample.`, [path]);
  }

  const lockDir = dirname(path);
  const packages = lock.packages;
  const workspaces = lock.workspaces;
  // bun uses "" for the root workspace; selectImporter uses ".".
  const wsIds = Object.keys(workspaces).map((id) => (id === '' ? '.' : id));
  const wsId = selectImporter(wsIds, lockDir, cwd);
  const ws = wsId === undefined ? undefined : workspaces[wsId === '.' ? '' : wsId];

  /** Resolve an install-path key to name/version; workspace refs read their package.json. */
  const resolveKey = (key: string): { name: string; version: string; source: string; workspace: boolean } | undefined => {
    const entry = packages[key];
    const ident = Array.isArray(entry) && typeof entry[0] === 'string' ? parseBunIdent(entry[0]) : undefined;
    if (!ident) return undefined;
    if (ident.workspace !== undefined) {
      const fromLock = workspaces[ident.workspace]?.version;
      if (fromLock) return { name: ident.name, version: fromLock, source: path, workspace: true };
      const pj = join(lockDir, ident.workspace, 'package.json');
      if (!existsSync(pj)) return undefined;
      let v: string | undefined;
      try {
        v = (JSON.parse(readFileSync(pj, 'utf8')) as { version?: string }).version;
      } catch (err) {
        throw new LockfileError(`Could not read ${pj}: ${(err as Error).message}`, [path, pj]);
      }
      return v ? { name: ident.name, version: v, source: pj, workspace: true } : undefined;
    }
    return ident.version ? { name: ident.name, version: ident.version, source: path, workspace: false } : undefined;
  };

  // All copies by real package name.
  const versionsByName = new Map<string, Set<string>>();
  for (const key of Object.keys(packages)) {
    const r = resolveKey(key);
    if (!r || r.workspace) continue;
    if (!versionsByName.has(r.name)) versionsByName.set(r.name, new Set());
    versionsByName.get(r.name)!.add(r.version);
  }

  return {
    kind: 'bun',
    file: path,
    find(name) {
      let direct: InstalledPackage | undefined;
      if (ws) {
        for (const field of DEP_FIELDS) {
          for (const dep of Object.keys(ws[field] ?? {})) {
            // Workspace-local copy first ("@mono/web/axios"), then the hoisted one ("axios").
            const keys = ws.name && wsId !== '.' ? [`${ws.name}/${dep}`, dep] : [dep];
            const key = keys.find((k) => k in packages);
            const r = key ? resolveKey(key) : undefined;
            if (!r || r.name !== name) continue;
            const location = wsId === '.' ? `node_modules/${dep}` : `${wsId}/node_modules/${dep}`;
            direct = { name, version: r.version, location, topLevel: true, source: r.source };
            break;
          }
          if (direct) break;
        }
      }
      const others = [...(versionsByName.get(name) ?? [])].filter((v) => v !== direct?.version);
      others.sort((a, b) => (semver.valid(a) && semver.valid(b) ? semver.rcompare(a, b) : a.localeCompare(b)));
      return [
        ...(direct ? [direct] : []),
        ...others.map((version) => ({ name, version, location: `node_modules/${name}`, topLevel: false, source: path })),
      ];
    },
  };
}

export function readBunLock(path: string, cwd: string = dirname(path)): LockfileReader {
  if (path.endsWith('.lockb')) {
    throw new LockfileError(
      `Found ${path}, Bun's binary lockfile, which fixedin can't read. Run \`bun install --save-text-lockfile\` (Bun ≥1.1.39; the default since 1.2) to create bun.lock. Falling back to node_modules.`,
      [path],
    );
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new LockfileError(`Could not read ${path}: ${(err as Error).message}`, [path]);
  }
  return parseBunLock(text, path, cwd);
}
