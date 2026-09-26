/**
 * Monorepo logs: line labels from turbo, pnpm -r, docker compose and
 * concurrently are stripped, and interleaved output is untangled per label.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuthResult } from '../src/github/auth.js';
import { createClient, replayFetch } from '../src/net/client.js';
import { toLogReport } from '../src/output/json.js';
import { formatLogMarkdown } from '../src/output/markdown.js';
import { formatLogVerdicts } from '../src/output/terminal.js';
import { demux } from '../src/parse/demux.js';
import { runLog } from '../src/pipeline.js';

const fixtures = join(import.meta.dirname, 'fixtures');
const stack = (n: string) => readFileSync(join(fixtures, 'stacks', `${n}.txt`), 'utf8');
const client = createClient(replayFetch(join(fixtures, 'http')));
const auth: AuthResult = { token: 't', source: 'GITHUB_TOKEN', tried: [] };
const cwd = join(fixtures, 'projects/axios-app');
const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

const trace = ['TypeError: a is not a function', '    at a (/x/node_modules/p/a.js:1:1)', '    at b (/x/src/b.js:2:2)'];
const labelled = (prefix: string) => trace.map((l) => `${prefix}${l}`).join('\n');

describe('demux', () => {
  it.each([
    ['turbo', 'web:test: ', 'web:test'],
    ['turbo', '@shop/web:build: ', '@shop/web:build'],
    ['pnpm', 'apps/web test: ', 'apps/web test'],
    ['compose', 'api-1  | ', 'api-1'],
    ['concurrently', '[api] ', 'api'],
    ['concurrently', '[0] ', '0'],
  ])('%s: strips %j', (scheme, prefix, label) => {
    const r = demux(`${labelled(prefix)}\n${labelled(prefix)}`);
    expect(r.scheme).toBe(scheme);
    expect(r.streams).toHaveLength(1);
    expect(r.streams[0]!.label).toBe(label);
    expect(r.streams[0]!.text.split('\n')[1]).toBe('    at a (/x/node_modules/p/a.js:1:1)');
  });

  it('untangles interleaved streams, keeping input line numbers', () => {
    const r = demux(['a:t: 1', 'b:t: 2', 'a:t: 3', 'b:t: 4', 'a:t: 5', 'b:t: 6', 'Tasks: 2 failed'].join('\n'));
    expect(r.streams.map((s) => [s.label, s.text, s.lines])).toEqual([
      ['a:t', '1\n3\n5', [1, 3, 5]],
      ['b:t', '2\n4\n6', [2, 4, 6]],
      [null, 'Tasks: 2 failed', [7]],
    ]);
  });

  it('removes GitHub Actions raw-log timestamps, then finds the labels under them', () => {
    const r = demux(trace.map((l) => `2024-05-01T12:00:00.1234567Z web:test: ${l}`).join('\n') + '\n2024-05-01T12:00:01.0000000Z web:test: done');
    expect(r.scheme).toBe('turbo');
    expect(r.streams[0]!.text.startsWith('TypeError: a is not a function')).toBe(true);
  });

  it('leaves unlabelled logs alone', () => {
    for (const f of readdirSync(join(fixtures, 'stacks')).filter((x) => !/^(turbo|compose)-log/.test(x))) {
      expect(demux(stack(f.replace(/\.txt$/, ''))).scheme, f).toBeNull();
    }
  });

  it('does not mistake times, or an occasional "[vite]" line, for labels', () => {
    expect(demux(['12:00:01 GET / 200', '12:00:02 GET /a 200', '12:00:03 GET /b 500', '12:00:04 GET /c 200'].join('\n')).scheme).toBeNull();
    expect(demux(['[vite] hmr update /src/App.tsx', ...trace, 'more output', 'and more'].join('\n')).scheme).toBeNull();
  });
});

describe('recorded monorepo logs', () => {
  it('turbo: parallel tasks untangled into their errors, each tagged with its task', async () => {
    const r = await runLog(stack('turbo-log'), { cwd, client, limit: 5, auth });
    expect(r.prefixes).toBe('turbo');
    expect(r.errors.map((e) => [e.source, e.verdicts.map((v) => v.packageName).join('+'), e.lines.length])).toEqual([
      // The same axios error in both packages is checked once.
      ['@shop/api:test, @shop/web:test', 'axios', 3],
      ['@shop/web:test', 'nanoid', 1],
      ['@shop/api:test', '@vitejs/plugin-react+vite', 1],
      ['@shop/web:test', '@prisma/client', 1],
    ]);
    expect(r.errors[2]!.verdicts.find((v) => v.packageName === 'vite')).toMatchObject({ kind: 'FIXED_UPSTREAM_UPGRADE', fixedIn: '3.1.6' });
    expect(r.skipped).toEqual([expect.objectContaining({ reason: 'not-an-error', source: '@shop/web:test' })]);
    // Line numbers point into the original, interleaved log.
    expect(stack('turbo-log').split('\n')[r.errors[1]!.lines[0]! - 1]).toContain('SyntaxError: Cannot use import statement');
  });

  it('docker compose: another service\'s line in the middle of a stack trace is no longer part of it', async () => {
    const r = await runLog(stack('compose-log'), { cwd, client, limit: 5, auth });
    expect(r.prefixes).toBe('compose');
    expect(r.errors.map((e) => [e.source, e.lines])).toEqual([
      ['api-1', [10, 20]],
      ['api-1', [31]],
    ]);
  });

  it('every output names the source', async () => {
    const r = await runLog(stack('turbo-log'), { cwd, client, limit: 5, auth });
    expect(strip(formatLogVerdicts(r, cwd, 5))).toContain('Error 2/4 (@shop/web:test · line 19)');
    expect(formatLogMarkdown(r, 't')).toContain('#### Error 2 of 4 · `@shop/web:test` · line 19');
    const report = toLogReport(r, 't');
    expect(report.prefixes).toBe('turbo');
    expect(report.errors[1]!.source).toBe('@shop/web:test');
  });
});
