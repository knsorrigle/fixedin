/**
 * The issue timeline without a token. GraphQL rejects every unauthenticated
 * call, but the REST timeline is public, so it's rebuilt into the GraphQL
 * shape and pickFix() decides exactly as it would with a token.
 *
 * What REST lacks, and how it's recovered:
 *   - ClosedEvent.closer: REST names the commit for a close by commit, but not
 *     the PR for a close by merge. GitHub closes an issue within seconds of
 *     merging a PR whose description says "Fixes #123", so a same-repo PR with
 *     a closing keyword for this issue, merged within a minute before the
 *     close, is taken as the closer.
 *   - willCloseTarget: the cross-referenced PR's description is in the event,
 *     so closing keywords are read from it directly.
 *   - merge commit / base branch: one GET per candidate PR, only for the few
 *     that pickFix could choose.
 *   - MarkedAsDuplicateEvent.canonical: GitHub's own "Duplicate of #123" comment.
 *   - ConnectedEvent (a PR linked in the sidebar) has no REST equivalent.
 *
 * Budget: without a token GitHub allows 60 requests an hour, so this reads at
 * most MAX_PAGES timeline pages and MAX_PR_LOOKUPS pull requests.
 */
import type { GitHub } from '../github/client.js';
import type { RepoRef } from '../resolve/index.js';
import type { CommitNode, PrNode, Timeline, TimelineNode } from './index.js';

const MAX_PAGES = 3;
const MAX_PR_LOOKUPS = 3;
/** A merge this close before the close is GitHub closing the issue for the PR. */
const AUTO_CLOSE_MS = 60_000;
/** Same window pickFix uses for a PR merged "just before" a manual close. */
const NEAR_CLOSE_MS = 2 * 86_400_000;

