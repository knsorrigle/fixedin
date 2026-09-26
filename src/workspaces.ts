/**
 * A monorepo's workspace packages, and which one a log label names, so each
 * error's versions come from the package that produced it rather than the root.
 *
 * Declared in:
 *   package.json         "workspaces": ["apps/*"]  or  { "packages": [...] }   (npm, yarn, bun)
 *   pnpm-workspace.yaml  packages: ["apps/*"]
 *   deno.json(c)         "workspace": ["./apps/web"]
 * Patterns are paths with "*" and "**" segments; "!pattern" excludes.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PrefixScheme } from './parse/demux.js';

export interface WorkspacePackage {
  /** From its package.json / deno.json; undefined when it has none. */
  name?: string;
  /** Relative to the workspace root, "/"-separated: "apps/web". */
  dir: string;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function patternsAt(root: string): string[] {
  const pkg = readJson(join(root, 'package.json'));
  const ws = pkg?.workspaces;
  const out = [...strings(ws), ...strings((ws as { packages?: unknown } | undefined)?.packages)];
  const pnpm = join(root, 'pnpm-workspace.yaml');
  if (existsSync(pnpm)) out.push(...pnpmPackages(readFileSync(pnpm, 'utf8')));
  for (const f of ['deno.json', 'deno.jsonc']) out.push(...strings(readJson(join(root, f))?.workspace));
  return out.map((p) => p.replace(/^\.\//, '').replace(/\/+$/, ''));
}

/** The `packages:` list of pnpm-workspace.yaml — `- "apps/*"` items, quoted or not. */
export function pnpmPackages(yaml: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^\S/.test(line)) inPackages = /^packages:\s*(#.*)?$/.test(line);
    else if (inPackages) {
      const m = line.match(/^\s+-\s+(['"]?)([^'"#]+?)\1\s*(#.*)?$/);
      if (m) out.push(m[2]!);
    }
  }
  return out;
}

const SKIP = new Set(['node_modules', '.git']);

/** Directories under `root` matching a pattern's segments ("apps/*", "packages/**"). */
function expand(root: string, segments: string[], at = ''): string[] {
  if (!segments.length) return [at];
  const [seg, ...rest] = segments;
  const here = join(root, at);
  const subdirs = () => {
    try {
      return readdirSync(here).filter((d) => !SKIP.has(d) && statSync(join(here, d)).isDirectory());
    } catch {
      return [];
    }
  };
  const next = (d: string) => (at ? `${at}/${d}` : d);
  if (seg === '**') return [...expand(root, rest, at), ...subdirs().flatMap((d) => expand(root, segments, next(d)))];
  if (seg!.includes('*')) {
    const re = new RegExp(`^${seg!.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
    return subdirs().filter((d) => re.test(d)).flatMap((d) => expand(root, rest, next(d)));
  }
  return existsSync(join(here, seg!)) ? expand(root, rest, next(seg!)) : [];
}

export function listWorkspaces(root: string): WorkspacePackage[] {
  const patterns = patternsAt(root);
  const include = patterns.filter((p) => !p.startsWith('!'));
  const exclude = new Set(patterns.filter((p) => p.startsWith('!')).flatMap((p) => expand(root, p.slice(1).split('/'))));
  const dirs = [...new Set(include.flatMap((p) => expand(root, p.split('/'))))].filter((d) => d && !exclude.has(d));
  return dirs
    .map((dir) => {
      const manifest = readJson(join(root, dir, 'package.json')) ?? readJson(join(root, dir, 'deno.json')) ?? readJson(join(root, dir, 'deno.jsonc'));
      if (!manifest) return undefined;
      return { dir, ...(typeof manifest.name === 'string' ? { name: manifest.name } : {}) };
    })
    .filter((w): w is WorkspacePackage => w !== undefined)
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * The workspace package a log label names:
 *   turbo         "@shop/web:test"  → the package named @shop/web
 *   pnpm          "apps/web test"   → the package in apps/web
 *   compose       "api-1"           → a package named "api" (or @scope/api, or in a folder named api), if exactly one
 *   concurrently  "api"             → the same
 */
export function workspaceForLabel(label: string, scheme: PrefixScheme, workspaces: WorkspacePackage[]): WorkspacePackage | undefined {
  if (scheme === 'turbo') {
    // Package names can't contain ":", so the package ends at the first one.
    const name = label.slice(0, label.indexOf(':'));
    return workspaces.find((w) => w.name === name);
  }
  if (scheme === 'pnpm') {
    const dir = label.slice(0, label.lastIndexOf(' ')).replace(/^\.\//, '');
    return workspaces.find((w) => w.dir === dir);
  }
  const base = label.replace(/[-_]\d+$/, '').toLowerCase();
  const hits = workspaces.filter((w) => {
    const n = w.name?.toLowerCase();
    return n === base || n?.endsWith(`/${base}`) || w.dir.toLowerCase().split('/').at(-1) === base;
  });
  return hits.length === 1 ? hits[0] : undefined;
}
