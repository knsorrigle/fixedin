/**
 * release/: find the EARLIEST npm release whose source contains a commit.
 *
 * For each npm version we need a git ref for its source:
 *   1. `gitHead` from the npm packument (set by `npm publish` from a git checkout)
 *   2. otherwise a tag — `v1.2.3`, `1.2.3`, `pkg@1.2.3`, … (format learned once per package)
 * Containment is GET /repos/{o}/{r}/compare/{fixSha}...{ref}: status "ahead" or
 * "identical" means the release contains the fix.
 *
 * Versions are binary-searched (semver order, stable only, published after the
 * fix was merged) so a package with 500 releases costs ~9 compares, not 500.
 * This assumes containment is monotonic in semver order within that window —
 * true for linear release histories; cherry-picked backports can break it, so
 * the installed version is also checked directly (see checkVersion).
 */
import semver from 'semver';
import type { GitHub } from '../github/client.js';
import { describeGitHubError } from '../github/client.js';
import type { NetClient } from '../net/client.js';
import { registryUrl, type RepoRef } from '../resolve/index.js';

export interface Packument {
  name: string;
  versions: Record<string, { version: string; gitHead?: string; deprecated?: string }>;
  time?: Record<string, string>;
}

export type Containment = 'contains' | 'missing' | 'unknown';

export interface VersionProbe {
  version: string;
  ref?: string;
  refSource?: 'gitHead' | 'tag';
  result: Containment;
  /** compare status, or why the probe failed. */
  detail: string;
}

export interface ReleaseResult {
  /** Earliest stable version containing the fix, if any. */
  fixedIn?: string;
  /** Latest stable version, for context. */
  latest?: string;
  probes: VersionProbe[];
  /** Number of versions considered (after the merge-date filter). */
  considered: number;
  notes: string[];
}

export const TAG_PATTERNS: Array<(name: string, v: string) => string> = [
  (_n, v) => `v${v}`,
  (_n, v) => v,
  (n, v) => `${n}@${v}`,
  (n, v) => `${n.replace(/^@[^/]+\//, '')}@${v}`,
  (n, v) => `${n}@v${v}`,
];

export async function fetchPackument(client: NetClient, pkg: string): Promise<Packument> {
  return client.getJson<Packument>(registryUrl(pkg));
}

type CompareStatus = 'ahead' | 'behind' | 'identical' | 'diverged';

/**
 * Resolves versions to refs and runs compares, remembering which tag pattern
 * works for this package and never repeating a compare.
 */
export class ContainmentChecker {
  private tagPattern?: number;
  private readonly cache = new Map<string, VersionProbe>();

  constructor(
    private readonly gh: GitHub,
    private readonly repo: RepoRef,
    private readonly packument: Packument,
    private readonly fixSha: string,
  ) {}

  /** Every probe made so far, in semver order. */
  probes(): VersionProbe[] {
    return [...this.cache.values()].sort((a, b) => semver.compare(a.version, b.version));
  }

  async check(version: string): Promise<VersionProbe> {
    const hit = this.cache.get(version);
    if (hit) return hit;
    const probe = await this.probe(version);
    this.cache.set(version, probe);
    return probe;
  }

