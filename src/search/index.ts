/**
 * search/: find issues in a repo that match the error.
 *
 * Uses GET /search/issues with `search_type=hybrid` (semantic + lexical),
 * documented at https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests.
 * Observed behaviour this module is built around:
 *   - hybrid requires auth; unauthenticated calls get 401
 *     "Semantic search requires authentication".
 *   - hybrid has its own rate-limit bucket (x-ratelimit-resource: semantic_search, 10/min).
 *   - the response's `search_type` says which mode actually ran; GitHub silently
 *     degrades to lexical for some queries (double quotes, OR/NOT) and lists why
 *     in `lexical_fallback_reason`.
 *   - every hit has score=1, so we rank with our own similarity (./similarity.ts).
 */
import type { GitHub } from '../github/client.js';
import { describeGitHubError } from '../github/client.js';
import type { ParsedError } from '../parse/index.js';
import type { RepoRef } from '../resolve/index.js';
import { extractAnchor, informative, methodName, similarity, tokenize, type SimilarityBreakdown } from './similarity.js';
import type { PackageFrame } from '../parse/index.js';

export type SearchMode = 'hybrid' | 'semantic' | 'lexical';

export interface SearchAttempt {
  requested: SearchMode;
  q: string;
  /** Mode GitHub reports it actually used. */
  used?: SearchMode;
  fallbackReasons?: string[];
  totalCount?: number;
  error?: string;
  /** Not sent at all, and why (e.g. hybrid without a token). */
  skipped?: string;
  /** Why this search ran: the message itself, or the stack frame (for messages without an identifier). */
  purpose?: 'message' | 'frames';
}

export interface IssueMatch {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  stateReason: string | null;
  createdAt: string;
  closedAt: string | null;
  comments: number;
  reactions: number;
  labels: string[];
  /** 1-based position in GitHub's result list. */
  githubRank: number;
  similarity: SimilarityBreakdown;
}

export interface RepoSearchResult {
  repo: RepoRef;
  /** Mode of the attempt whose results we used; 'none' if every attempt failed. */
  modeUsed: SearchMode | 'none';
  attempts: SearchAttempt[];
  totalCount: number;
  /** Top --limit matches, for display. */
  matches: IssueMatch[];
  /** Every scored candidate. The verdict uses these, so --limit never changes the answer. */
  candidates: IssueMatch[];
  rateLimit?: RateLimitInfo;
}

export interface RateLimitInfo {
  resource: string;
  limit: number;
  remaining: number;
  resetAt: string;
}

export interface SearchOptions {
  limit: number;
  /** The package this repo publishes and its frames from the trace (closest to the throw first). */
  frames?: { pkg: string; frames: PackageFrame[] };
}

/**
 * Fixed page size: we re-rank locally, so fetch a generous pool regardless of
 * --limit. Keeping it constant also keeps request URLs (cache/fixture keys) stable.
 */
const PER_PAGE = 20;

/** GitHub rejects q longer than 256 characters. */
const MAX_Q = 256;

/**
 * Build the free-text part of the query from the parsed error. Removes syntax
 * that would force GitHub off hybrid search or be read as a qualifier.
 */
