import { describe, expect, it } from 'vitest';
import { resolveToken } from '../src/github/auth.js';
import { createGitHub } from '../src/github/client.js';
import { createClient, type FetchLike } from '../src/net/client.js';
import { buildQueryText, composeQ, readRateLimit, relaxedQueryText, searchRepo } from '../src/search/index.js';
import { ANCHOR_MISS_CAP, extractAnchor, mentions, normalizeMessage, similarity, tokenize } from '../src/search/similarity.js';
import { MATCH_THRESHOLD } from '../src/verdict/index.js';

const axios = { owner: 'axios', repo: 'axios' };

describe('buildQueryText', () => {
  const q = (query: string, errorCodes: string[] = []) => buildQueryText({ query, errorCodes });

  it('drops the error class prefix (hybrid still ANDs lexical terms)', () => {
    expect(q("TypeError: Cannot read properties of undefined (reading 'headers')")).toBe(
      "Cannot read properties of undefined reading 'headers'",
    );
  });
  it('removes syntax that forces lexical fallback or a 422', () => {
    expect(q('Error: "quoted" require() failed OR NOT ok')).toBe('quoted require failed ok');
  });
  it('keeps bracketed codes via errorCodes and appends missing ones', () => {
    expect(q('Error [ERR_REQUIRE_ESM]: require() of ES Module not supported.', ['ERR_REQUIRE_ESM'])).toBe(
      'require of ES Module not supported. ERR_REQUIRE_ESM',
    );
    expect(q('connect ECONNREFUSED', ['ECONNREFUSED'])).toBe('connect ECONNREFUSED');
  });
  it('does not let "word:word" become a search qualifier', () => {
    expect(q('failed at label:thing now')).toBe('failed at label thing now');
  });
});

