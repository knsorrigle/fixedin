/**
 * Octokit instances wired to the shared NetClient, so GitHub traffic is
 * recorded/replayed exactly like registry traffic.
 */
import { Octokit } from '@octokit/rest';
import type { NetClient } from '../net/client.js';

export interface GitHub {
  rest: Octokit;
  authenticated: boolean;
}

export function createGitHub(client: NetClient, token?: string): GitHub {
  const rest = new Octokit({
    ...(token ? { auth: token } : {}),
    userAgent: 'fixedin',
    request: { fetch: client.fetch },
    // Octokit logs deprecation notices via console.warn; route them through
    // our own diagnostics instead of printing mid-output.
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
  return { rest, authenticated: Boolean(token) };
}

/** Pull a readable message out of an Octokit RequestError. */
export function describeGitHubError(err: unknown): { status?: number; message: string } {
  const e = err as {
    status?: number;
    message?: string;
    response?: { data?: { message?: string; errors?: Array<{ message?: string } | string> } };
  };
  // 422s carry the useful part in errors[].message ("The search query contains invalid syntax.")
  const details = (e.response?.data?.errors ?? [])
    .map((x) => (typeof x === 'string' ? x : x.message))
    .filter(Boolean);
  const apiMessage = [e.response?.data?.message, ...details].filter(Boolean).join(' — ');
  return {
    ...(e.status ? { status: e.status } : {}),
    message: apiMessage ? `HTTP ${e.status}: ${apiMessage}` : (e.message ?? String(err)),
  };
}