export function buildQueryText(parsed: Pick<ParsedError, 'query' | 'errorCodes'>): string {
  let text = parsed.query
    // "TypeError: " — hybrid search still ANDs its lexical terms, so a class
    // name the issue body never mentions would exclude an exact match.
    // Bracketed codes ("Error [ERR_X]:") survive via errorCodes below.
    .replace(/^\s*[\w$]*(?:Error|Exception)(?:\s*\[[\w-]+\])?:\s*/, '')
    .replace(/["“”]/g, ' ') // quoted_text → lexical fallback
    .replace(/[()]/g, ' ') // parens are grouping syntax; "require()" is a 422
    .replace(/\b(AND|OR|NOT)\b/g, ' ') // boolean operators → lexical fallback
    .replace(/(\S):(?=\S)/g, '$1 ') // "foo:bar" would be parsed as a qualifier
    .replace(/:(\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const missing = parsed.errorCodes.filter((c) => !text.includes(c));
  if (missing.length) text = `${text} ${missing.slice(0, 2).join(' ')}`.trim();
  return text;
}

/** Fewer, rarer words — for a second lexical try when the full sentence finds nothing. */
export function relaxedQueryText(text: string): string {
  const generic = /^(error|typeerror|referenceerror|syntaxerror|cannot|read|properties|undefined|null|reading|not|is|function|failed|of|the|a)$/;
  const distinctive = [...new Set(tokenize(text))].filter((t) => !generic.test(t));
  return distinctive.slice(0, 5).join(' ');
}

export function composeQ(repo: RepoRef, text: string): string {
  const prefix = `repo:${repo.owner}/${repo.repo} is:issue `;
  let t = text;
  if (prefix.length + t.length > MAX_Q) t = t.slice(0, MAX_Q - prefix.length).replace(/\s+\S*$/, '');
  return prefix + t;
}

interface SearchResponse {
  total_count: number;
  search_type?: SearchMode;
  lexical_fallback_reason?: string[] | null;
  items: Array<{
    number: number;
    title: string;
    html_url: string;
    state: 'open' | 'closed';
    state_reason?: string | null;
    created_at: string;
    closed_at: string | null;
    comments: number;
    body?: string | null;
    labels: Array<{ name?: string } | string>;
    reactions?: { total_count?: number };
    pull_request?: unknown;
  }>;
}

export async function searchRepo(
  gh: GitHub,
  repo: RepoRef,
  parsed: Pick<ParsedError, 'query' | 'errorCodes'>,
  opts: SearchOptions,
): Promise<RepoSearchResult> {
  const attempts: SearchAttempt[] = [];
  const text = buildQueryText(parsed);
  let rateLimit: RateLimitInfo | undefined;

  const run = async (requested: SearchMode, qText: string): Promise<SearchResponse | undefined> => {
    const q = composeQ(repo, qText);
    const attempt: SearchAttempt = { requested, q };
    attempts.push(attempt);
    try {
      const res = await gh.rest.request('GET /search/issues', {
        q,
        per_page: PER_PAGE,
        ...(requested !== 'lexical' ? { search_type: requested } : {}),
      });
      rateLimit = readRateLimit(res.headers as Record<string, string | undefined>) ?? rateLimit;
      const data = res.data as unknown as SearchResponse;
      attempt.used = data.search_type ?? 'lexical';
      attempt.totalCount = data.total_count;
      if (data.lexical_fallback_reason?.length) attempt.fallbackReasons = data.lexical_fallback_reason;
      return data;
    } catch (err) {
      const { message } = describeGitHubError(err);
      attempt.error = message;
      const headers = (err as { response?: { headers?: Record<string, string> } }).response?.headers;
      if (headers) rateLimit = readRateLimit(headers) ?? rateLimit;
      return undefined;
    }
  };

  let data: SearchResponse | undefined;
  if (gh.authenticated) {
    data = await run('hybrid', text);
  } else {
    attempts.push({ requested: 'hybrid', q: composeQ(repo, text), skipped: 'hybrid search requires a GitHub token' });
  }
  if (!data) data = await run('lexical', text);
  // Lexical search ANDs every word, so a long message often finds nothing.
  let usedAttempt = [...attempts].reverse().find((a) => a.used);
  if (data && data.total_count === 0) {
    const relaxed = relaxedQueryText(text);
    if (relaxed && relaxed !== text) {
      const retry = await run('lexical', relaxed);
      if (retry && retry.total_count > 0) {
        data = retry;
        usedAttempt = attempts.at(-1);
      }
    }
  }

  // No identifier in the message ("fetch failed"): search for the code path too —
  // issues that pasted the same trace name the same function. Lexical, so it
  // draws on the larger search quota rather than hybrid's 10/min.
  let pool = data?.items ?? [];
  // The first frame that identifies a code path (not the library's error plumbing).
  const top = opts.frames?.frames.find(informative);
  const topMethod = methodName(top?.fn);
  if (!extractAnchor(parsed.query) && topMethod && topMethod.length >= 4) {
    // Message words + the function, without appended error codes: lexical search
    // ANDs every term, and an issue pasting the trace rarely repeats the code.
    const frameData = await run('lexical', `${buildQueryText({ query: parsed.query, errorCodes: [] })} ${topMethod}`);
    attempts.at(-1)!.purpose = 'frames';
    const seen = new Set(pool.map((i) => i.number));
    pool = [...pool, ...(frameData?.items ?? []).filter((i) => !seen.has(i.number))];
  }

  const items = pool.filter((i) => !i.pull_request);
  const scored = items.map((i, idx): IssueMatch => ({
    number: i.number,
    title: i.title,
    url: i.html_url,
    state: i.state,
    stateReason: i.state_reason ?? null,
    createdAt: i.created_at,
    closedAt: i.closed_at,
    comments: i.comments,
    reactions: i.reactions?.total_count ?? 0,
    labels: i.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
    githubRank: idx + 1,
    similarity: similarity(parsed.query, i.title, i.body, opts.frames),
  }));

  // Rank by our similarity; GitHub's (semantic) order breaks ties.
  scored.sort((a, b) => b.similarity.score - a.similarity.score || a.githubRank - b.githubRank);

  return {
    repo,
    modeUsed: usedAttempt?.used ?? 'none',
    attempts,
    totalCount: data?.total_count ?? 0,
    matches: scored.slice(0, opts.limit),
    candidates: scored,
    ...(rateLimit ? { rateLimit } : {}),
  };
}

export interface CanonicalRepo {
  repo: RepoRef;
  renamedFrom?: string;
  hasIssues: boolean;
}

/**
 * Search does not follow repo renames (prisma/prisma → prisma/orm gives a 422
 * "cannot be searched"), but GET /repos does. Resolve the current name first.
 */
export async function canonicalizeRepo(gh: GitHub, ref: RepoRef): Promise<CanonicalRepo> {
  const res = await gh.rest.request('GET /repos/{owner}/{repo}', { owner: ref.owner, repo: ref.repo });
  const [owner, repo] = res.data.full_name.split('/') as [string, string];
  const before = `${ref.owner}/${ref.repo}`;
  return {
    repo: { owner, repo, ...(ref.directory ? { directory: ref.directory } : {}) },
    ...(res.data.full_name.toLowerCase() !== before.toLowerCase() ? { renamedFrom: before } : {}),
    hasIssues: res.data.has_issues,
  };
}

export function readRateLimit(h: Record<string, string | undefined>): RateLimitInfo | undefined {
  const limit = h['x-ratelimit-limit'];
  const remaining = h['x-ratelimit-remaining'];
  const reset = h['x-ratelimit-reset'];
  if (limit === undefined || remaining === undefined || reset === undefined) return undefined;
  return {
    resource: h['x-ratelimit-resource'] ?? 'unknown',
    limit: Number(limit),
    remaining: Number(remaining),
    resetAt: new Date(Number(reset) * 1000).toISOString(),
  };
}
