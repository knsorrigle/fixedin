/**
 * Rate-limit aware fetch wrapper.
 *
 * GitHub has separate buckets per resource (core 5000/h, search 30/min,
 * semantic_search 10/min, graphql 5000 points/h). We track the latest
 * x-ratelimit-* headers per bucket and:
 *   - before a request, if its bucket is known to be empty and resets soon, wait
 *   - on 403/429 with remaining=0 or retry-after (primary or secondary limit), wait and retry
 *   - on 502/503/504 or a network error, retry with exponential backoff
 * Waits longer than `maxWaitMs` are not taken: the error response is returned
 * so the caller can report when the quota resets.
 */
import type { FetchLike } from './client.js';

export interface QuotaInfo {
  resource: string;
  limit: number;
  remaining: number;
  /** Epoch ms. */
  resetAt: number;
}

export interface RateLimitOptions {
  /** Longest single wait we're willing to do (default 60s). */
  maxWaitMs?: number;
  /** Retries for 5xx / network errors (default 2). */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called whenever we wait, so the CLI can say why it's slow. */
  onWait?: (ms: number, reason: string) => void;
}

export interface RateLimiter {
  fetch: FetchLike;
  quotas: Map<string, QuotaInfo>;
}

/** Which GitHub bucket a request draws from (matches x-ratelimit-resource). */
export function resourceFor(url: string): string | undefined {
  const u = new URL(url);
  if (u.hostname !== 'api.github.com') return undefined;
  if (u.pathname === '/graphql') return 'graphql';
  if (u.pathname.startsWith('/search/')) {
    const t = u.searchParams.get('search_type');
    return t === 'hybrid' || t === 'semantic' ? 'semantic_search' : 'search';
  }
  return 'core';
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function rateLimitedFetch(inner: FetchLike, opts: RateLimitOptions = {}): RateLimiter {
  const maxWait = opts.maxWaitMs ?? 60_000;
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const quotas = new Map<string, QuotaInfo>();

  const record = (res: Response, fallbackResource?: string) => {
    const limit = res.headers.get('x-ratelimit-limit');
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    const resource = res.headers.get('x-ratelimit-resource') ?? fallbackResource;
    if (limit && remaining && reset && resource) {
      quotas.set(resource, { resource, limit: Number(limit), remaining: Number(remaining), resetAt: Number(reset) * 1000 });
    }
  };

  const fetch: FetchLike = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const resource = resourceFor(url);

    // Pre-emptive wait when we already know the bucket is empty.
    const q = resource ? quotas.get(resource) : undefined;
    if (q && q.remaining <= 0) {
      const wait = q.resetAt - now() + 1000;
      if (wait > 0 && wait <= maxWait) {
        opts.onWait?.(wait, `GitHub ${resource} quota exhausted`);
        await sleep(wait);
      }
    }

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await inner(input instanceof Request ? input.clone() : input, init);
      } catch (err) {
        if (attempt >= retries) throw err;
        const wait = 500 * 2 ** attempt;
        opts.onWait?.(wait, `network error (${(err as Error).message}), retrying`);
        await sleep(wait);
        continue;
      }
      record(res, resource);

      if (res.status === 403 || res.status === 429) {
        const wait = await limitWait(res, now);
        if (wait !== undefined && attempt < retries) {
          if (wait > maxWait) return res; // too long — let the caller report the reset time
          const bucket = res.headers.get('x-ratelimit-resource') ?? resource;
          opts.onWait?.(wait, bucket ? `GitHub ${bucket} rate limit hit` : `rate limited by ${new URL(url).hostname}`);
          await sleep(wait);
          continue;
        }
        return res;
      }
      if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < retries) {
        const wait = 1000 * 2 ** attempt;
        opts.onWait?.(wait, `HTTP ${res.status} from ${new URL(url).hostname}, retrying`);
        await sleep(wait);
        continue;
      }
      return res;
    }
  };

  return { fetch, quotas };
}

/** ms to wait before retrying a 403/429, or undefined if it isn't a rate limit. */
async function limitWait(res: Response, now: () => number): Promise<number | undefined> {
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = res.headers.get('x-ratelimit-reset');
  if (remaining === '0' && reset) return Math.max(0, Number(reset) * 1000 - now()) + 1000;
  // Secondary limits sometimes come without headers; the body says so.
  const text = await res.clone().text().catch(() => '');
  if (/secondary rate limit/i.test(text)) return 60_000;
  return undefined;
}
