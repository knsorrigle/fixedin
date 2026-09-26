/**
 * Tracing without a token: the public REST timeline rebuilt into the GraphQL
 * shape. Recorded cases check it reaches the same answers a token does;
 * synthetic timelines cover what the recordings don't (commits, reopen,
 * duplicates, paging).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuthResult } from '../src/github/auth.js';
import { createGitHub } from '../src/github/client.js';
import { createClient, replayFetch, slimFixtureBody, type FetchLike } from '../src/net/client.js';
import { run } from '../src/pipeline.js';
import { traceFix } from '../src/trace/index.js';
import { closesIssue } from '../src/trace/rest.js';

const fixtures = join(import.meta.dirname, 'fixtures');
const stack = (n: string) => readFileSync(join(fixtures, 'stacks', `${n}.txt`), 'utf8');
const client = createClient(replayFetch(join(fixtures, 'http')));
const anon: AuthResult = { source: 'none', tried: ['GITHUB_TOKEN: not set'] };
const repo = { owner: 'acme', repo: 'lib' };
/** A REST "cross-referenced" event from a PR. */
const prRef = (n: number, merged_at: string | null, body = '', full_name = 'acme/lib') => ({
  event: 'cross-referenced',
  created_at: '2024-01-01T00:00:00Z',
  source: { type: 'issue', issue: { number: n, title: `PR ${n}`, html_url: `https://github.com/${full_name}/pull/${n}`, body, repository: { full_name }, pull_request: { merged_at } } },
});

describe('closesIssue', () => {
  it.each([
    ['Fixes #12', true],
    ['this PR closes: #12.', true],
    ['resolved acme/lib#12', true],
    ['Fix https://github.com/acme/lib/issues/12', true],
    ['fix #10357\nfix #12', true],
    ['Fixes #123', false],
    ['Fixes #1', false],
    ['related to #12', false],
    ['Fixes other/repo#12', false],
    ['prefixes #12', false],
  ])('%j → %s', (text, expected) => {
    expect(closesIssue(text, repo, 12)).toBe(expected);
  });
});

describe('recorded, without a token', () => {
  it('axios#5011: closed by PR #5162 (closing keyword, merged seconds before the close) → 1.2.0', async () => {
    const r = await run(stack('axios-default-create'), { cwd: join(fixtures, 'projects/axios-1.1.3'), client, limit: 5, auth: anon, repo: 'axios/axios' });
    expect(r.verdicts[0]).toMatchObject({
      kind: 'FIXED_UPSTREAM_UPGRADE',
      match: { number: 5011 },
      fix: { number: 5162, evidence: 'closed-by-pr', baseRef: 'v1.x' },
      fixedIn: '1.2.0',
    });
  });

  it('vite#10358: the backport PR says "fix #10358" → linked, found in 3.1.6', async () => {
    const r = await run(stack('vite-esm'), { cwd: join(fixtures, 'projects/axios-app'), client, limit: 3, auth: anon });
    expect(r.verdicts.find((v) => v.packageName === 'vite')).toMatchObject({
      kind: 'FIXED_UPSTREAM_UPGRADE',
      fix: { number: 10360, evidence: 'linked-pr', baseRef: 'v3.1' },
      fixedIn: '3.1.6',
    });
  });
});

