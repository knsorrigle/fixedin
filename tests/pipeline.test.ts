import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuthResult } from '../src/github/auth.js';
import { createClient, replayFetch } from '../src/net/client.js';
import { run } from '../src/pipeline.js';

// Replays real GitHub + npm responses recorded with FIXEDIN_RECORD=tests/fixtures/http.
const fixtures = join(import.meta.dirname, 'fixtures');
const client = createClient(replayFetch(join(fixtures, 'http')));
const cwd = join(fixtures, 'projects/axios-app');
const stack = (n: string) => readFileSync(join(fixtures, 'stacks', `${n}.txt`), 'utf8');
const authed: AuthResult = { token: 'test-token', source: 'GITHUB_TOKEN', tried: [] };
const anon: AuthResult = { source: 'none', tried: ['GITHUB_TOKEN: not set'] };

describe('run: detect → search (recorded)', () => {
  it('axios: hybrid search puts the exact issue first', async () => {
    const r = await run(stack('axios-headers'), { cwd, client, limit: 5, auth: authed });
    const s = r.searches[0]!;
    expect(s.repo).toEqual({ owner: 'axios', repo: 'axios' });
    expect(s.modeUsed).toBe('hybrid');
    expect(s.packages).toEqual(['axios']);
    expect(s.matches[0]).toMatchObject({ number: 5004, state: 'closed', similarity: { verbatim: true } });
    expect(s.matches[0]!.similarity.score).toBeGreaterThan(0.9);
    expect(s.matches).toHaveLength(5);
  });

  it('prisma: follows the prisma/prisma → prisma/orm rename before searching', async () => {
    const r = await run(stack('prisma-p2002'), { cwd, client, limit: 3, auth: authed });
    expect(r.searches[0]!.repo).toMatchObject({ owner: 'prisma', repo: 'orm', directory: 'packages/client' });
    expect(r.searches[0]!.modeUsed).toBe('hybrid');
    expect(r.detect.diagnostics.items).toContainEqual(
      expect.objectContaining({ stage: 'resolve', message: expect.stringContaining('renamed to prisma/orm') }),
    );
  });

  it('vite: an empty hybrid result triggers a relaxed lexical retry but still reports hybrid', async () => {
    const r = await run(stack('vite-esm'), { cwd, client, limit: 3, auth: authed });
    const plugin = r.searches.find((s) => s.repo.repo === 'vite-plugin-react')!;
    expect(plugin.attempts.map((a) => a.requested)).toEqual(['hybrid', 'lexical']);
    expect(plugin.modeUsed).toBe('hybrid');
    expect(plugin.matches).toEqual([]);
    expect(r.searches.find((s) => s.repo.repo === 'vite')!.matches.length).toBe(3);
  });

  it('unauthenticated: warns once and uses lexical search', async () => {
    const r = await run(stack('axios-headers'), { cwd, client, limit: 5, auth: anon });
    expect(r.searches[0]!.modeUsed).toBe('lexical');
    expect(r.searches[0]!.matches[0]!.number).toBe(5004);
    const warns = r.detect.diagnostics.items.filter((d) => d.level === 'warn');
    expect(warns).toEqual([
      expect.objectContaining({ stage: 'auth', tried: ['GITHUB_TOKEN: not set'] }),
      expect.objectContaining({ stage: 'trace', message: expect.stringContaining('requires a GitHub token') }),
    ]);
    expect(r.verdicts[0]).toMatchObject({ kind: 'CLOSED_NO_FIX_FOUND', match: { number: 5004 } });
  });

  it('--repo searches only that repo', async () => {
    const r = await run(stack('axios-headers'), { cwd, client, limit: 5, auth: authed, repo: 'axios/axios' });
    expect(r.searches.map((s) => `${s.repo.owner}/${s.repo.repo}`)).toEqual(['axios/axios']);
    expect(r.searches[0]!.packages).toEqual([]);
  });
});