  private async compare(ref: string): Promise<{ status?: CompareStatus; httpStatus?: number; error?: string }> {
    try {
      const res = await this.gh.rest.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
        owner: this.repo.owner,
        repo: this.repo.repo,
        basehead: `${this.fixSha}...${ref}`,
        per_page: 1,
      });
      return { status: res.data.status as CompareStatus };
    } catch (err) {
      const { status, message } = describeGitHubError(err);
      return { ...(status ? { httpStatus: status } : {}), error: message };
    }
  }

  private toProbe(version: string, ref: string, refSource: 'gitHead' | 'tag', status: CompareStatus): VersionProbe {
    const contains = status === 'ahead' || status === 'identical';
    return { version, ref, refSource, result: contains ? 'contains' : 'missing', detail: `compare: ${status}` };
  }

  private async probe(version: string): Promise<VersionProbe> {
    const failures: string[] = [];
    const gitHead = this.packument.versions[version]?.gitHead;
    if (gitHead) {
      const r = await this.compare(gitHead);
      if (r.status) return this.toProbe(version, gitHead, 'gitHead', r.status);
      // 404 = gitHead was never pushed (published from a local commit). Try tags.
      failures.push(`gitHead ${gitHead.slice(0, 7)}: ${r.error}`);
    }

    const patterns = this.tagPattern !== undefined ? [this.tagPattern] : TAG_PATTERNS.map((_, i) => i);
    for (const i of patterns) {
      const tag = TAG_PATTERNS[i]!(this.packument.name, version);
      const r = await this.compare(tag);
      if (r.status) {
        this.tagPattern = i;
        return this.toProbe(version, tag, 'tag', r.status);
      }
      failures.push(`tag ${tag}: ${r.error}`);
      // Anything but "no such ref" (e.g. rate limit, 5xx) won't be fixed by another pattern.
      if (r.httpStatus !== 404) break;
    }
    return { version, result: 'unknown', detail: failures.join('; ') || 'no gitHead and no tag' };
  }
}

/** Stable versions published at/after `since`, ascending semver. */
export function candidateVersions(p: Packument, since?: string): string[] {
  const sinceMs = since ? Date.parse(since) : undefined;
  return Object.keys(p.versions)
    .filter((v) => semver.valid(v) && !semver.prerelease(v))
    .filter((v) => {
      if (sinceMs === undefined) return true;
      const t = p.time?.[v];
      // Unknown publish time: keep it rather than guess.
      return !t || Date.parse(t) >= sinceMs;
    })
    .sort(semver.compare);
}

export async function findFixRelease(
  gh: GitHub,
  repo: RepoRef,
  packument: Packument,
  fixSha: string,
  opts: {
    mergedAt?: string;
    /** Ignore versions below this (e.g. `${installedMajor}.0.0`) so a backport to an old line isn't reported. */
    floor?: string;
    checker?: ContainmentChecker;
  } = {},
): Promise<ReleaseResult & { checker: ContainmentChecker }> {
  const checker = opts.checker ?? new ContainmentChecker(gh, repo, packument, fixSha);
  const notes: string[] = [];
  const all = candidateVersions(packument);
  const latest = all.at(-1);
  // A version published before the fix was merged can't contain it.
  let list = candidateVersions(packument, opts.mergedAt);
  if (opts.mergedAt && all.length !== list.length) {
    notes.push(`${all.length - list.length} release(s) published before the fix was merged (${opts.mergedAt.slice(0, 10)}) were skipped.`);
  }
  if (opts.floor) {
    const before = list.length;
    list = list.filter((v) => semver.gte(v, opts.floor!));
    if (before !== list.length) notes.push(`${before - list.length} release(s) below ${opts.floor} were skipped.`);
  }
  const considered = list.length;

  // Binary search for the first version that contains the fix. Versions
  // whose ref can't be resolved are dropped from the list as we find them.
  let lo = 0;
  let hi = list.length - 1;
  let found: string | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const probe = await checker.check(list[mid]!);
    if (probe.result === 'unknown') {
      list = [...list.slice(0, mid), ...list.slice(mid + 1)];
      hi--;
      continue;
    }
    if (probe.result === 'contains') {
      found = list[mid];
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  const probes = checker.probes();
  const unknown = probes.filter((p) => p.result === 'unknown');
  if (unknown.length) {
    notes.push(`Could not map ${unknown.length} version(s) to a git ref: ${unknown.map((p) => `${p.version} (${p.detail})`).join('; ')}`);
  }
  if (!found && considered > 0 && unknown.length === probes.length) {
    notes.push('No npm version could be mapped to a commit (no gitHead, no recognizable tags), so the release is unknown.');
  }
  return { ...(found ? { fixedIn: found } : {}), ...(latest ? { latest } : {}), probes, considered, notes, checker };
}
