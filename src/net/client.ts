import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every network call in fixedin goes through a `NetClient`. Octokit is handed
 * `client.fetch` as its fetch implementation, so swapping the client swaps
 * *all* traffic — which is how tests replay recorded fixtures.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface NetClient {
  fetch: FetchLike;
  /** Fetch JSON with a clear error on non-2xx. */
  getJson<T = unknown>(url: string, init?: RequestInit): Promise<T>;
}

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly bodySnippet: string,
  ) {
    super(`GET ${url} → HTTP ${status}${bodySnippet ? `: ${bodySnippet}` : ''}`);
    this.name = 'HttpError';
  }
}

export function createClient(fetchImpl: FetchLike): NetClient {
  return {
    fetch: fetchImpl,
    async getJson<T>(url: string, init?: RequestInit): Promise<T> {
      let res: Response;
      try {
        res = await fetchImpl(url, init);
      } catch (err) {
        throw new Error(`Network request failed: GET ${url} (${(err as Error).message})`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new HttpError(url, res.status, text.slice(0, 200));
      }
      return (await res.json()) as T;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture recording / replay
// ---------------------------------------------------------------------------

export interface RecordedExchange {
  request: { method: string; url: string; body?: string };
  response: { status: number; headers: Record<string, string>; body: string };
}

/** Stable key for a request: method + URL + body. Auth headers are ignored. */
export function fixtureKey(method: string, url: string, body?: string): string {
  const hash = createHash('sha256')
    .update(`${method.toUpperCase()} ${url}\n${body ?? ''}`)
    .digest('hex')
    .slice(0, 16);
  const slug = url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .slice(0, 80);
  return `${slug}__${hash}`;
}

async function describeRequest(input: string | URL | Request, init?: RequestInit) {
  const req = input instanceof Request ? input : undefined;
  const url = req ? req.url : input.toString();
  const method = (init?.method ?? req?.method ?? 'GET').toUpperCase();
  let body: string | undefined;
  if (typeof init?.body === 'string') body = init.body;
  else if (req && method !== 'GET' && method !== 'HEAD') body = await req.clone().text();
  return { url, method, body };
}

/**
 * Drop fields fixedin never reads from bulky responses, so fixtures stay
 * reviewable. Only whole fields are removed; nothing is rewritten.
 *   compare:   ~470KB of files/commits → status counts
 *   packument: readme, per-version dependency trees → version, gitHead, time
 */
export function slimFixtureBody(url: string, body: string): string {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return body;
  }
  if (/api\.github\.com\/repos\/[^/]+\/[^/]+\/compare\//.test(url) && 'status' in json) {
    const { status, ahead_by, behind_by, total_commits } = json;
    return JSON.stringify({ status, ahead_by, behind_by, total_commits });
  }
  if (/^https:\/\/registry\.npmjs\.org\/[^/]+(%2[fF][^/]+)?$/.test(url) && json.versions && typeof json.versions === 'object') {
    const versions: Record<string, unknown> = {};
    for (const [v, m] of Object.entries(json.versions as Record<string, Record<string, unknown>>)) {
      versions[v] = { version: m.version, ...(m.gitHead ? { gitHead: m.gitHead } : {}), ...(m.repository ? { repository: m.repository } : {}) };
    }
    return JSON.stringify({ name: json.name, 'dist-tags': json['dist-tags'], versions, time: json.time });
  }
  return body;
}

/** Wraps a fetch so every exchange is written to `dir` as a JSON fixture. */
export function recordingFetch(inner: FetchLike, dir: string): FetchLike {
  mkdirSync(dir, { recursive: true });
  return async (input, init) => {
    const { url, method, body } = await describeRequest(input, init);
    const res = await inner(input, init);
    const text = await res.clone().text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      // Body may be slimmed and is stored decoded, so length/encoding headers would lie.
      if (!/^(set-cookie|authorization|content-length|content-encoding|transfer-encoding)$/i.test(k)) headers[k] = v;
    });
    const exchange: RecordedExchange = {
      request: { method, url, ...(body ? { body } : {}) },
      response: { status: res.status, headers, body: slimFixtureBody(url, text) },
    };
    writeFileSync(join(dir, `${fixtureKey(method, url, body)}.json`), JSON.stringify(exchange, null, 2));
    return res;
  };
}

/** A fetch that only serves recorded fixtures and throws on anything unrecorded. */
export function replayFetch(dir: string): FetchLike {
  return async (input, init) => {
    const { url, method, body } = await describeRequest(input, init);
    const file = join(dir, `${fixtureKey(method, url, body)}.json`);
    if (!existsSync(file)) {
      throw new Error(`No recorded fixture for ${method} ${url} (expected ${file}). Tests must not hit the network.`);
    }
    const ex = JSON.parse(readFileSync(file, 'utf8')) as RecordedExchange;
    return new Response(ex.response.status === 204 || ex.response.status === 304 ? null : ex.response.body, {
      status: ex.response.status,
      headers: ex.response.headers,
    });
  };
}

/**
 * Default client for the CLI. `FIXEDIN_RECORD=<dir>` records all traffic;
 * `FIXEDIN_REPLAY=<dir>` serves only from recordings (used by e2e tests).
 */
export function defaultClient(env: NodeJS.ProcessEnv = process.env): NetClient {
  let f: FetchLike = globalThis.fetch.bind(globalThis);
  if (env.FIXEDIN_REPLAY) f = replayFetch(env.FIXEDIN_REPLAY);
  else if (env.FIXEDIN_RECORD) f = recordingFetch(f, env.FIXEDIN_RECORD);
  return createClient(f);
}