describe('composeQ / relaxedQueryText', () => {
  it('scopes to the repo and issues, and stays under 256 chars', () => {
    const long = 'word '.repeat(100);
    const out = composeQ(axios, long);
    expect(out.startsWith('repo:axios/axios is:issue ')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(256);
    expect(out.endsWith('word')).toBe(true);
  });
  it('keeps only distinctive words', () => {
    expect(relaxedQueryText("Cannot read properties of undefined reading 'headers'")).toBe('headers');
  });
});

describe('similarity', () => {
  it('scores an exact title match near 1 and flags verbatim', () => {
    const s = similarity(
      "TypeError: Cannot read properties of undefined (reading 'headers')",
      "Cannot read properties of undefined (reading 'headers')",
      'After upgrading…',
    );
    expect(s.verbatim).toBe(true);
    expect(s.score).toBeGreaterThan(0.95);
  });
  it('ranks the specific word above generic ones', () => {
    const query = "TypeError: Cannot read properties of undefined (reading 'headers')";
    const sameShapeOtherProp = similarity(query, "Cannot read properties of undefined (reading 'post')", '');
    const onlySpecific = similarity(query, 'response headers missing', '');
    expect(sameShapeOtherProp.score).toBeLessThan(0.8);
    expect(onlySpecific.title).toBeGreaterThan(0.3);
  });
  it('credits a verbatim body match, but less than a title match', () => {
    const q = 'Error: Unique constraint failed on the fields: (`email`)';
    const body = 'logs:\nUnique constraint failed on the fields: (`email`)\n';
    const vagueTitle = similarity(q, 'Cannot insert data', body);
    expect(vagueTitle.verbatim).toBe(true);
    expect(vagueTitle.score).toBeGreaterThanOrEqual(0.5);
    expect(vagueTitle.score).toBeLessThan(0.6); // below MATCH_THRESHOLD on its own
    const relevantTitle = similarity(q, 'Unique constraint error on email field', body);
    expect(relevantTitle.score).toBeGreaterThan(0.75);
  });
  it('does not trust very short verbatim matches', () => {
    expect(similarity('Error: fetch failed', 'x', 'fetch failed').verbatim).toBe(false);
  });
  it('tokenize/normalizeMessage basics', () => {
    expect(tokenize('axios.get() failed at the /api')).toEqual(['axios', 'get', 'failed', 'api']);
    expect(normalizeMessage("TypeError [ERR_X]: Can't  'x'")).toBe('cant x');
  });
});

describe('anchors: the identifier an error is about', () => {
  it.each([
    ['TypeError: adapter is not a function', 'adapter'],
    ['TypeError: axios.default.create is not a function', 'create'],
    ['TypeError: foo(...) is not a function', 'foo'],
    ['TypeError: Foo is not a constructor', 'Foo'],
    ['ReferenceError: process is not defined', 'process'],
    ['TypeError: items is not iterable', 'items'],
    ["TypeError: Cannot read properties of undefined (reading 'headers')", 'headers'],
    ["TypeError: Cannot read property 'headers' of undefined", 'headers'],
    ["TypeError: Cannot set properties of null (setting 'innerHTML')", 'innerHTML'],
    ["Error: Cannot find module '@babel/preset-env'", '@babel/preset-env'],
    ["Module not found: Can't resolve '@vercel/analytics/react'", '@vercel/analytics/react'],
  ])('%s → %s', (query, term) => {
    expect(extractAnchor(query)?.term).toBe(term);
  });

  it.each(['TypeError: fetch failed', 'Error: connect ECONNREFUSED', 'SyntaxError: Cannot use import statement outside a module'])(
    'no anchor for %s',
    (query) => {
      expect(extractAnchor(query)).toBeUndefined();
    },
  );

  it('accepts both spellings of the "reading" family and both of "(...)"', () => {
    expect(extractAnchor("TypeError: Cannot read properties of undefined (reading 'headers')")!.phrases).toEqual(['reading headers', 'property headers of']);
    expect(extractAnchor('TypeError: foo(...) is not a function')!.phrases).toEqual(['foo is not a function', 'foo(...) is not a function']);
  });

  it('matches at identifier boundaries only', () => {
    expect(mentions('axios.create is not a function', 'create is not a function')).toBe(true);
    expect(mentions('recreate is not a function', 'create is not a function')).toBe(false);
    expect(mentions('$create is not a function', 'create is not a function')).toBe(false);
  });

  it('caps an issue about a different identifier below the match threshold', () => {
    expect(ANCHOR_MISS_CAP).toBeLessThan(MATCH_THRESHOLD);
    // Real case: axios#10908 shares the template and even the word "adapter", but not the bug.
    const other = similarity('TypeError: adapter is not a function', '`socket.setKeepAlive is not a function` from HTTP adapter when using certain proxy agents', '');
    expect(other).toMatchObject({ score: ANCHOR_MISS_CAP, anchor: { term: 'adapter', found: 'none' } });
    const same = similarity("TypeError: Cannot read properties of undefined (reading 'headers')", "Cannot read properties of undefined (reading 'headers')", '');
    expect(same).toMatchObject({ verbatim: true, anchor: { term: 'headers', found: 'title' } });
    expect(same.score).toBeGreaterThan(0.95);
  });

  it('counts an anchor mentioned only in the body', () => {
    const q = 'TypeError: adapter is not a function';
    const title = 'adapter option not working';
    const withPhrase = similarity(q, title, 'Stack:\nTypeError: adapter is not a function\n  at dispatchRequest');
    const without = similarity(q, title, 'Stack:\nTypeError: setKeepAlive is not a function');
    expect(withPhrase.anchor).toEqual({ term: 'adapter', found: 'body' });
    expect(withPhrase.score).toBeGreaterThan(MATCH_THRESHOLD);
    expect(without).toMatchObject({ score: ANCHOR_MISS_CAP, anchor: { found: 'none' } });
  });
});

describe('readRateLimit', () => {
  it('parses GitHub headers', () => {
    expect(
      readRateLimit({
        'x-ratelimit-limit': '10',
        'x-ratelimit-remaining': '9',
        'x-ratelimit-reset': '1790326665',
        'x-ratelimit-resource': 'semantic_search',
      }),
    ).toEqual({ resource: 'semantic_search', limit: 10, remaining: 9, resetAt: '2026-09-25T08:57:45.000Z' });
    expect(readRateLimit({})).toBeUndefined();
  });
});

// Hand-built responses for failure paths that can't be recorded on demand
// (rate limits, GitHub's own silent fallback). Shapes copied from real responses.
function stubFetch(handler: (url: URL) => { status: number; body: unknown; headers?: Record<string, string> }): {
  fetch: FetchLike;
  urls: URL[];
} {
  const urls: URL[] = [];
  const fetch: FetchLike = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    urls.push(url);
    const r = handler(url);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json', ...r.headers },
    });
  };
  return { fetch, urls };
}

