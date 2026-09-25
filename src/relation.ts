/**
 * How did the copy that threw get into the project?
 *
 *   direct      the project lists it (package.json / deno.json) and it's the copy the app loads
 *   transitive  another package pulled it in — `via` are those packages, `chain` walks up
 *               to a dependency the project lists itself (e.g. wait-on@6.0.1 → axios@0.25.0)
 *   unknown     no lockfile to ask, or nothing records who depends on it
 *
 * This decides whether "upgrade to >=X" is actionable: for a transitive copy the
 * project can't simply upgrade it, only its parent (or override it).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Dependent, InstalledPackage, LockfileReader } from './lockfile/index.js';
import { stripJsonc } from './lockfile/bun.js';

export type Relation =
  | { kind: 'direct' }
  | {
      kind: 'transitive';
      /** Packages whose copy of this package is the one that threw. */
      via: Dependent[];
      /** From the first parent up to a package the project lists itself (parent first). */
      chain: Dependent[];
    }
  | { kind: 'unknown'; reason: string };

const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

/**
 * Names the project declares, from the nearest package.json and deno.json(c)
 * between cwd and the lockfile's directory (a workspace member's own manifest wins).
 */
export function declaredDependencies(cwd: string, stopAt?: string): { names: Set<string>; problems: string[] } {
  const names = new Set<string>();
  const problems: string[] = [];
  const parseJson = <T>(path: string, jsonc = false): T | undefined => {
    try {
      const text = readFileSync(path, 'utf8');
      return JSON.parse(jsonc ? stripJsonc(text) : text) as T;
    } catch (err) {
      problems.push(`Could not read ${path} to see which dependencies the project declares: ${(err as Error).message}`);
      return undefined;
    }
  };
  let dir = resolve(cwd);
  const stop = stopAt ? resolve(stopAt) : undefined;
  let foundPkg = false;
  let foundDeno = false;
  for (;;) {
    const pj = join(dir, 'package.json');
    if (!foundPkg && existsSync(pj)) {
      foundPkg = true;
      const json = parseJson<Record<string, Record<string, string> | undefined>>(pj);
      for (const f of FIELDS) for (const n of Object.keys(json?.[f] ?? {})) names.add(n);
      // An alias ("string-width-cjs": "npm:string-width@…") declares the real package too.
      for (const f of FIELDS) for (const r of Object.values(json?.[f] ?? {})) {
        const real = typeof r === 'string' ? r.match(/^npm:(@?[^@]+)@/)?.[1] : undefined;
        if (real) names.add(real);
      }
    }
    for (const file of ['deno.json', 'deno.jsonc']) {
      const dj = join(dir, file);
      if (foundDeno || !existsSync(dj)) continue;
      foundDeno = true;
      const json = parseJson<{ imports?: Record<string, string> }>(dj, true);
      for (const spec of Object.values(json?.imports ?? {})) {
        const m = typeof spec === 'string' ? spec.match(/^npm:\/?(@?[^@/]+(?:\/[^@/]+)?)/) : null;
        if (m) names.add(m[1]!);
      }
    }
    if ((foundPkg && foundDeno) || dir === stop || dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  return { names, problems };
}

/** How deep to walk up looking for a dependency the project declares. */
const MAX_CHAIN = 6;

export function relationOf(
  name: string,
  installed: InstalledPackage | undefined,
  reader: LockfileReader | undefined,
  declared: Set<string>,
): Relation {
  if (!installed) return { kind: 'unknown', reason: 'not installed' };
  // The declared, top-level copy is what `require(name)` from the app gets.
  const isAppCopy = installed.topLevel || !installed.selectedBy;
  if (declared.has(name) && isAppCopy) return { kind: 'direct' };
  if (!reader?.dependents) return { kind: 'unknown', reason: 'no lockfile records who depends on it' };

  const via = reader.dependents(name, installed.version);
  if (via.length === 0) {
    return declared.has(name)
      ? { kind: 'direct' }
      : { kind: 'unknown', reason: `nothing in ${reader.file} depends on ${name}@${installed.version}` };
  }

  // Walk up from the first parent (preferring declared ones) to something the project lists.
  const chain: Dependent[] = [];
  let current = via.find((d) => declared.has(d.name)) ?? via[0]!;
  const seen = new Set<string>();
  for (let i = 0; i < MAX_CHAIN; i++) {
    chain.push(current);
    seen.add(`${current.name}@${current.version}`);
    if (declared.has(current.name)) break;
    const up = reader.dependents(current.name, current.version).filter((d) => !seen.has(`${d.name}@${d.version}`));
    if (!up.length) break;
    current = up.find((d) => declared.has(d.name)) ?? up[0]!;
  }
  return { kind: 'transitive', via, chain };
}
