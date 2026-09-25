/**
 * verdict/: combine match + trace + release + installed version into one answer.
 *
 * The spec's four verdicts, plus two that exist because the honest answer
 * doesn't fit them:
 *   FIX_UNRELEASED       — fixing PR merged, but no npm release contains it yet
 *   CLOSED_NO_FIX_FOUND  — matching issue is closed, but no fix could be traced
 *                          (closed manually, stale-bot, wontfix, or no token)
 */
import semver from 'semver';
import type { InstalledPackage } from '../lockfile/index.js';
import type { Containment, ReleaseResult } from '../release/index.js';
import type { RepoRef } from '../resolve/index.js';
import type { IssueMatch } from '../search/index.js';
import type { FixRef, TraceResult } from '../trace/index.js';
import type { Relation } from '../relation.js';
import type { Remedy } from '../remedy/index.js';

export type VerdictKind =
  | 'FIXED_UPSTREAM_UPGRADE'
  | 'ALREADY_HAVE_FIX'
  | 'FIX_UNRELEASED'
  | 'OPEN_ISSUE'
  | 'CLOSED_NO_FIX_FOUND'
  | 'NO_MATCH';

/** Below this, a search hit is shown as "closest" but not treated as a match. */
export const MATCH_THRESHOLD = 0.6;
/** Matches between MATCH_THRESHOLD and this are flagged as weak in the output. */
export const STRONG_MATCH = 0.75;

export interface Workaround {
  url: string;
  author: string;
  reactions: number;
  hasCode: boolean;
  /** First ~12 lines of the comment. */
  excerpt: string;
}

export interface Verdict {
  kind: VerdictKind;
  repo: RepoRef;
  packageName?: string;
  installed?: InstalledPackage;
  match?: IssueMatch;
  fix?: FixRef;
  fixedIn?: string;
  latest?: string;
  /** Direct check: does the installed version's source contain the fix commit? */
  installedHasFix?: Containment;
  workaround?: Workaround;
  /** One-line recommendation. */
  advice: string;
  /** Direct dependency, or pulled in by another package (set for any verdict with a linked package). */
  relation?: Relation;
  /** For a transitive copy with a released fix: refresh, upgrade the parent, or override. */
  remedy?: Remedy;
  /** Why we reached this verdict, for --verbose and --json. */
  reasons: string[];
}

export interface FixedInputs {
  repo: RepoRef;
  packageName?: string;
  installed?: InstalledPackage;
  match: IssueMatch;
  trace: TraceResult;
  fix: FixRef;
  release?: Pick<ReleaseResult, 'fixedIn' | 'latest' | 'probes' | 'considered'>;
  installedProbe?: Containment;
}

/** Decide between upgrade / already-have / unreleased for a traced fix. */
export function decideFixed(i: FixedInputs): Verdict {
  const base = {
    repo: i.repo,
    ...(i.packageName ? { packageName: i.packageName } : {}),
    ...(i.installed ? { installed: i.installed } : {}),
    match: i.match,
    fix: i.fix,
    ...(i.release?.fixedIn ? { fixedIn: i.release.fixedIn } : {}),
    ...(i.release?.latest ? { latest: i.release.latest } : {}),
    ...(i.installedProbe ? { installedHasFix: i.installedProbe } : {}),
  };
  const reasons = [`Fix traced via ${i.fix.evidence}.`];
  const fixedIn = i.release?.fixedIn;
  const have = i.installed?.version;

  if (!i.packageName) {
    reasons.push('No npm package is linked to this repo, so releases could not be checked.');
    return { ...base, kind: 'FIXED_UPSTREAM_UPGRADE', advice: 'A fix was merged upstream; check the release notes for the version that ships it.', reasons };
  }

  if (!fixedIn) {
    const resolvable = (i.release?.probes ?? []).some((p) => p.result !== 'unknown');
    if (resolvable) {
      reasons.push(`None of the ${i.release!.considered} releases since the merge contain the fix commit.`);
      return { ...base, kind: 'FIX_UNRELEASED', advice: 'The fix is merged but not in any npm release yet; wait for the next release or install from git.', reasons };
    }
    reasons.push('Could not map any npm version to a git commit, so the fixing release is unknown.');
    return {
      ...base,
      kind: 'FIXED_UPSTREAM_UPGRADE',
      advice: i.release?.latest ? `A fix was merged upstream; try the latest release (${i.release.latest}).` : 'A fix was merged upstream.',
      reasons,
    };
  }

  if (!have) {
    reasons.push('Installed version unknown (not in lockfile or node_modules).');
    return { ...base, kind: 'FIXED_UPSTREAM_UPGRADE', advice: `Make sure you're on >=${fixedIn}.`, reasons };
  }

  // The direct compare beats semver: backport branches make semver order lie.
  if (i.installedProbe === 'contains' || (i.installedProbe !== 'missing' && semver.valid(have) && semver.gte(have, fixedIn))) {
    reasons.push(
      i.installedProbe === 'contains'
        ? `The source of ${have} contains the fix commit.`
        : `${have} >= ${fixedIn} (semver; direct commit check unavailable).`,
    );
    return {
      ...base,
      kind: 'ALREADY_HAVE_FIX',
      advice: `You already have this fix (${have} >= ${fixedIn}). This is likely a different bug with the same message — consider opening a new issue.`,
      reasons,
    };
  }
  reasons.push(i.installedProbe === 'missing' ? `The source of ${have} does not contain the fix commit.` : `${have} < ${fixedIn}.`);
  return { ...base, kind: 'FIXED_UPSTREAM_UPGRADE', advice: `Upgrade to >=${fixedIn}`, reasons };
}

// ---------------------------------------------------------------------------
// Workaround comments on open issues
// ---------------------------------------------------------------------------

export interface IssueComment {
  html_url: string;
  body?: string | null;
  user?: { login?: string; type?: string } | null;
  author_association?: string;
  reactions?: { total_count?: number; '+1'?: number; heart?: number; hooray?: number; rocket?: number; '-1'?: number; confused?: number };
}

const HAS_CODE = /```|^( {4}|\t)\S/m;
const NOISE = /^\s*(\+1|same here|any update|me too|same issue|bump)[.!?\s]*$/i;

/**
 * The comment most likely to contain a workaround: has a code block, or high
 * positive reactions. Bots and "+1" comments are skipped.
 */
export function pickWorkaround(comments: IssueComment[]): Workaround | undefined {
  const scored = comments
    .filter((c) => c.body && !NOISE.test(c.body) && c.user?.type !== 'Bot')
    .map((c) => {
      const r = c.reactions ?? {};
      const positive = (r['+1'] ?? 0) + (r.heart ?? 0) + (r.hooray ?? 0) + (r.rocket ?? 0);
      const negative = (r['-1'] ?? 0) + (r.confused ?? 0);
      const hasCode = HAS_CODE.test(c.body!);
      const mentionsWorkaround = /work.?around|temporar|in the meantime|fixed it by|solution/i.test(c.body!);
      const score = positive - negative + (hasCode ? 5 : 0) + (mentionsWorkaround ? 3 : 0);
      return { c, score, hasCode, positive };
    })
    .filter((x) => x.hasCode || x.positive >= 3)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return undefined;
  return {
    url: best.c.html_url,
    author: best.c.user?.login ?? 'unknown',
    reactions: best.positive,
    hasCode: best.hasCode,
    excerpt: best.c.body!.trim().split('\n').slice(0, 12).join('\n'),
  };
}
