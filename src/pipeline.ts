/**
 * Orchestrates the stages:
 *   detect (parse → lockfile → resolve) → search → trace → release → verdict
 */
import { detect, type DetectResult } from './detect.js';
import { resolveToken, type AuthResult } from './github/auth.js';
import { createGitHub, describeGitHubError } from './github/client.js';
import type { NetClient } from './net/client.js';
import type { InstalledPackage } from './lockfile/index.js';
import { fetchPackument, findFixRelease, type Containment, type ContainmentChecker, type ReleaseResult } from './release/index.js';
import { ResolveError, resolveRepo, type RepoRef } from './resolve/index.js';
import { canonicalizeRepo, searchRepo, type IssueMatch, type RepoSearchResult } from './search/index.js';
import { traceFix, type TraceResult } from './trace/index.js';
import { decideFixed, MATCH_THRESHOLD, pickWorkaround, type IssueComment, type Verdict } from './verdict/index.js';
import type { Diagnostics } from './diagnostics.js';
import type { GitHub } from './github/client.js';

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
  /** One per searched repo, same order as `searches`. */
  verdicts: Verdict[];
}

/** How many strong matches to trace before giving up (each costs API calls). */
const MAX_TRACED = 3;
/** Matches within this similarity of the best are treated as the same bug. */
const CONTENDER_GAP = 0.1;

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
  const verdicts: Verdict[] = [];
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

    const pkg = await linkPackage(opts.client, d, t, target, diag);
    verdicts.push(await judge(gh, opts.client, target, r, pkg, diag));
  }

  return { detect: d, auth: { source: auth.source }, searches, verdicts };
}

interface LinkedPackage {
  name: string;
  installed?: InstalledPackage;
}

/**
 * Which npm package's releases should we check for this repo? The package
 * from the trace if there is one; with --repo, try `<repo>` and `@<owner>/<repo>`
 * and accept a name only if its npm metadata points back at this repo.
 */
async function linkPackage(
  client: NetClient,
  d: DetectResult,
  t: SearchTarget,
  canonical: RepoRef,
  diag: Diagnostics,
): Promise<LinkedPackage | undefined> {
  const fromTrace = t.packages[0];
  if (fromTrace) {
    const p = d.packages.find((x) => x.candidate.name === fromTrace);
    return { name: fromTrace, ...(p?.installed ? { installed: p.installed } : {}) };
  }
  const same = (r: RepoRef) =>
    [t.repo, canonical].some((x) => `${x.owner}/${x.repo}`.toLowerCase() === `${r.owner}/${r.repo}`.toLowerCase());
  const names = [
    ...d.packages.map((p) => p.candidate.name),
    canonical.repo.toLowerCase(),
    `@${canonical.owner.toLowerCase()}/${canonical.repo.toLowerCase()}`,
  ];
  const tried: string[] = [];
  for (const name of [...new Set(names)]) {
    try {
      const r = await resolveRepo(client, name);
      if (same(r)) {
        diag.info('resolve', `Linked --repo ${canonical.owner}/${canonical.repo} to npm package ${name}.`);
        const found = d.lookupInstalled(name);
        return { name, ...(found.installed ? { installed: found.installed } : {}) };
      }
      tried.push(`${name} → ${r.owner}/${r.repo} (different repo)`);
    } catch (err) {
      if (!(err instanceof ResolveError)) throw err;
      tried.push(`${name}: ${err.message}`);
    }
  }
  diag.warn('resolve', `Could not find the npm package published from ${canonical.owner}/${canonical.repo}; release versions can't be checked.`, tried);
  return undefined;
}

