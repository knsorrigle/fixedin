/**
 * One end-to-end test per verdict, replaying real GitHub + npm responses
 * recorded with FIXEDIN_RECORD=tests/fixtures/http. No network.
 *
 * The demo case is axios/axios#5011: `require('axios').default.create()`
 * threw "Cannot read properties of undefined (reading 'create')" in 1.0.x.
 * Closed by PR #5162 (merge commit 0c3a1e9), first released in 1.2.0.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuthResult } from '../src/github/auth.js';
import { createClient, replayFetch } from '../src/net/client.js';
import { formatVerdicts } from '../src/output/terminal.js';
import { run } from '../src/pipeline.js';

const fixtures = join(import.meta.dirname, 'fixtures');
const client = createClient(replayFetch(join(fixtures, 'http')));
const project = (name: string) => join(fixtures, 'projects', name);
const stack = (n: string) => readFileSync(join(fixtures, 'stacks', `${n}.txt`), 'utf8');
const auth: AuthResult = { token: 'test-token', source: 'GITHUB_TOKEN', tried: [] };
const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

describe('verdicts end-to-end (recorded)', () => {
  it('FIXED_UPSTREAM_UPGRADE: axios 1.1.3 → upgrade to >=1.2.0', async () => {
    const cwd = project('axios-1.1.3');
    const r = await run(stack('axios-default-create'), { cwd, client, limit: 5, auth, repo: 'axios/axios' });
    const v = r.verdicts[0]!;
    expect(v).toMatchObject({
      kind: 'FIXED_UPSTREAM_UPGRADE',
      packageName: 'axios',
      installed: { version: '1.1.3' },
      match: { number: 5011, state: 'closed' },
      fix: { kind: 'pull_request', number: 5162, sha: '0c3a1e9fde4dd309e82d719b256907eb5cba591b', evidence: 'closed-by-pr' },
      fixedIn: '1.2.0',
      installedHasFix: 'missing',
      advice: 'Upgrade to >=1.2.0',
    });
    const out = strip(formatVerdicts(r, cwd, 5));
    expect(out).toContain('Matched: axios/axios#5011 (closed)');
    expect(out).toContain('Fixed by: PR #5162 → shipped in v1.2.0');
    expect(out).toContain('You have: 1.1.3 (from package-lock.json)');
    expect(out).toContain('→ Upgrade to >=1.2.0');
  });

  it('FIXED_UPSTREAM_UPGRADE from an npm 6 (lockfileVersion 1) project', async () => {
    const r = await run(stack('axios-default-create'), { cwd: project('npm6-v1'), client, limit: 5, auth, repo: 'axios/axios' });
    expect(r.verdicts[0]).toMatchObject({ kind: 'FIXED_UPSTREAM_UPGRADE', installed: { version: '1.1.3', location: 'node_modules/axios' }, fixedIn: '1.2.0' });
  });

  it('ALREADY_HAVE_FIX: axios 1.5.0 already contains the fix → probably a different bug', async () => {
    const r = await run(stack('axios-default-create'), { cwd: project('axios-app'), client, limit: 5, auth, repo: 'axios/axios' });
    expect(r.verdicts[0]).toMatchObject({
      kind: 'ALREADY_HAVE_FIX',
      installed: { version: '1.5.0' },
      fixedIn: '1.2.0',
      installedHasFix: 'contains',
      advice: expect.stringContaining('likely a different bug'),
    });
  });

  it('OPEN_ISSUE: surfaces the code-block comment with the most reactions as a workaround', async () => {
    const r = await run('AxiosError toJSON skips response', { cwd: project('axios-app'), client, limit: 5, auth, repo: 'axios/axios' });
    expect(r.verdicts[0]).toMatchObject({
      kind: 'OPEN_ISSUE',
      match: { number: 4836, state: 'open' },
      workaround: { author: 'meteorlxy', hasCode: true, reactions: 7 },
    });
    expect(r.verdicts[0]!.workaround!.excerpt).toContain('```ts');
  });

  it('NO_MATCH: nothing above the similarity threshold', async () => {
    const r = await run('TypeError: frobnicator quantum flux capacitor overheated in zorgblatt', {
      cwd: project('axios-app'),
      client,
      limit: 5,
      auth,
      repo: 'axios/axios',
    });
    expect(r.verdicts[0]!.kind).toBe('NO_MATCH');
  });

  it('CLOSED_NO_FIX_FOUND: axios#5004 was closed manually; weaker matches about other bugs are not used', async () => {
    const r = await run(stack('axios-headers'), { cwd: project('axios-app'), client, limit: 5, auth });
    const v = r.verdicts[0]!;
    expect(v).toMatchObject({ kind: 'CLOSED_NO_FIX_FOUND', match: { number: 5004 } });
    expect(v.reasons.join(' ')).toMatch(/Closed manually/);
    // #5011 has a traceable fix, but it's about reading 'create', not 'headers'.
    expect(v.fix).toBeUndefined();
  });

  it('an issue about a different missing module is not a match (babel-loader#664 is about @babel/core)', async () => {
    const r = await run(stack('webpack-loader'), { cwd: project('axios-app'), client, limit: 5, auth });
    const loader = r.verdicts.find((v) => v.packageName === 'babel-loader')!;
    expect(loader.kind).toBe('NO_MATCH');
    const hit664 = r.searches.find((s) => s.repo.repo === 'babel-loader')!.matches.find((m) => m.number === 664);
    expect(hit664?.similarity.anchor).toEqual({ term: '@babel/preset-env', found: 'none' });
  });

  it('prisma: searches the renamed repo and flags a borderline match as weak', async () => {
    const cwd = project('axios-app');
    const r = await run(stack('prisma-p2002'), { cwd, client, limit: 5, auth });
    expect(r.searches[0]!.repo).toMatchObject({ owner: 'prisma', repo: 'orm' });
    expect(r.verdicts[0]).toMatchObject({ kind: 'OPEN_ISSUE', match: { number: 25081 } });
    expect(strip(formatVerdicts(r, cwd, 5))).toContain('weak match');
  });
});
