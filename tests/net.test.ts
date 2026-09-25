import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cachingFetch, FOREVER, ttlFor } from '../src/net/cache.js';
import type { FetchLike } from '../src/net/client.js';
import { rateLimitedFetch, resourceFor } from '../src/net/ratelimit.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function counter(responses: Array<() => Response>): { fetch: FetchLike; calls: () => number } {
  let n = 0;
  return {
    fetch: async () => {
      const r = responses[Math.min(n, responses.length - 1)]!();
      n++;
      return r;
    },
    calls: () => n,
  };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('ttlFor', () => {
  it('caches compares between two SHAs forever, tag compares for a day', () => {
    expect(ttlFor('GET', `https://api.github.com/repos/a/b/compare/${SHA_A}...${SHA_B}?per_page=1`)).toBe(FOREVER);
    expect(ttlFor('GET', `https://api.github.com/repos/a/b/compare/${SHA_A}...v1.2.0`)).toBe(86_400_000);
  });
  it('search 24h, graphql 1h, registry 1h, other POSTs never', () => {
    expect(ttlFor('GET', 'https://api.github.com/search/issues?q=x')).toBe(86_400_000);
    expect(ttlFor('POST', 'https://api.github.com/graphql')).toBe(3_600_000);
    expect(ttlFor('GET', 'https://registry.npmjs.org/axios')).toBe(3_600_000);
    expect(ttlFor('POST', 'https://example.com/x')).toBe(0);
  });
});

describe('cachingFetch', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'fixedin-cache-'));

  it('serves a hit without calling the network, until the TTL expires', async () => {
    let t = 1_000_000;
    const inner = counter([() => json({ n: 1 })]);
    const d = dir();
    const { fetch, stats } = cachingFetch(inner.fetch, d, { now: () => t });
    const url = 'https://api.github.com/search/issues?q=x';
    await fetch(url);
    const second = await fetch(url);
    expect(await second.json()).toEqual({ n: 1 });
    expect(second.headers.get('x-fixedin-cache')).toBe('hit');
    expect(inner.calls()).toBe(1);
    t += 86_400_001;
    await fetch(url);
    expect(inner.calls()).toBe(2);
    expect(stats).toMatchObject({ hits: 1, misses: 2, writes: 2 });
  });

  it('keeps SHA compares forever and stores only their status fields', async () => {
    let t = 0;
    const inner = counter([() => json({ status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1, files: [{ huge: true }] })]);
    const d = dir();
    const { fetch } = cachingFetch(inner.fetch, d, { now: () => t });
    const url = `https://api.github.com/repos/a/b/compare/${SHA_A}...${SHA_B}`;
    await fetch(url);
    t = 10 * 365 * 86_400_000;
    const again = await fetch(url);
    expect(inner.calls()).toBe(1);
    expect(await again.json()).toEqual({ status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1 });
  });

  it('does not cache errors', async () => {
    const inner = counter([() => json({ message: 'nope' }, 500)]);
    const { fetch } = cachingFetch(inner.fetch, dir());
    await fetch('https://registry.npmjs.org/x');
    await fetch('https://registry.npmjs.org/x');
    expect(inner.calls()).toBe(2);
  });

  it('keys GraphQL POSTs by body', async () => {
    const inner = counter([() => json({ data: 1 })]);
    const { fetch } = cachingFetch(inner.fetch, dir());
    const post = (body: string) => fetch('https://api.github.com/graphql', { method: 'POST', body });
    await post('{"q":1}');
    await post('{"q":1}');
    await post('{"q":2}');
    expect(inner.calls()).toBe(2);
  });

  it('reports (does not swallow) a corrupt cache entry, then refetches', async () => {
    const d = dir();
    const inner = counter([() => json({ ok: true })]);
    const { fetch, stats } = cachingFetch(inner.fetch, d);
    const url = 'https://registry.npmjs.org/y';
    await fetch(url);
    writeFileSync(join(d, readdirSync(d)[0]!), '{broken');
    await fetch(url);
    expect(inner.calls()).toBe(2);
    expect(stats.errors[0]).toMatch(/^read .*json/);
  });
});