interface RestEvent {
  event: string;
  created_at?: string;
  commit_id?: string | null;
  commit_url?: string | null;
  body?: string | null;
  source?: {
    type?: string;
    issue?: {
      number: number;
      title: string;
      html_url: string;
      body?: string | null;
      repository?: { full_name: string };
      pull_request?: { merged_at?: string | null; html_url?: string };
    };
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** GitHub's closing keywords (docs: "Linking a pull request to an issue") aimed at this issue. */
export function closesIssue(text: string | null | undefined, repo: RepoRef, number: number): boolean {
  if (!text) return false;
  const slug = escapeRe(`${repo.owner}/${repo.repo}`);
  const ref = `(?:#|${slug}#|https://github\\.com/${slug}/issues/)${number}(?!\\d)`;
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s+${ref}`, 'i').test(text);
}

/** "https://api.github.com/repos/owner/name/commits/sha" → "owner/name". */
const repoOfCommitUrl = (url: string) => url.match(/\/repos\/([^/]+\/[^/]+)\/commits\//)?.[1];

const upper = <T extends string>(s: string | null | undefined) => (s ? (s.toUpperCase() as T) : null);

export async function fetchRestTimeline(gh: GitHub, repo: RepoRef, number: number): Promise<Timeline> {
  const params = { owner: repo.owner, repo: repo.repo, issue_number: number };
  const { data: issue } = await gh.rest.request('GET /repos/{owner}/{repo}/issues/{issue_number}', params);

  const events: RestEvent[] = [];
  let truncated: string | undefined;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await gh.rest.request('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', { ...params, per_page: 100, page });
    events.push(...(res.data as unknown as RestEvent[]));
    if (!/rel="next"/.test(res.headers.link ?? '')) break;
    if (page === MAX_PAGES) truncated = `Timeline has more than ${MAX_PAGES * 100} events; only the first ${MAX_PAGES * 100} were read (a GitHub token reads more).`;
  }

  const self = `${repo.owner}/${repo.repo}`.toLowerCase();
  const closes = events.filter((e) => e.event === 'closed' && e.created_at);
  const lastClose = closes.at(-1);
  const closedAt = lastClose ? Date.parse(lastClose.created_at!) : undefined;

  // Same-repo PRs that referenced the issue, and which of them pickFix could choose.
  const prs = events
    .filter((e) => e.event === 'cross-referenced' && e.source?.issue?.pull_request)
    .map((e) => ({ event: e, pr: e.source!.issue! }))
    .filter(({ pr }) => (pr.repository?.full_name ?? '').toLowerCase() === self);
  const mergedAt = (pr: (typeof prs)[number]['pr']) => (pr.pull_request?.merged_at ? Date.parse(pr.pull_request.merged_at) : undefined);
  const nearClose = (pr: (typeof prs)[number]['pr'], window: number) => {
    const m = mergedAt(pr);
    return m !== undefined && closedAt !== undefined && m <= closedAt + AUTO_CLOSE_MS && closedAt - m < window;
  };
  const candidates = prs
    .filter(({ pr }) => mergedAt(pr) !== undefined && (closesIssue(pr.body, repo, number) || nearClose(pr, NEAR_CLOSE_MS)))
    // Latest merge first: that's the one pickFix prefers.
    .sort((a, b) => mergedAt(b.pr)! - mergedAt(a.pr)!)
    .slice(0, MAX_PR_LOOKUPS);

  const details = new Map<number, PrNode>();
  for (const { pr } of candidates) {
    const { data } = await gh.rest.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner: repo.owner, repo: repo.repo, pull_number: pr.number });
    details.set(pr.number, {
      __typename: 'PullRequest',
      number: data.number,
      title: data.title,
      url: data.html_url,
      merged: Boolean(data.merged_at),
      mergedAt: data.merged_at,
      baseRefName: data.base.ref,
      mergeCommit: data.merge_commit_sha ? { oid: data.merge_commit_sha } : null,
      repository: { nameWithOwner: `${repo.owner}/${repo.repo}` },
    });
  }
  const prNode = (pr: (typeof prs)[number]['pr']): PrNode =>
    details.get(pr.number) ?? {
      __typename: 'PullRequest',
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      merged: mergedAt(pr) !== undefined,
      mergedAt: pr.pull_request?.merged_at ?? null,
      baseRefName: '',
      // Not looked up: pickFix can't use it as a fix.
      mergeCommit: null,
      repository: { nameWithOwner: pr.repository?.full_name ?? '' },
    };

  // The PR GitHub closed the issue for: says it closes it, merged just before the close.
  const autoCloser = candidates.find(({ pr }) => closesIssue(pr.body, repo, number) && nearClose(pr, AUTO_CLOSE_MS) && details.has(pr.number));

  const nodes: TimelineNode[] = [];
  for (const e of events) {
    const createdAt = e.created_at ?? '';
    if (e.event === 'closed') {
      let closer: PrNode | CommitNode | null = null;
      const commitRepo = e.commit_id && e.commit_url ? repoOfCommitUrl(e.commit_url) : undefined;
      if (e.commit_id && commitRepo) {
        closer = { __typename: 'Commit', oid: e.commit_id, url: `https://github.com/${commitRepo}/commit/${e.commit_id}`, repository: { nameWithOwner: commitRepo } };
      } else if (e === lastClose && autoCloser) {
        closer = details.get(autoCloser.pr.number)!;
      }
      nodes.push({ __typename: 'ClosedEvent', createdAt, closer });
    } else if (e.event === 'reopened') {
      nodes.push({ __typename: 'ReopenedEvent', createdAt });
    } else if (e.event === 'cross-referenced' && e.source?.issue) {
      const src = e.source.issue;
      nodes.push({
        __typename: 'CrossReferencedEvent',
        createdAt,
        willCloseTarget: Boolean(src.pull_request) && closesIssue(src.body, repo, number),
        source: src.pull_request ? prNode(src) : { __typename: 'Issue' },
      });
    } else if (e.event === 'commented') {
      const dup = e.body?.match(/^\s*Duplicate of #(\d+)\b/m);
      if (dup) nodes.push({ __typename: 'MarkedAsDuplicateEvent', createdAt, canonical: { __typename: 'Issue', number: Number(dup[1]), repository: { nameWithOwner: `${repo.owner}/${repo.repo}` } } });
    }
  }

  return {
    issue: {
      number: issue.number,
      state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
      stateReason: upper(issue.state_reason),
      closedAt: issue.closed_at,
      url: issue.html_url,
    },
    nodes,
    ...(truncated ? { truncated } : {}),
  };
}
