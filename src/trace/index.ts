/**
 * trace/: for a closed issue, find the PR or commit that fixed it, via the
 * GraphQL issue timeline.
 *
 * Only PRs/commits in the issue's own repository count. Popular issues collect
 * dozens of cross-references from downstream repos ("bump axios to 1.2.0"),
 * and those are never the fix.
 *
 * Evidence, strongest first:
 *   1. ClosedEvent.closer is a merged PR          ("Fixes #123" in a PR)
 *   2. ClosedEvent.closer is a commit             ("Fixes #123" in a commit)
 *   3. Linked merged PR (CrossReferenced with willCloseTarget, or Connected)
 *   4. Same-repo merged PR cross-referenced within 2 days before the close
 */
import type { GitHub } from '../github/client.js';
import type { RepoRef } from '../resolve/index.js';

export type FixEvidence = 'closed-by-pr' | 'closed-by-commit' | 'linked-pr' | 'referenced-pr-near-close';

export interface FixRef {
  kind: 'pull_request' | 'commit';
  /** PR number, for kind=pull_request. */
  number?: number;
  title?: string;
  url: string;
  /** Commit that must be in a release for the fix to ship (merge commit for PRs). */
  sha: string;
  mergedAt?: string;
  baseRef?: string;
  evidence: FixEvidence;
}

export interface TraceResult {
  issue: { number: number; state: 'OPEN' | 'CLOSED'; stateReason: string | null; closedAt: string | null; url: string };
  fix?: FixRef;
  /** When closed as a duplicate, the issue we followed. */
  duplicateOf?: number;
  /** Human-readable account of what was checked. */
  notes: string[];
}

interface PrNode {
  __typename: 'PullRequest';
  number: number;
  title: string;
  url: string;
  merged: boolean;
  mergedAt: string | null;
  baseRefName: string;
  mergeCommit: { oid: string } | null;
  repository: { nameWithOwner: string };
}
interface CommitNode {
  __typename: 'Commit';
  oid: string;
  url: string;
  repository: { nameWithOwner: string };
}
type TimelineNode =
  | { __typename: 'ClosedEvent'; createdAt: string; closer: PrNode | CommitNode | { __typename: 'ProjectV2' } | null }
  | { __typename: 'ReopenedEvent'; createdAt: string }
  | { __typename: 'CrossReferencedEvent'; createdAt: string; willCloseTarget: boolean; source: PrNode | { __typename: 'Issue' } }
  | { __typename: 'ConnectedEvent'; createdAt: string; subject: PrNode | { __typename: 'Issue' } }
  | { __typename: 'MarkedAsDuplicateEvent'; createdAt: string; canonical: { __typename: string; number?: number; repository?: { nameWithOwner: string } } | null };

const PR_FIELDS = `number title url merged mergedAt baseRefName mergeCommit { oid } repository { nameWithOwner }`;

export const TIMELINE_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $before: String) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number state stateReason closedAt url
      timelineItems(last: 100, before: $before, itemTypes: [CLOSED_EVENT, REOPENED_EVENT, CROSS_REFERENCED_EVENT, CONNECTED_EVENT, MARKED_AS_DUPLICATE_EVENT]) {
        pageInfo { hasPreviousPage startCursor }
        nodes {
          __typename
          ... on ClosedEvent { createdAt closer { __typename ... on PullRequest { ${PR_FIELDS} } ... on Commit { oid url repository { nameWithOwner } } } }
          ... on ReopenedEvent { createdAt }
          ... on CrossReferencedEvent { createdAt willCloseTarget source { __typename ... on PullRequest { ${PR_FIELDS} } } }
          ... on ConnectedEvent { createdAt subject { __typename ... on PullRequest { ${PR_FIELDS} } } }
          ... on MarkedAsDuplicateEvent { createdAt canonical { __typename ... on Issue { number repository { nameWithOwner } } } }
        }
      }
    }
  }
}`;

interface TimelineResponse {
  repository: {
    issue: {
      number: number;
      state: 'OPEN' | 'CLOSED';
      stateReason: string | null;
      closedAt: string | null;
      url: string;
      timelineItems: { pageInfo: { hasPreviousPage: boolean; startCursor: string | null }; nodes: TimelineNode[] };
    } | null;
  } | null;
}

/** Busy issues can have thousands of cross-references; stop paging after this. */
const MAX_PAGES = 5;

export async function fetchTimeline(gh: GitHub, repo: RepoRef, number: number) {
  const nodes: TimelineNode[] = [];
  let before: string | null = null;
  let issue: NonNullable<NonNullable<TimelineResponse['repository']>['issue']> | undefined;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res: TimelineResponse = await gh.rest.graphql<TimelineResponse>(TIMELINE_QUERY, {
      owner: repo.owner,
      repo: repo.repo,
      number,
      before,
    });
    const i = res.repository?.issue;
    if (!i) throw new Error(`Issue ${repo.owner}/${repo.repo}#${number} not found via GraphQL`);
    issue = i;
    nodes.unshift(...i.timelineItems.nodes);
    if (!i.timelineItems.pageInfo.hasPreviousPage) break;
    before = i.timelineItems.pageInfo.startCursor;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return { issue: issue!, nodes, truncated };
}

const sameRepo = (nameWithOwner: string, repo: RepoRef) => nameWithOwner.toLowerCase() === `${repo.owner}/${repo.repo}`.toLowerCase();

function prFix(pr: PrNode, evidence: FixEvidence): FixRef | undefined {
  if (!pr.merged || !pr.mergeCommit) return undefined;
  return {
    kind: 'pull_request',
    number: pr.number,
    title: pr.title,
    url: pr.url,
    sha: pr.mergeCommit.oid,
    ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
    baseRef: pr.baseRefName,
    evidence,
  };
}