const item = (number: number, title: string) => ({
  number,
  title,
  html_url: `https://github.com/axios/axios/issues/${number}`,
  state: 'closed',
  state_reason: 'completed',
  created_at: '2022-10-01T00:00:00Z',
  closed_at: '2022-10-05T00:00:00Z',
  comments: 3,
  body: '',
  labels: [{ name: 'bug' }],
  reactions: { total_count: 4 },
});

describe('searchRepo strategy', () => {
  const parsed = { query: "TypeError: Cannot read properties of undefined (reading 'headers')", errorCodes: [] };

  it('falls back to lexical when hybrid errors (e.g. semantic quota exhausted)', async () => {
    const { fetch, urls } = stubFetch((u) =>
      u.searchParams.get('search_type') === 'hybrid'
        ? {
            status: 403,
            body: { message: 'API rate limit exceeded' },
            headers: { 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790326665', 'x-ratelimit-resource': 'semantic_search' },
          }
        : { status: 200, body: { total_count: 1, search_type: 'lexical', items: [item(5004, "Cannot read properties of undefined (reading 'headers')")] } },
    );
    const r = await searchRepo(createGitHub(createClient(fetch), 'tok'), axios, parsed, { limit: 5 });
    expect(urls.map((u) => u.searchParams.get('search_type'))).toEqual(['hybrid', null]);
    expect(r.modeUsed).toBe('lexical');
    expect(r.attempts[0]!.error).toMatch(/403.*rate limit/);
    expect(r.matches[0]!.number).toBe(5004);
  });

  it('records when GitHub itself degrades hybrid to lexical, with its reasons', async () => {
    const { fetch } = stubFetch(() => ({
      status: 200,
      body: { total_count: 0, search_type: 'lexical', lexical_fallback_reason: ['quoted_text', 'or_boolean_not_supported'], items: [] },
    }));
    const r = await searchRepo(createGitHub(createClient(fetch), 'tok'), axios, parsed, { limit: 5 });
    expect(r.attempts[0]).toMatchObject({ requested: 'hybrid', used: 'lexical', fallbackReasons: ['quoted_text', 'or_boolean_not_supported'] });
  });

  it('skips hybrid without a token and filters out pull requests', async () => {
    const { fetch, urls } = stubFetch(() => ({
      status: 200,
      body: { total_count: 2, search_type: 'lexical', items: [item(1, 'headers bug'), { ...item(2, 'fix headers'), pull_request: {} }] },
    }));
    const r = await searchRepo(createGitHub(createClient(fetch)), axios, parsed, { limit: 5 });
    expect(urls).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({ requested: 'hybrid', skipped: expect.stringMatching(/token/) });
    expect(r.matches.map((m) => m.number)).toEqual([1]);
  });

  it('reports mode "none" when every attempt fails', async () => {
    const { fetch } = stubFetch(() => ({ status: 422, body: { message: 'Validation Failed', errors: [{ message: 'The search query contains invalid syntax.' }] } }));
    const r = await searchRepo(createGitHub(createClient(fetch), 'tok'), axios, parsed, { limit: 5 });
    expect(r.modeUsed).toBe('none');
    expect(r.attempts.map((a) => a.error)).toEqual([
      'HTTP 422: Validation Failed — The search query contains invalid syntax.',
      'HTTP 422: Validation Failed — The search query contains invalid syntax.',
    ]);
  });
});

describe('resolveToken', () => {
  it('prefers GITHUB_TOKEN, then GH_TOKEN, then gh', async () => {
    const gh = async () => 'from-gh';
    expect(await resolveToken({ GITHUB_TOKEN: 'a', GH_TOKEN: 'b' }, gh)).toMatchObject({ token: 'a', source: 'GITHUB_TOKEN' });
    expect(await resolveToken({ GH_TOKEN: 'b' }, gh)).toMatchObject({ token: 'b', source: 'GH_TOKEN' });
    expect(await resolveToken({}, gh)).toMatchObject({ token: 'from-gh', source: 'gh auth token' });
  });
  it('explains every step when nothing works', async () => {
    const missing = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    const r = await resolveToken({}, () => Promise.reject(missing));
    expect(r).toEqual({ source: 'none', tried: ['GITHUB_TOKEN: not set', 'GH_TOKEN: not set', 'gh auth token: gh CLI not installed'] });
  });
});
