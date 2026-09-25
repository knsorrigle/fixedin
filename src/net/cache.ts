/**
 * Disk cache for HTTP GETs (and GraphQL POSTs), keyed by method + URL + body.
 *
 * Lifetimes:
 *   compare between two commit SHAs   forever (both ends are immutable)
 *   compare involving a tag/branch    24h
 *   issue search                      24h
 *   everything else                   1h   (packuments, timelines, comments, repo lookups)
 * Only 2xx responses are cached. Auth headers never enter the key or the file.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { slimFixtureBody, type FetchLike } from './client.js';

export const FOREVER = Number.POSITIVE_INFINITY;
const HOUR = 3_600_000;

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FIXEDIN_CACHE_DIR) return env.FIXEDIN_CACHE_DIR;
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'fixedin');
}

const SHA = /^[0-9a-f]{40}$/i;

/** How long a response for this request may be reused, in ms (0 = don't cache). */
export function ttlFor(method: string, url: string): number {
  const u = new URL(url);
  if (u.hostname === 'api.github.com') {
    const compare = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/compare\/(.+)$/);
    if (compare) {
      const [base, head] = decodeURIComponent(compare[1]!).split('...');
      return base && head && SHA.test(base) && SHA.test(head) ? FOREVER : 24 * HOUR;
    }
    if (u.pathname === '/search/issues') return 24 * HOUR;
    if (u.pathname === '/graphql' && method === 'POST') return HOUR;
  }
  return method === 'GET' ? HOUR : 0;
}

interface CacheEntry {
  key: string;
  storedAt: number;
  ttl: number | null; // null = forever (JSON has no Infinity)
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface CacheStats {
  hits: number;
  misses: number;
  writes: number;
  errors: string[];
}

export function cachingFetch(
  inner: FetchLike,
  dir: string,
  opts: { now?: () => number; onHit?: (url: string) => void } = {},
): { fetch: FetchLike; stats: CacheStats } {
  const now = opts.now ?? Date.now;
  const stats: CacheStats = { hits: 0, misses: 0, writes: 0, errors: [] };
  let dirReady = false;

  const fetch: FetchLike = async (input, init) => {
    const req = input instanceof Request ? input : undefined;
    const url = req ? req.url : input.toString();
    const method = (init?.method ?? req?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const ttl = ttlFor(method, url);
    if (ttl === 0 || (method !== 'GET' && body === undefined)) return inner(input, init);

    const key = `${method} ${url}\n${body ?? ''}`;
    const file = join(dir, `${createHash('sha256').update(key).digest('hex')}.json`);

    try {
      const entry = JSON.parse(readFileSync(file, 'utf8')) as CacheEntry;
      const maxAge = entry.ttl ?? FOREVER;
      if (entry.key === key && now() - entry.storedAt < maxAge) {
        stats.hits++;
        opts.onHit?.(url);
        return new Response(entry.body, { status: entry.status, headers: { ...entry.headers, 'x-fixedin-cache': 'hit' } });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') stats.errors.push(`read ${file}: ${(err as Error).message}`);
    }

    stats.misses++;
    const res = await inner(input, init);
    if (res.ok) {
      try {
        const text = await res.clone().text();
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          if (!/^(set-cookie|authorization|content-length|content-encoding|transfer-encoding)$/i.test(k)) headers[k] = v;
        });
        if (!dirReady) {
          mkdirSync(dir, { recursive: true });
          dirReady = true;
        }
        // Same field-dropping as fixtures: a compare is ~470KB for one `status`.
        const entry: CacheEntry = { key, storedAt: now(), ttl: ttl === FOREVER ? null : ttl, status: res.status, headers, body: slimFixtureBody(url, text) };
        // Write-then-rename so a crash never leaves a half-written entry.
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(entry));
        renameSync(tmp, file);
        stats.writes++;
      } catch (err) {
        stats.errors.push(`write ${file}: ${(err as Error).message}`);
      }
    }
    return res;
  };
  return { fetch, stats };
}
