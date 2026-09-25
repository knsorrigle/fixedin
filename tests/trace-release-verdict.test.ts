import { describe, expect, it } from 'vitest';
import { createGitHub } from '../src/github/client.js';
import { createClient, slimFixtureBody, type FetchLike } from '../src/net/client.js';
import { candidateVersions, findFixRelease, type Packument } from '../src/release/index.js';
import { pickFix } from '../src/trace/index.js';
import { decideFixed, pickWorkaround, type IssueComment } from '../src/verdict/index.js';
import type { IssueMatch } from '../src/search/index.js';

const axios = { owner: 'axios', repo: 'axios' };
const pr = (number: number, repo = 'axios/axios', over: Record<string, unknown> = {}) => ({
  __typename: 'PullRequest' as const,
  number,
  title: `PR ${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
  merged: true,
  mergedAt: '2022-10-30T16:46:17Z',
  baseRefName: 'v1.x',
  mergeCommit: { oid: `sha${number}` },
  repository: { nameWithOwner: repo },
  ...over,
});

describe('pickFix', () => {
  it('uses the PR that closed the issue', () => {
    const { fix } = pickFix([{ __typename: 'ClosedEvent', createdAt: '2022-10-30T16:46:20Z', closer: pr(5162) }], axios);
    expect(fix).toMatchObject({ kind: 'pull_request', number: 5162, sha: 'sha5162', evidence: 'closed-by-pr' });
  });

  it('uses a closing commit', () => {
    const { fix } = pickFix(
      [{ __typename: 'ClosedEvent', createdAt: 'x', closer: { __typename: 'Commit', oid: 'abc', url: 'u', repository: { nameWithOwner: 'axios/axios' } } }],
      axios,
    );
    expect(fix).toMatchObject({ kind: 'commit', sha: 'abc', evidence: 'closed-by-commit' });
  });

  it('ignores cross-references from other repos (downstream "bump axios" PRs)', () => {
    const { fix, notes } = pickFix(
      [
        { __typename: 'CrossReferencedEvent', createdAt: '2022-10-29T00:00:00Z', willCloseTarget: true, source: pr(12, 'someone/app') },
        { __typename: 'ClosedEvent', createdAt: '2022-10-30T00:00:00Z', closer: null },
      ],
      axios,
    );
    expect(fix).toBeUndefined();
    expect(notes.at(-1)).toMatch(/1 reference from other repos ignored/);
  });

  it('falls back to a linked PR, preferring the latest merged', () => {
    const { fix } = pickFix(
      [
        { __typename: 'CrossReferencedEvent', createdAt: 'a', willCloseTarget: true, source: pr(1, 'axios/axios', { mergedAt: '2022-01-01T00:00:00Z' }) },
        { __typename: 'ConnectedEvent', createdAt: 'b', subject: pr(2, 'axios/axios', { mergedAt: '2022-02-01T00:00:00Z' }) },
        { __typename: 'ClosedEvent', createdAt: '2022-06-01T00:00:00Z', closer: null },
      ],
      axios,
    );
    expect(fix).toMatchObject({ number: 2, evidence: 'linked-pr' });
  });

  it('infers a same-repo PR merged just before a manual close, but not an old one', () => {
    const near = pickFix(
      [
        { __typename: 'CrossReferencedEvent', createdAt: 'a', willCloseTarget: false, source: pr(7, 'axios/axios', { mergedAt: '2022-10-30T10:00:00Z' }) },
        { __typename: 'ClosedEvent', createdAt: '2022-10-30T12:00:00Z', closer: null },
      ],
      axios,
    );
    expect(near.fix).toMatchObject({ number: 7, evidence: 'referenced-pr-near-close' });
    const old = pickFix(
      [
        { __typename: 'CrossReferencedEvent', createdAt: 'a', willCloseTarget: false, source: pr(7, 'axios/axios', { mergedAt: '2022-01-01T00:00:00Z' }) },
        { __typename: 'ClosedEvent', createdAt: '2022-10-30T12:00:00Z', closer: null },
      ],
      axios,
    );
    expect(old.fix).toBeUndefined();
  });

  it('ignores unmerged PRs and project-board closes', () => {
    const { fix, notes } = pickFix(
      [
        { __typename: 'CrossReferencedEvent', createdAt: 'a', willCloseTarget: true, source: pr(3, 'axios/axios', { merged: false, mergeCommit: null }) },
        { __typename: 'ClosedEvent', createdAt: 'b', closer: { __typename: 'ProjectV2' } },
      ],
      axios,
    );
    expect(fix).toBeUndefined();
    expect(notes[0]).toMatch(/ProjectV2/);
  });
});

// --- release -------------------------------------------------------------

function packument(versions: Array<[string, string | undefined, string]>): Packument {
  return {
    name: 'demo',
    versions: Object.fromEntries(versions.map(([v, gitHead]) => [v, { version: v, ...(gitHead ? { gitHead } : {}) }])),
    time: Object.fromEntries(versions.map(([v, , t]) => [v, t])),
  };
}

/** compare endpoint stub: `contains` decides containment per ref; unknown refs 404. */
function compareStub(contains: Record<string, boolean>): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (input) => {
    const url = decodeURIComponent(new URL(input instanceof Request ? input.url : input.toString()).pathname);
    const ref = url.split('...')[1]!;
    calls.push(ref);
    if (!(ref in contains)) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ status: contains[ref] ? 'ahead' : 'behind' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

describe('findFixRelease', () => {
  const versions: Array<[string, string | undefined, string]> = [
    ['0.9.0', 'g090', '2021-01-01T00:00:00Z'],
    ['1.0.0', 'g100', '2022-01-01T00:00:00Z'],
    ...Array.from({ length: 30 }, (_, i): [string, string, string] => [`1.${i + 1}.0`, `g1${i + 1}`, `2022-${String((i % 12) + 1).padStart(2, '0')}-15T00:00:00Z`]),
    ['2.0.0-beta.1', 'gbeta', '2023-01-01T00:00:00Z'],
  ];
  const contains = Object.fromEntries(versions.map(([v, g]) => [g!, v !== '2.0.0-beta.1' && /^1\.(1[7-9]|2\d|30)\./.test(v)]));

  it('binary-searches to the earliest containing release in O(log n) compares', async () => {
    const { fetch, calls } = compareStub(contains);
    const r = await findFixRelease(createGitHub(createClient(fetch), 't'), axios, packument(versions), 'fixsha');
    expect(r.fixedIn).toBe('1.17.0');
    expect(r.latest).toBe('1.30.0');
    expect(calls.length).toBeLessThanOrEqual(6);
  });

  it('skips versions published before the merge and below the floor', () => {
    const p = packument(versions);
    expect(candidateVersions(p, '2022-12-01T00:00:00Z')).toEqual(['1.12.0', '1.24.0']);
    expect(candidateVersions(p).includes('2.0.0-beta.1')).toBe(false);
  });

  it('falls back to tags when gitHead is missing, learning the tag pattern once', async () => {
    const p = packument([
      ['1.0.0', undefined, '2022-01-01T00:00:00Z'],
      ['1.1.0', undefined, '2022-02-01T00:00:00Z'],
      ['1.2.0', undefined, '2022-03-01T00:00:00Z'],
    ]);
    const { fetch, calls } = compareStub({ 'demo@1.1.0': false, 'demo@1.2.0': true, 'demo@1.0.0': false });
    const r = await findFixRelease(createGitHub(createClient(fetch), 't'), axios, p, 'fixsha');
    expect(r.fixedIn).toBe('1.2.0');
    // First probe tries v1.1.0, 1.1.0, demo@1.1.0; later probes go straight to demo@x.
    expect(calls).toEqual(['v1.1.0', '1.1.0', 'demo@1.1.0', 'demo@1.2.0']);
  });

  it('reports unmappable versions instead of guessing', async () => {
    const p = packument([['1.0.0', undefined, '2022-01-01T00:00:00Z']]);
    const { fetch } = compareStub({});
    const r = await findFixRelease(createGitHub(createClient(fetch), 't'), axios, p, 'fixsha');
    expect(r.fixedIn).toBeUndefined();
    expect(r.notes.join(' ')).toMatch(/could be mapped to a commit/);
  });
});

// --- verdict ---------------------------------------------------------------

const match = { number: 1, title: 't', state: 'closed', similarity: { score: 0.9 } } as IssueMatch;
const fix = { kind: 'pull_request' as const, number: 2, url: 'u', sha: 's', evidence: 'closed-by-pr' as const };
const installed = (version: string) => ({ name: 'demo', version, location: 'node_modules/demo', topLevel: true, source: 'package-lock.json' });
const trace = { issue: { number: 1, state: 'CLOSED' as const, stateReason: 'COMPLETED', closedAt: null, url: 'u' }, fix, notes: [] };

describe('decideFixed', () => {
  const release = (fixedIn?: string) => ({
    ...(fixedIn ? { fixedIn } : {}),
    latest: '2.0.0',
    considered: 5,
    probes: [{ version: '2.0.0', result: fixedIn ? ('contains' as const) : ('missing' as const), detail: '' }],
  });

  it('upgrade when behind', () => {
    const v = decideFixed({ repo: axios, packageName: 'demo', installed: installed('1.0.0'), match, trace, fix, release: release('1.5.0') });
    expect(v).toMatchObject({ kind: 'FIXED_UPSTREAM_UPGRADE', advice: 'Upgrade to >=1.5.0' });
  });

  it('the direct commit check beats semver (backports)', () => {
    const v = decideFixed({ repo: axios, packageName: 'demo', installed: installed('1.9.0'), match, trace, fix, release: release('1.5.0'), installedProbe: 'missing' });
    expect(v.kind).toBe('FIXED_UPSTREAM_UPGRADE');
    const w = decideFixed({ repo: axios, packageName: 'demo', installed: installed('1.4.0'), match, trace, fix, release: release('1.5.0'), installedProbe: 'contains' });
    expect(w.kind).toBe('ALREADY_HAVE_FIX');
  });

  it('FIX_UNRELEASED when no release contains the merged fix', () => {
    const v = decideFixed({ repo: axios, packageName: 'demo', installed: installed('2.0.0'), match, trace, fix, release: release() });
    expect(v).toMatchObject({ kind: 'FIX_UNRELEASED', advice: expect.stringMatching(/not in any npm release/) });
  });
});

describe('pickWorkaround', () => {
  const c = (body: string, plus = 0, login = 'u', type = 'User'): IssueComment => ({
    html_url: `https://x/${login}`,
    body,
    user: { login, type },
    reactions: { '+1': plus },
  });

  it('prefers a code block with reactions and skips bots and +1s', () => {
    const w = pickWorkaround([
      c('+1', 50),
      c('```js\nfoo()\n```', 99, 'stale-bot', 'Bot'),
      c('Workaround:\n```js\npatch()\n```', 4, 'helper'),
      c('I think this is caused by X', 2),
    ]);
    expect(w).toMatchObject({ author: 'helper', hasCode: true, reactions: 4 });
  });

  it('returns nothing when no comment has code or 3+ reactions', () => {
    expect(pickWorkaround([c('same here', 1), c('any update?', 0)])).toBeUndefined();
  });
});

describe('slimFixtureBody', () => {
  it('keeps only status fields from compare responses', () => {
    const body = JSON.stringify({ status: 'ahead', ahead_by: 3, behind_by: 0, total_commits: 3, files: [{ big: 1 }], commits: [] });
    expect(JSON.parse(slimFixtureBody('https://api.github.com/repos/a/b/compare/x...y?per_page=1', body))).toEqual({
      status: 'ahead',
      ahead_by: 3,
      behind_by: 0,
      total_commits: 3,
    });
  });
  it('leaves other responses alone', () => {
    expect(slimFixtureBody('https://api.github.com/search/issues?q=x', '{"items":[]}')).toBe('{"items":[]}');
  });
});