describe('rateLimitedFetch', () => {
  const fake = () => {
    let t = 1_700_000_000_000;
    const waits: Array<[number, string]> = [];
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      onWait: (ms: number, why: string) => waits.push([ms, why]),
      waits,
    };
  };
  const limited = (resetInSec: number, now: number, resource = 'search') =>
    json({ message: 'API rate limit exceeded' }, 403, {
      'x-ratelimit-limit': '30',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.floor(now / 1000) + resetInSec),
      'x-ratelimit-resource': resource,
    });

  it('maps URLs to GitHub buckets', () => {
    expect(resourceFor('https://api.github.com/search/issues?q=x&search_type=hybrid')).toBe('semantic_search');
    expect(resourceFor('https://api.github.com/search/issues?q=x')).toBe('search');
    expect(resourceFor('https://api.github.com/graphql')).toBe('graphql');
    expect(resourceFor('https://api.github.com/repos/a/b')).toBe('core');
    expect(resourceFor('https://registry.npmjs.org/a')).toBeUndefined();
  });

  it('waits for the reset on a primary rate limit, then retries', async () => {
    const f = fake();
    const inner = counter([() => limited(20, f.now()), () => json({ ok: 1 })]);
    const { fetch, quotas } = rateLimitedFetch(inner.fetch, f);
    const res = await fetch('https://api.github.com/search/issues?q=x');
    expect(res.status).toBe(200);
    expect(f.waits[0]![1]).toBe('GitHub search rate limit hit');
    expect(f.waits[0]![0]).toBeGreaterThan(19_000);
    expect(quotas.get('search')?.remaining).toBe(0);
  });

  it('honours retry-after on secondary limits', async () => {
    const f = fake();
    const inner = counter([() => json({ message: 'You have exceeded a secondary rate limit' }, 403, { 'retry-after': '5' }), () => json({})]);
    const { fetch } = rateLimitedFetch(inner.fetch, f);
    expect((await fetch('https://api.github.com/repos/a/b')).status).toBe(200);
    expect(f.waits[0]![0]).toBe(5000);
  });

  it('gives up immediately when the reset is beyond maxWait, returning the 403', async () => {
    const f = fake();
    const inner = counter([() => limited(3600, f.now(), 'core')]);
    const { fetch } = rateLimitedFetch(inner.fetch, { ...f, maxWaitMs: 60_000 });
    expect((await fetch('https://api.github.com/repos/a/b')).status).toBe(403);
    expect(inner.calls()).toBe(1);
    expect(f.waits).toEqual([]);
  });

  it('waits pre-emptively when the bucket is known to be empty', async () => {
    const f = fake();
    const inner = counter([
      () => json({}, 200, { 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(f.now() / 1000) + 30), 'x-ratelimit-resource': 'semantic_search' }),
      () => json({}),
    ]);
    const { fetch } = rateLimitedFetch(inner.fetch, f);
    const hybrid = 'https://api.github.com/search/issues?q=x&search_type=hybrid';
    await fetch(hybrid);
    await fetch(hybrid);
    expect(f.waits).toEqual([[expect.any(Number), 'GitHub semantic_search quota exhausted']]);
  });

  it('retries 5xx with backoff and does not retry 404', async () => {
    const f = fake();
    const flaky = counter([() => json({}, 502), () => json({}, 503), () => json({ ok: 1 })]);
    expect((await rateLimitedFetch(flaky.fetch, f).fetch('https://registry.npmjs.org/a')).status).toBe(200);
    expect(f.waits.map((w) => w[0])).toEqual([1000, 2000]);
    const missing = counter([() => json({}, 404)]);
    await rateLimitedFetch(missing.fetch, f).fetch('https://registry.npmjs.org/a');
    expect(missing.calls()).toBe(1);
  });

  it('rethrows network errors after retries', async () => {
    const f = fake();
    const boom: FetchLike = async () => {
      throw new Error('ECONNRESET');
    };
    await expect(rateLimitedFetch(boom, f).fetch('https://registry.npmjs.org/a')).rejects.toThrow('ECONNRESET');
    expect(f.waits).toHaveLength(2);
  });
});
