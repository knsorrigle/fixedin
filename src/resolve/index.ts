/**
 * resolve/: npm package name → GitHub owner/repo (+ monorepo directory),
 * using the `repository` field from the npm registry.
 */
import type { NetClient } from '../net/client.js';

export interface RepoRef {
  owner: string;
  repo: string;
  /** Sub-directory inside a monorepo, if the package declares one. */
  directory?: string;
}

export interface ResolvedRepo extends RepoRef {
  /** Which packument field it came from. */
  via: 'repository' | 'bugs' | 'homepage';
  raw: string;
}

export class ResolveError extends Error {
  constructor(
    readonly pkg: string,
    message: string,
    readonly tried: string[],
  ) {
    super(message);
    this.name = 'ResolveError';
  }
}

type RepositoryField = string | { type?: string; url?: string; directory?: string } | undefined;

interface PackumentVersion {
  name: string;
  version: string;
  repository?: RepositoryField;
  bugs?: string | { url?: string };
  homepage?: string;
}

export const NPM_REGISTRY = 'https://registry.npmjs.org';

export function registryUrl(pkg: string, suffix = ''): string {
  // Scoped names must keep the "@" but encode the slash.
  const encoded = pkg.startsWith('@') ? `@${encodeURIComponent(pkg.slice(1))}` : encodeURIComponent(pkg);
  return `${NPM_REGISTRY}/${encoded}${suffix}`;
}

/**
 * Parse any `repository` form npm accepts into a GitHub ref, or undefined if
 * it isn't GitHub-hosted.
 *
 *   "github:owner/repo", "owner/repo", "git+https://github.com/o/r.git",
 *   "git://github.com/o/r", "git+ssh://git@github.com/o/r.git",
 *   "git@github.com:o/r.git", "https://github.com/o/r/tree/main/packages/x",
 *   { url, directory }
 */
export function parseRepository(field: RepositoryField): RepoRef | undefined {
  if (!field) return undefined;
  const url = typeof field === 'string' ? field : field.url;
  if (!url) return undefined;
  const ref = parseGitHubUrl(url.trim());
  if (!ref) return undefined;
  const directory = typeof field === 'object' && field.directory ? normalizeDir(field.directory) : ref.directory;
  return directory ? { ...ref, directory } : { owner: ref.owner, repo: ref.repo };
}

export function parseGitHubUrl(input: string): RepoRef | undefined {
  let s = input;
  // Shorthands
  const shorthand = s.match(/^(?:github:)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:#.*)?$/);
  if (shorthand && !/^(gitlab|bitbucket|gist):/.test(s)) {
    return { owner: shorthand[1]!, repo: shorthand[2]! };
  }
  // scp-like: git@github.com:owner/repo.git
  s = s.replace(/^(?:[\w.-]+@)?github\.com:/, 'https://github.com/');
  // strip git+ prefix, normalize protocols
  s = s.replace(/^git\+/, '').replace(/^(git|ssh|http):\/\//, 'https://');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  const host = u.hostname.replace(/^www\./, '');
  if (host !== 'github.com') return undefined;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return undefined;
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/, '');
  // https://github.com/o/r/tree/<branch>/<dir…>
  let directory: string | undefined;
  if ((parts[2] === 'tree' || parts[2] === 'blob') && parts.length > 4) directory = normalizeDir(parts.slice(4).join('/'));
  return directory ? { owner, repo, directory } : { owner, repo };
}

function normalizeDir(d: string): string | undefined {
  const n = d.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  return n || undefined;
}

/** Try `repository`, then `bugs`, then `homepage` from the latest version's manifest. */
export function repoFromManifest(m: PackumentVersion): ResolvedRepo | undefined {
  const fromRepo = parseRepository(m.repository);
  if (fromRepo) return { ...fromRepo, via: 'repository', raw: rawString(m.repository) };
  const bugsUrl = typeof m.bugs === 'string' ? m.bugs : m.bugs?.url;
  const fromBugs = bugsUrl ? parseGitHubUrl(bugsUrl) : undefined;
  if (fromBugs) return { owner: fromBugs.owner, repo: fromBugs.repo, via: 'bugs', raw: bugsUrl! };
  const fromHome = m.homepage ? parseGitHubUrl(m.homepage) : undefined;
  if (fromHome) return { ...fromHome, via: 'homepage', raw: m.homepage! };
  return undefined;
}

function rawString(f: RepositoryField): string {
  return typeof f === 'string' ? f : JSON.stringify(f);
}

export async function resolveRepo(client: NetClient, pkg: string): Promise<ResolvedRepo> {
  const url = registryUrl(pkg, '/latest');
  let manifest: PackumentVersion;
  try {
    manifest = await client.getJson<PackumentVersion>(url);
  } catch (err) {
    throw new ResolveError(pkg, `Could not fetch npm metadata for ${pkg}: ${(err as Error).message}`, [url]);
  }
  const ref = repoFromManifest(manifest);
  if (!ref) {
    const seen = [
      `repository=${rawString(manifest.repository) || '(missing)'}`,
      `bugs=${JSON.stringify(manifest.bugs) ?? '(missing)'}`,
      `homepage=${manifest.homepage ?? '(missing)'}`,
    ];
    throw new ResolveError(
      pkg,
      `${pkg}@${manifest.version} has no GitHub repository in its npm metadata (${seen.join(', ')}). Pass --repo owner/name to search a repo directly.`,
      [url],
    );
  }
  return ref;
}
