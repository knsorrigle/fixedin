/**
 * JSR (jsr.io) packages, next to npm.
 *
 * Named "jsr:@scope/name" throughout fixedin, so they never collide with an npm
 * package of the same name. The same package installed through npm's JSR
 * compatibility layer is "@jsr/scope__name".
 *
 *   repo:      api.jsr.io/scopes/{scope}/packages/{name} → githubRepository
 *   releases:  jsr.io/@scope/name/meta.json → versions and their publish times
 *   commits:   JSR has no gitHead, but a version published from GitHub Actions
 *              carries a Sigstore provenance statement (rekorLogId) naming the
 *              exact commit it was built from. Looked up only for the versions
 *              the release search probes; the rest fall back to git tags.
 */
import type { NetClient } from './net/client.js';
import type { Packument } from './release/index.js';
import { ResolveError, type ResolvedRepo } from './resolve/index.js';

export interface JsrPackage {
  scope: string;
  name: string;
  /** "@scope/name" */
  full: string;
}

/** "jsr:@std/path" or npm's "@jsr/std__path" → the JSR package; anything else → undefined. */
export function jsrPackage(name: string): JsrPackage | undefined {
  const m = name.match(/^jsr:@([a-z0-9-]+)\/([a-z0-9-]+)$/) ?? name.match(/^@jsr\/([a-z0-9-]+)__([a-z0-9-]+)$/);
  return m ? { scope: m[1]!, name: m[2]!, full: `@${m[1]}/${m[2]}` } : undefined;
}

export const isJsr = (name: string) => jsrPackage(name) !== undefined;

const API = 'https://api.jsr.io';

export async function resolveJsrRepo(client: NetClient, name: string): Promise<ResolvedRepo> {
  const p = jsrPackage(name)!;
  const url = `${API}/scopes/${p.scope}/packages/${p.name}`;
  let meta: { githubRepository?: { owner: string; name: string } | null };
  try {
    meta = await client.getJson(url);
  } catch (err) {
    throw new ResolveError(name, `Could not fetch JSR metadata for ${p.full}: ${(err as Error).message}`, [url]);
  }
  const gh = meta.githubRepository;
  if (!gh) throw new ResolveError(name, `${p.full} on JSR isn't linked to a GitHub repository, so its issues can't be searched. Pass --repo owner/name.`, [url]);
  return { owner: gh.owner, repo: gh.name, via: 'jsr', raw: `https://github.com/${gh.owner}/${gh.name}` };
}

interface JsrMeta {
  latest?: string;
  versions: Record<string, { createdAt?: string; yanked?: boolean }>;
}

/** A JSR package's versions in the npm packument shape the release search reads. */
export async function fetchJsrPackument(client: NetClient, name: string): Promise<Packument> {
  const p = jsrPackage(name)!;
  const meta = await client.getJson<JsrMeta>(`https://jsr.io/${p.full}/meta.json`);
  const versions: Packument['versions'] = {};
  const time: Record<string, string> = {};
  for (const [v, info] of Object.entries(meta.versions)) {
    versions[v] = { version: v, ...(info.yanked ? { deprecated: 'yanked on JSR' } : {}) };
    if (info.createdAt) time[v] = info.createdAt;
  }
  return {
    name: p.full,
    versions,
    time,
    ...(meta.latest ? { 'dist-tags': { latest: meta.latest } } : {}),
    gitHeadOf: (version) => provenanceCommit(client, p, version),
  };
}

interface RekorEntry {
  attestation?: { data?: string };
}

/** The commit a version was built from, per its provenance statement; undefined without one. */
export async function provenanceCommit(client: NetClient, p: JsrPackage, version: string): Promise<string | undefined> {
  const info = await client.getJson<{ rekorLogId?: string | null }>(`${API}/scopes/${p.scope}/packages/${p.name}/versions/${version}`);
  if (!info.rekorLogId) return undefined;
  const entries = await client.getJson<Record<string, RekorEntry>>(`https://rekor.sigstore.dev/api/v1/log/entries?logIndex=${info.rekorLogId}`);
  const data = Object.values(entries)[0]?.attestation?.data;
  if (!data) return undefined;
  const statement = JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as {
    subject?: Array<{ name?: string }>;
    predicate?: { buildDefinition?: { resolvedDependencies?: Array<{ digest?: { gitCommit?: string } }> } };
  };
  // The statement must be about this exact version, or it proves nothing about it.
  if (!statement.subject?.some((s) => s.name === `pkg:jsr/${p.full}@${version}`)) return undefined;
  return statement.predicate?.buildDefinition?.resolvedDependencies?.find((d) => d.digest?.gitCommit)?.digest?.gitCommit;
}