async function judge(
  gh: GitHub,
  client: NetClient,
  repo: RepoRef,
  search: RepoSearchResult,
  pkg: LinkedPackage | undefined,
  diag: Diagnostics,
): Promise<Verdict> {
  const name = `${repo.owner}/${repo.repo}`;
  const base = {
    repo,
    ...(pkg ? { packageName: pkg.name } : {}),
    ...(pkg?.installed ? { installed: pkg.installed } : {}),
  };
  const strong = search.matches.filter((m) => m.similarity.score >= MATCH_THRESHOLD);
  if (strong.length === 0) {
    const best = search.matches[0];
    return {
      ...base,
      kind: 'NO_MATCH',
      advice: 'No known issue matches this error. It may be new — consider reporting it.',
      reasons: [
        best
          ? `Closest was #${best.number} at similarity ${best.similarity.score.toFixed(2)} (threshold ${MATCH_THRESHOLD}).`
          : `Search returned no issues (${search.modeUsed} search).`,
      ],
    };
  }

  // Only fall through to matches about as good as the best one: the 3rd hit
  // for "reading 'headers'" may be a different bug about "reading 'create'".
  const top = strong[0]!.similarity.score;
  const contenders = strong.filter((m) => top - m.similarity.score <= CONTENDER_GAP).slice(0, MAX_TRACED);

  let fallback: Verdict | undefined;
  for (const match of contenders) {
    if (match.state === 'open') {
      const workaround = await findWorkaround(gh, repo, match, diag);
      return {
        ...base,
        kind: 'OPEN_ISSUE',
        match,
        ...(workaround ? { workaround } : {}),
        advice: workaround
          ? 'Known open issue — no fix yet. Try the workaround above from the thread.'
          : 'Known open issue — no fix yet. Subscribe to the issue for updates.',
        reasons: [`#${match.number} is open.`],
      };
    }
    if (match.stateReason === 'not_planned') {
      fallback ??= { ...base, kind: 'CLOSED_NO_FIX_FOUND', match, advice: `Closed as not planned — upstream won't fix this. Read the thread for the recommended approach.`, reasons: [`#${match.number} was closed as not planned.`] };
      continue;
    }

    if (!gh.authenticated) {
      // GraphQL rejects every unauthenticated call; don't burn requests on it.
      const why = 'tracing the fix uses the GraphQL API, which requires a GitHub token';
      diag.warn('trace', `Skipped tracing ${name}#${match.number}: ${why}. Set GITHUB_TOKEN or run \`gh auth login\`.`);
      return { ...base, kind: 'CLOSED_NO_FIX_FOUND', match, advice: `#${match.number} is closed, but the fix can't be traced without a GitHub token. Read the issue.`, reasons: [why] };
    }

    let trace: TraceResult;
    try {
      trace = await traceFix(gh, repo, match.number);
    } catch (err) {
      const why = describeGitHubError(err).message;
      diag.warn('trace', `Could not read the timeline of ${name}#${match.number}: ${why}`);
      fallback ??= { ...base, kind: 'CLOSED_NO_FIX_FOUND', match, advice: `Closed, but the fix could not be traced (${why}). Read the issue.`, reasons: [why] };
      continue;
    }
    for (const n of trace.notes) diag.info('trace', `${name}#${match.number}: ${n}`);
    if (!trace.fix) {
      fallback ??= {
        ...base,
        kind: 'CLOSED_NO_FIX_FOUND',
        match,
        advice: 'Closed without a linked fix (maybe closed manually or as stale). Read the thread for how it was resolved.',
        reasons: trace.notes,
      };
      continue;
    }

    let release: (ReleaseResult & { checker: ContainmentChecker }) | undefined;
    let installedProbe: Containment | undefined;
    if (pkg) {
      try {
        const packument = await fetchPackument(client, pkg.name);
        const installedVersion = pkg.installed?.version;
        const major = installedVersion ? semverMajor(installedVersion) : undefined;
        release = await findFixRelease(gh, repo, packument, trace.fix.sha, {
          ...(trace.fix.mergedAt ? { mergedAt: trace.fix.mergedAt } : {}),
          ...(major !== undefined ? { floor: `${major}.0.0` } : {}),
        });
        for (const n of release.notes) diag.info('release', `${pkg.name}: ${n}`);
        diag.info('release', `${pkg.name}: ${release.probes.length} compare probe(s) over ${release.considered} candidate release(s): ${release.probes.map((p) => `${p.version}=${p.result}`).join(', ')}`);
        if (installedVersion && packument.versions[installedVersion]) {
          installedProbe = (await release.checker.check(installedVersion)).result;
        }
      } catch (err) {
        diag.warn('release', `Could not determine which ${pkg.name} release contains ${trace.fix.sha.slice(0, 7)}: ${(err as Error).message}`);
      }
    }
    const v = decideFixed({
      repo,
      ...(pkg ? { packageName: pkg.name } : {}),
      ...(pkg?.installed ? { installed: pkg.installed } : {}),
      match,
      trace,
      fix: trace.fix,
      ...(release ? { release } : {}),
      ...(installedProbe ? { installedProbe } : {}),
    });
    if (trace.duplicateOf) v.reasons.unshift(`#${match.number} was closed as a duplicate of #${trace.duplicateOf}.`);
    return v;
  }
  return fallback!;
}

function semverMajor(v: string): number | undefined {
  const m = v.match(/^(\d+)\./);
  return m ? Number(m[1]) : undefined;
}

async function findWorkaround(gh: GitHub, repo: RepoRef, match: IssueMatch, diag: Diagnostics) {
  try {
    const res = await gh.rest.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      owner: repo.owner,
      repo: repo.repo,
      issue_number: match.number,
      per_page: 100,
    });
    const comments = res.data as unknown as IssueComment[];
    if (match.comments > comments.length) diag.info('trace', `#${match.number}: only the first ${comments.length} of ${match.comments} comments were scanned for workarounds.`);
    return pickWorkaround(comments);
  } catch (err) {
    diag.warn('trace', `Could not read comments on #${match.number}: ${describeGitHubError(err).message}`);
    return undefined;
  }
}
