/**
 * Orchestrates the stages: detect (parse → lockfile → resolve) → search.
 * Later milestones add trace → release → verdict here.
 */
import { detect, type DetectResult } from './detect.js';
import { resolveToken, type AuthResult } from './github/auth.js';
import { createGitHub, describeGitHubError } from './github/client.js';
import type { NetClient } from './net/client.js';
import type { RepoRef } from './resolve/index.js';
import { canonicalizeRepo, searchRepo, type RepoSearchResult } from './search/index.js';

export interface RunOptions {
  cwd: string;
  client: NetClient;
  repo?: string;
  limit: number;
  /** Max distinct repos to search (hybrid search is limited to 10 req/min). */
  maxRepos?: number;
  /** Injected in tests; defaults to GITHUB_TOKEN → gh auth token. */
  auth?: AuthResult;
}

export interface SearchTarget {
  repo: RepoRef;
  /** Package(s) from the trace that map to this repo; empty with --repo. */
  packages: string[];
}

export interface RunResult {
  detect: DetectResult;
  auth: Pick<AuthResult, 'source'>;
  searches: Array<RepoSearchResult & { packages: string[] }>;
}

/** Unique repos in trace order; low-signal packages (jest etc.) only if nothing else. */
export function chooseTargets(d: DetectResult, maxRepos: number): SearchTarget[] {
  if (d.explicitRepo) {
    const want = `${d.explicitRepo.owner}/${d.explicitRepo.repo}`.toLowerCase();
    const pkgs = d.packages.filter((p) => p.repo && `${p.repo.owner}/${p.repo.repo}`.toLowerCase() === want);
    return [{ repo: d.explicitRepo, packages: pkgs.map((p) => p.candidate.name) }];
  }
  const withRepo = d.packages.filter((p) => p.repo);
  const preferred = withRepo.some((p) => !p.candidate.lowSignal) ? withRepo.filter((p) => !p.candidate.lowSignal) : withRepo;
  const byRepo = new Map<string, SearchTarget>();
  for (const p of preferred) {
    const key = `${p.repo!.owner}/${p.repo!.repo}`.toLowerCase();
    const t = byRepo.get(key);
    if (t) t.packages.push(p.candidate.name);
    else {
      const { owner, repo, directory } = p.repo!;
      byRepo.set(key, { repo: { owner, repo, ...(directory ? { directory } : {}) }, packages: [p.candidate.name] });
    }
  }
  return [...byRepo.values()].slice(0, maxRepos);
}

export async function run(input: string, opts: RunOptions): Promise<RunResult> {
  const d = await detect(input, { cwd: opts.cwd, client: opts.client, ...(opts.repo ? { repo: opts.repo } : {}) });
  const diag = d.diagnostics;

  const auth = opts.auth ?? (await resolveToken());
  if (!auth.token) {
    diag.warn(
      'auth',
      'No GitHub token found, running unauthenticated: hybrid (semantic) issue search is unavailable, so results come from lexical search only, and rate limits are much lower. Set GITHUB_TOKEN or run `gh auth login`.',
      auth.tried,
    );
  } else {
    diag.info('auth', `Using GitHub token from ${auth.source}.`);
  }
  const gh = createGitHub(opts.client, auth.token);

  const maxRepos = opts.maxRepos ?? 3;
  const targets = chooseTargets(d, maxRepos);
  const allRepos = new Set(d.packages.filter((p) => p.repo).map((p) => `${p.repo!.owner}/${p.repo!.repo}`));
  if (!d.explicitRepo && allRepos.size > targets.length) {
    diag.info('search', `Searching ${targets.length} of ${allRepos.size} repos; use --repo to pick a specific one.`);
  }
  if (targets.length === 0 && !d.explicitRepo) {
    diag.error('search', 'Nothing to search: no package in the error could be mapped to a GitHub repo. Pass --repo owner/name.');
  }

  const searches: RunResult['searches'] = [];
  // Sequential on purpose: search endpoints have tight per-minute limits.
  for (const t of targets) {
    let target = t.repo;
    try {
      const c = await canonicalizeRepo(gh, t.repo);
      if (c.renamedFrom) diag.info('resolve', `${c.renamedFrom} was renamed to ${c.repo.owner}/${c.repo.repo}; searching the new name.`);
      if (!c.hasIssues) {
        diag.warn('search', `${c.repo.owner}/${c.repo.repo} has GitHub issues disabled; skipping it.`);
        continue;
      }
      target = c.repo;
    } catch (err) {
      const { status, message } = describeGitHubError(err);
      if (status === 404) {
        diag.error('resolve', `GitHub repo ${t.repo.owner}/${t.repo.repo} (from npm metadata of ${t.packages.join(', ')}) does not exist or is private.`, [
          `GET /repos/${t.repo.owner}/${t.repo.repo}`,
        ]);
        continue;
      }
      // Not fatal: search may still work with the original name.
      diag.warn('resolve', `Could not check the canonical name of ${t.repo.owner}/${t.repo.repo}: ${message}`);
    }
    const r = await searchRepo(gh, target, d.parsed, { limit: opts.limit });
    const name = `${target.owner}/${target.repo}`;
    for (const a of r.attempts) {
      if (a.error) diag.warn('search', `${a.requested} search in ${name} failed: ${a.error}`, [a.q]);
      if (a.fallbackReasons) {
        diag.info('search', `GitHub ran ${a.requested} search in ${name} as ${a.used} (${a.fallbackReasons.join(', ')}).`, [a.q]);
      }
    }
    if (r.modeUsed === 'none') diag.error('search', `Every search in ${name} failed.`, r.attempts.map((a) => a.q));
    else diag.info('search', `${name}: ${r.modeUsed} search, ${r.totalCount} results.`, r.attempts.map((a) => `${a.requested}: ${a.q}`));
    if (r.rateLimit) {
      diag.info('net', `GitHub ${r.rateLimit.resource} quota: ${r.rateLimit.remaining}/${r.rateLimit.limit} left, resets ${r.rateLimit.resetAt}.`);
    }
    searches.push({ ...r, packages: t.packages });
  }

  return { detect: d, auth: { source: auth.source }, searches };
}
