/**
 * lockfile/: figure out which version of a package is actually installed.
 *
 * Implemented: package-lock.json / npm-shrinkwrap.json (lockfileVersion 2 & 3),
 *              pnpm-lock.yaml (lockfileVersion 5.x, 6.0, 9.0 — see ./pnpm.ts),
 *              yarn.lock (classic v1 and Berry v2+ — see ./yarn.ts),
 *              bun.lock (lockfileVersion 0–2 — see ./bun.ts; binary bun.lockb is detected, not read),
 *              deno.lock (versions 3–5, npm packages only — see ./deno.ts).
 * Fallback:    node_modules/<pkg>/package.json when no supported lockfile exists.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readPnpmLock } from './pnpm.js';
import { readYarnLock } from './yarn.js';
import { readBunLock } from './bun.js';
import { readDenoLock } from './deno.js';

export { readPnpmLock, parsePnpmLock } from './pnpm.js';
export { readYarnLock, parseYarnLock } from './yarn.js';
export { readBunLock, parseBunLock } from './bun.js';
export { readDenoLock, parseDenoLock } from './deno.js';

export type LockfileKind = 'package-lock' | 'pnpm' | 'yarn' | 'bun' | 'deno';

export interface InstalledPackage {
  name: string;
  version: string;
  /** Where this copy lives, e.g. "node_modules/axios" or "node_modules/foo/node_modules/axios". */
  location: string;
  /** Hoisted to the top-level node_modules (what `require('x')` from the app gets). */
  topLevel: boolean;
  /** File the version came from, relative display path. */
  source: string;
}

export interface LockfileReader {
  kind: LockfileKind;
  file: string;
  /** All installed copies of `name`, top-level first. */
  find(name: string): InstalledPackage[];
  /** Non-fatal problems found while reading (reported as diagnostics). */
  warnings?: string[];
}

export class LockfileError extends Error {
  constructor(
    message: string,
    readonly tried: string[],
  ) {
    super(message);
    this.name = 'LockfileError';
  }
}

const CANDIDATES: Array<{ file: string; kind: LockfileKind }> = [
  { file: 'package-lock.json', kind: 'package-lock' },
  { file: 'npm-shrinkwrap.json', kind: 'package-lock' },
  { file: 'pnpm-lock.yaml', kind: 'pnpm' },
  { file: 'yarn.lock', kind: 'yarn' },
  { file: 'bun.lock', kind: 'bun' },
  // Binary; detected so we can say how to convert it (bun.lock wins if both exist).
  { file: 'bun.lockb', kind: 'bun' },
  { file: 'deno.lock', kind: 'deno' },
];

export interface LocatedLockfile {
  kind: LockfileKind;
  path: string;
}

/**
 * Find the nearest lockfile, walking up from `cwd` (monorepo packages usually
 * have the lockfile at the workspace root). Returns every path checked.
 */
export function locateLockfile(cwd: string): { found?: LocatedLockfile; tried: string[] } {
  const tried: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    for (const c of CANDIDATES) {
      const p = join(dir, c.file);
      tried.push(p);
      if (existsSync(p)) return { found: { kind: c.kind, path: p }, tried };
    }
    const parent = dirname(dir);
    if (parent === dir) return { tried };
    dir = parent;
  }
}

/** `cwd` picks the workspace (which package you're running from) in pnpm, yarn, bun and deno lockfiles. */
export function openLockfile(loc: LocatedLockfile, cwd?: string): LockfileReader {
  switch (loc.kind) {
    case 'package-lock':
      return readPackageLock(loc.path);
    case 'pnpm':
      return readPnpmLock(loc.path, cwd);
    case 'yarn':
      return readYarnLock(loc.path, cwd);
    case 'bun':
      return readBunLock(loc.path, cwd);
    case 'deno':
      return readDenoLock(loc.path, cwd);
  }
}

// ---------------------------------------------------------------------------
// package-lock.json v2/v3
// ---------------------------------------------------------------------------

interface PackageLockJson {
  lockfileVersion?: number;
  packages?: Record<string, { version?: string; name?: string; link?: boolean; resolved?: string }>;
}

export function readPackageLock(path: string): LockfileReader {
  let json: PackageLockJson;
  try {
    json = JSON.parse(readFileSync(path, 'utf8')) as PackageLockJson;
  } catch (err) {
    throw new LockfileError(`Could not parse ${path}: ${(err as Error).message}`, [path]);
  }
  return parsePackageLock(json, path);
}

export function parsePackageLock(json: PackageLockJson, path: string): LockfileReader {
  const v = json.lockfileVersion;
  if (v === 1 || !json.packages) {
    throw new LockfileError(
      `${path} is lockfileVersion ${v ?? 'unknown'}; only v2/v3 are supported. Regenerate it with npm >= 7 (\`npm install --package-lock-only\`).`,
      [path],
    );
  }
  const packages = json.packages;
  return {
    kind: 'package-lock',
    file: path,
    find(name) {
      const out: InstalledPackage[] = [];
      const suffix = `node_modules/${name}`;
      for (const [location, entry] of Object.entries(packages)) {
        if (!location.endsWith(suffix)) continue;
        // Guard against "node_modules/foo-axios" matching "axios".
        const before = location.slice(0, -suffix.length);
        if (before !== '' && !before.endsWith('/')) continue;
        let version = entry.version;
        // Workspace symlink: `"node_modules/pkg": { "resolved": "packages/pkg", "link": true }`
        if (entry.link && entry.resolved) version = packages[entry.resolved]?.version;
        if (!version) continue;
        out.push({ name, version, location, topLevel: location === suffix, source: path });
      }
      return out.sort((a, b) => Number(b.topLevel) - Number(a.topLevel) || a.location.length - b.location.length);
    },
  };
}

// ---------------------------------------------------------------------------
// node_modules fallback
// ---------------------------------------------------------------------------

/**
 * Walk up from cwd looking for node_modules/<name>/package.json, like Node's
 * resolver. `root` (the lockfile's directory) caps the walk so we never pick
 * up an unrelated install from a parent directory.
 */
export function findInNodeModules(
  cwd: string,
  name: string,
  root?: string,
): { found?: InstalledPackage; tried: string[] } {
  const tried: string[] = [];
  let dir = resolve(cwd);
  const stop = root ? resolve(root) : undefined;
  for (;;) {
    const p = join(dir, 'node_modules', name, 'package.json');
    tried.push(p);
    if (existsSync(p)) {
      try {
        const pkg = JSON.parse(readFileSync(p, 'utf8')) as { version?: string };
        if (pkg.version) {
          return {
            found: { name, version: pkg.version, location: join('node_modules', name), topLevel: true, source: p },
            tried,
          };
        }
      } catch (err) {
        tried[tried.length - 1] = `${p} (unreadable: ${(err as Error).message})`;
      }
    }
    const parent = dirname(dir);
    if (parent === dir || dir === stop) return { tried };
    dir = parent;
  }
}