/** Pure decision logic over timeline nodes — unit-testable without the network. */
export function pickFix(nodes: TimelineNode[], repo: RepoRef): { fix?: FixRef; notes: string[] } {
  const notes: string[] = [];

  // Only events up to the final close matter; a reopen invalidates earlier closes.
  const lastClose = [...nodes].reverse().find((n) => n.__typename === 'ClosedEvent') as
    | Extract<TimelineNode, { __typename: 'ClosedEvent' }>
    | undefined;

  // closer can also be a ProjectV2 (closed from a project board) — not a fix.
  const closer = lastClose?.closer && 'repository' in lastClose.closer ? lastClose.closer : undefined;
  if (closer) {
    const c = closer;
    if (!sameRepo(c.repository.nameWithOwner, repo)) {
      notes.push(`Closed by ${c.__typename === 'PullRequest' ? 'a PR' : 'a commit'} in ${c.repository.nameWithOwner}, not ${repo.owner}/${repo.repo}; ignored.`);
    } else if (c.__typename === 'PullRequest') {
      const f = prFix(c, 'closed-by-pr');
      if (f) return { fix: f, notes };
      notes.push(`Closed by PR #${c.number}, but it has no merge commit.`);
    } else {
      return { fix: { kind: 'commit', url: c.url, sha: c.oid, evidence: 'closed-by-commit' }, notes };
    }
  } else if (lastClose) {
    notes.push(lastClose.closer ? `Closed from a ${lastClose.closer.__typename}, not by code.` : 'Closed manually (no closing PR or commit recorded).');
  }

  // Explicitly linked PRs.
  const linked: FixRef[] = [];
  for (const n of nodes) {
    const pr =
      n.__typename === 'CrossReferencedEvent' && n.willCloseTarget && n.source.__typename === 'PullRequest'
        ? n.source
        : n.__typename === 'ConnectedEvent' && n.subject.__typename === 'PullRequest'
          ? n.subject
          : undefined;
    if (pr && sameRepo(pr.repository.nameWithOwner, repo)) {
      const f = prFix(pr, 'linked-pr');
      if (f) linked.push(f);
    }
  }
  if (linked.length) {
    // Most recently merged linked PR is the one that finally resolved it.
    linked.sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''));
    if (linked.length > 1) notes.push(`${linked.length} linked PRs were merged; using the latest (#${linked[0]!.number}).`);
    return { fix: linked[0], notes };
  }

  // Weak: a same-repo PR merged shortly before the issue was closed.
  if (lastClose) {
    const closedAt = Date.parse(lastClose.createdAt);
    const near = nodes
      .filter((n): n is Extract<TimelineNode, { __typename: 'CrossReferencedEvent' }> => n.__typename === 'CrossReferencedEvent')
      .map((n) => n.source)
      .filter((s): s is PrNode => s.__typename === 'PullRequest' && sameRepo(s.repository.nameWithOwner, repo) && s.merged && !!s.mergedAt)
      .filter((pr) => {
        const merged = Date.parse(pr.mergedAt!);
        return merged <= closedAt + 60_000 && closedAt - merged < 2 * 86_400_000;
      })
      .sort((a, b) => b.mergedAt!.localeCompare(a.mergedAt!));
    if (near[0]) {
      notes.push(`No explicit link; PR #${near[0].number} referenced the issue and was merged just before it was closed.`);
      return { fix: prFix(near[0], 'referenced-pr-near-close'), notes };
    }
  }

  const sameRepoPrs = nodes.filter(
    (n) => n.__typename === 'CrossReferencedEvent' && n.source.__typename === 'PullRequest' && sameRepo(n.source.repository.nameWithOwner, repo),
  ).length;
  const otherRefs = nodes.filter((n) => n.__typename === 'CrossReferencedEvent').length - sameRepoPrs;
  notes.push(
    `No fixing PR or commit found (${sameRepoPrs} same-repo PR reference${sameRepoPrs === 1 ? '' : 's'}, ${otherRefs} reference${otherRefs === 1 ? '' : 's'} from other repos ignored).`,
  );
  return { notes };
}

export async function traceFix(gh: GitHub, repo: RepoRef, number: number, followDuplicate = true): Promise<TraceResult> {
  const { issue, nodes, truncated } = await fetchTimeline(gh, repo, number);
  const { fix, notes } = pickFix(nodes, repo);
  if (truncated) notes.push(`Timeline has more than ${MAX_PAGES * 100} events; only the latest ${MAX_PAGES * 100} were read.`);
  const result: TraceResult = {
    issue: { number: issue.number, state: issue.state, stateReason: issue.stateReason, closedAt: issue.closedAt, url: issue.url },
    ...(fix ? { fix } : {}),
    notes,
  };

  if (!fix && followDuplicate && issue.stateReason === 'DUPLICATE') {
    const dup = [...nodes].reverse().find((n) => n.__typename === 'MarkedAsDuplicateEvent') as
      | Extract<TimelineNode, { __typename: 'MarkedAsDuplicateEvent' }>
      | undefined;
    const target = dup?.canonical;
    if (target?.number && target.repository && sameRepo(target.repository.nameWithOwner, repo)) {
      const canonical = await traceFix(gh, repo, target.number, false);
      notes.push(`Closed as a duplicate of #${target.number}; followed it.`, ...canonical.notes);
      if (canonical.fix) result.fix = canonical.fix;
      result.duplicateOf = target.number;
    } else {
      notes.push('Closed as a duplicate, but the canonical issue is not linked in this repo.');
    }
  }
  return result;
}