describe('synthetic REST timelines', () => {
  /** Serves `routes` by URL path (+ page), recording what was asked for. */
  const stub = (routes: Record<string, unknown>, link: Record<string, string> = {}) => {
    const asked: string[] = [];
    const f: FetchLike = async (input) => {
      const u = new URL(input instanceof Request ? input.url : input.toString());
      const key = `${u.pathname}${u.searchParams.get('page') ? `?page=${u.searchParams.get('page')}` : ''}`;
      asked.push(key);
      if (!(key in routes)) return new Response('{"message":"Not Found"}', { status: 404, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json', ...(link[key] ? { link: link[key] } : {}) } });
    };
    return { gh: createGitHub(createClient(f)), asked };
  };
  const issue = (n: number, state_reason = 'completed') => ({ number: n, state: 'closed', state_reason, closed_at: '2024-01-02T00:00:00Z', html_url: `https://github.com/acme/lib/issues/${n}` });
  const pull = (n: number, merged_at: string, sha: string) => ({ number: n, title: `PR ${n}`, html_url: `https://github.com/acme/lib/pull/${n}`, merged_at, merge_commit_sha: sha, base: { ref: 'main' } });

  it('a close by commit names the commit', async () => {
    const { gh } = stub({
      '/repos/acme/lib/issues/1': issue(1),
      '/repos/acme/lib/issues/1/timeline?page=1': [
        { event: 'closed', created_at: '2024-01-02T00:00:00Z', commit_id: 'abc123', commit_url: 'https://api.github.com/repos/acme/lib/commits/abc123' },
      ],
    });
    expect((await traceFix(gh, repo, 1)).fix).toMatchObject({ kind: 'commit', sha: 'abc123', evidence: 'closed-by-commit', url: 'https://github.com/acme/lib/commit/abc123' });
  });

  it('only looks up PRs pickFix could choose, and ignores other repos\' "fixes #N"', async () => {
    const { gh, asked } = stub({
      '/repos/acme/lib/issues/2': issue(2),
      '/repos/acme/lib/issues/2/timeline?page=1': [
        prRef(40, '2023-06-01T00:00:00Z'), // merged long before, no keyword: never a candidate
        prRef(41, '2024-01-01T12:00:00Z', 'Fixes #2', 'someone/fork'),
        prRef(42, '2024-01-01T23:00:00Z'), // merged an hour before a manual close
        { event: 'closed', created_at: '2024-01-02T00:00:00Z' },
      ],
      '/repos/acme/lib/pulls/42': pull(42, '2024-01-01T23:00:00Z', 'sha42'),
    });
    const t = await traceFix(gh, repo, 2);
    expect(t.fix).toMatchObject({ number: 42, sha: 'sha42', evidence: 'referenced-pr-near-close' });
    expect(asked.filter((a) => a.includes('/pulls/'))).toEqual(['/repos/acme/lib/pulls/42']);
  });

  it('a reopen undoes the auto-close: the earlier PR is only linked, not the closer', async () => {
    const { gh } = stub({
      '/repos/acme/lib/issues/3': issue(3),
      '/repos/acme/lib/issues/3/timeline?page=1': [
        prRef(50, '2023-12-01T00:00:00Z', 'Fixes #3'),
        { event: 'closed', created_at: '2023-12-01T00:00:03Z' },
        { event: 'reopened', created_at: '2023-12-05T00:00:00Z' },
        { event: 'closed', created_at: '2024-01-02T00:00:00Z' },
      ],
      '/repos/acme/lib/pulls/50': pull(50, '2023-12-01T00:00:00Z', 'sha50'),
    });
    expect((await traceFix(gh, repo, 3)).fix).toMatchObject({ number: 50, evidence: 'linked-pr' });
  });

  it('follows "Duplicate of #N" to the canonical issue', async () => {
    const { gh } = stub({
      '/repos/acme/lib/issues/4': issue(4, 'duplicate'),
      '/repos/acme/lib/issues/4/timeline?page=1': [
        { event: 'commented', created_at: '2024-01-02T00:00:00Z', body: 'Duplicate of #5' },
        { event: 'closed', created_at: '2024-01-02T00:00:00Z', state_reason: 'duplicate' },
      ],
      '/repos/acme/lib/issues/5': issue(5),
      '/repos/acme/lib/issues/5/timeline?page=1': [prRef(60, '2024-01-01T00:00:00Z', 'closes #5'), { event: 'closed', created_at: '2024-01-01T00:00:10Z' }],
      '/repos/acme/lib/pulls/60': pull(60, '2024-01-01T00:00:00Z', 'sha60'),
    });
    const t = await traceFix(gh, repo, 4);
    expect(t).toMatchObject({ duplicateOf: 5, fix: { number: 60, evidence: 'closed-by-pr' } });
  });

  it('stops after 3 timeline pages and says so', async () => {
    const page = (p: number) => `<https://api.github.com/repos/acme/lib/issues/6/timeline?page=${p + 1}>; rel="next"`;
    const { gh, asked } = stub(
      {
        '/repos/acme/lib/issues/6': issue(6),
        '/repos/acme/lib/issues/6/timeline?page=1': [],
        '/repos/acme/lib/issues/6/timeline?page=2': [],
        '/repos/acme/lib/issues/6/timeline?page=3': [],
      },
      { '/repos/acme/lib/issues/6/timeline?page=1': page(1), '/repos/acme/lib/issues/6/timeline?page=2': page(2), '/repos/acme/lib/issues/6/timeline?page=3': page(3) },
    );
    const t = await traceFix(gh, repo, 6);
    expect(asked.filter((a) => a.includes('timeline'))).toHaveLength(3);
    expect(t.notes.join(' ')).toMatch(/only the first 300 were read/);
  });
});

describe('slimming timelines for the cache and fixtures', () => {
  it('keeps only the events and fields the trace reads', () => {
    const body = JSON.stringify([
      { event: 'labeled', created_at: 'x', label: { name: 'bug' } },
      { event: 'commented', created_at: 'x', body: 'me too', user: { login: 'u' } },
      { event: 'commented', created_at: 'x', body: 'Duplicate of #9', user: { login: 'u' } },
      prRef(1, null, 'long description', 'other/repo'),
      prRef(2, 'y', 'Fixes #3'),
      { event: 'closed', created_at: 'z', commit_id: null, commit_url: null, actor: { login: 'm' } },
    ]);
    const slim = JSON.parse(slimFixtureBody('https://api.github.com/repos/acme/lib/issues/3/timeline?per_page=100&page=1', body));
    expect(slim.map((e: { event: string }) => e.event)).toEqual(['commented', 'cross-referenced', 'cross-referenced', 'closed']);
    expect(slim[1].source.issue.body).toBeUndefined(); // another repo's PR: its keywords never count
    expect(slim[2].source.issue.body).toBe('Fixes #3');
    expect(slim[3]).toEqual({ event: 'closed', created_at: 'z', commit_id: null, commit_url: null });
  });
});
