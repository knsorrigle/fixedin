/**
 * Logs with several errors: splitting, merging repeats, and every output
 * format. The recorded cases are the same real ones the single-error tests use.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuthResult } from '../src/github/auth.js';
import { main } from '../src/main.js';
import { createClient, replayFetch } from '../src/net/client.js';
import { ReportSchema, toLogReport } from '../src/output/json.js';
import { formatLogMarkdown } from '../src/output/markdown.js';
import { isErrorStart, splitErrors } from '../src/parse/split.js';
import { runLog } from '../src/pipeline.js';

const fixtures = join(import.meta.dirname, 'fixtures');
const stack = (n: string) => readFileSync(join(fixtures, 'stacks', `${n}.txt`), 'utf8');
const client = createClient(replayFetch(join(fixtures, 'http')));
const auth: AuthResult = { token: 't', source: 'GITHUB_TOKEN', tried: [] };
const cwd = join(fixtures, 'projects/axios-app');
const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

describe('splitErrors', () => {
  it.each(readdirSync(join(fixtures, 'stacks')).filter((f) => !/-log\.txt$/.test(f)))('keeps the single error in %s whole', (f) => {
    expect(splitErrors(stack(f.replace(/\.txt$/, '')))).toHaveLength(1);
  });

  it('keeps cause chains with their error', () => {
    const text = ['TypeError: fetch failed', '    at a (/x/node_modules/next/a.js:1:1)', 'Caused by: Error: getaddrinfo ENOTFOUND', '    at b (node:dns:1:1)', '  [cause]: Error: connect ECONNREFUSED', '    at c (node:net:1:1)'].join('\n');
    expect(splitErrors(text)).toHaveLength(1);
  });

  it('splits two uncaught errors, pointing at each error line', () => {
    const text = ['server started', 'TypeError: a is not a function', '    at a (/x/node_modules/p/a.js:1:1)', 'GET / 500', 'RangeError: Invalid time value', '    at b (/x/node_modules/q/b.js:1:1)'].join('\n');
    expect(splitErrors(text).map((b) => b.line)).toEqual([2, 5]);
  });

  it('splits vitest failures at its section rules and reads its ❯ frames', () => {
    const text = [
      '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯',
      '',
      ' FAIL  src/api.test.ts > api > creates a client',
      "TypeError: Cannot read properties of undefined (reading 'create')",
      ' ❯ Object.<anonymous> node_modules/axios/lib/axios.js:10:3',
      ' ❯ src/api.test.ts:5:18',
      '',
      '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯',
      '',
      ' FAIL  src/date.test.ts > formats',
      'RangeError: Invalid time value',
      ' ❯ format node_modules/date-fns/format.js:361:11',
    ].join('\n');
    const blocks = splitErrors(text);
    expect(blocks.map((b) => b.line)).toEqual([4, 11]);
    expect(blocks[1]!.text).toContain('date-fns');
  });

  it('recognises decorated error lines', () => {
    for (const l of ['error: Uncaught (in promise) Error: x', ' ⨯ TypeError: fetch failed', 'Uncaught TypeError: x', 'Error [ERR_REQUIRE_ESM]: x', "Module not found: Can't resolve 'x'"]) {
      expect(isErrorStart(l), l).toBe(true);
    }
    for (const l of ['Caused by: Error: x', '  [cause]: Error: x', 'stack: "Error: x', 'expect(received).toBe(expected)']) {
      expect(isErrorStart(l), l).toBe(false);
    }
  });
});

describe('runLog (recorded)', () => {
  it('a jest run: one result per distinct failure, repeats merged, the assertion skipped', async () => {
    const r = await runLog(stack('jest-ci-log'), { cwd, client, limit: 5, auth });
    expect(r.errors.map((e) => [e.lines, e.verdicts[0]!.packageName, e.verdicts[0]!.kind, e.verdicts[0]!.match?.number])).toEqual([
      [[4], 'nanoid', 'CLOSED_NO_FIX_FOUND', 462],
      [[19, 31], 'axios', 'CLOSED_NO_FIX_FOUND', 5004],
      [[44], '@prisma/client', 'OPEN_ISSUE', 25081],
    ]);
    expect(r.skipped).toEqual([{ line: 61, query: 'expect(received).toBe(expected) Object.is equality', reason: 'not-an-error' }]);
  });

  it('matches each error exactly as it would be matched alone', async () => {
    const r = await runLog(stack('dev-server-log'), { cwd, client, limit: 5, auth });
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]!.lines).toEqual([6, 15]);
    expect(r.errors[1]!.verdicts.find((v) => v.packageName === 'vite')).toMatchObject({ kind: 'FIXED_UPSTREAM_UPGRADE', fixedIn: '3.1.6' });
  });

  it('--max-errors: the rest are listed, not silently dropped', async () => {
    const r = await runLog(stack('jest-ci-log'), { cwd, client, limit: 5, auth, maxErrors: 2 });
    expect(r.errors).toHaveLength(2);
    expect(r.skipped.map((s) => [s.line, s.reason])).toEqual([[44, 'limit'], [61, 'not-an-error']]);
  });

  it('a single error runs on the whole input, exactly as before', async () => {
    const r = await runLog(stack('jest-suite'), { cwd, client, limit: 5, auth });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.detect.parsed.query).toBe('SyntaxError: Cannot use import statement outside a module');
    expect(r.skipped).toEqual([]);
  });

  it('JSON: errors[] holds every error; the top level stays the first one', async () => {
    const report = toLogReport(await runLog(stack('dev-server-log'), { cwd, client, limit: 5, auth }), 't');
    expect(ReportSchema.parse(report)).toBeTruthy();
    expect(report.errors).toHaveLength(2);
    expect(report.input).toEqual(report.errors[0]!.input);
    expect(report.results).toEqual(report.errors[0]!.results);
    expect(report.errors[1]!.results.find((x) => x.package === 'vite')!.verdict.fixedIn).toBe('3.1.6');
    // A warning both errors raise is listed once.
    const messages = report.diagnostics.map((d) => d.message);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('markdown: a section per error and the skipped ones in a collapsed list', async () => {
    const md = formatLogMarkdown(await runLog(stack('jest-ci-log'), { cwd, client, limit: 5, auth }), 't');
    expect(md).toContain('### 🔍 fixedin: no released fix you are missing (3 errors checked)');
    expect(md).toContain('#### Error 2 of 3 · line 19, 31 (2×)');
    expect(md).toContain('##### ● Known open issue: `@prisma/client`');
    expect(md).toMatch(/<details><summary>Not checked: 1 other error<\/summary>\n\n- line 61: expect\\\(received\\\)/);
  });
});

describe('the CLI on a log', () => {
  const cli = async (args: string[], log: string) => {
    let stdout = '';
    const code = await main(['node', 'fixedin', ...args], {
      stdout: (s) => (stdout += s),
      stderr: () => {},
      readStdin: async () => stack(log),
      env: { GITHUB_TOKEN: 'test-token' },
      cwd,
      client,
    });
    return { code, stdout: strip(stdout) };
  };

  it('prints each error under its own heading', async () => {
    const r = await cli([], 'jest-ci-log');
    expect(r.stdout).toContain('3 different errors in this log');
    expect(r.stdout).toContain('Error 2/3 (line 19, 31, 2×)');
    expect(r.stdout).toMatch(/Not checked:\n {2}line 61: "expect\(received\)/);
  });

  it('--exit-code is 1 when any error has a released fix', async () => {
    expect((await cli(['--exit-code'], 'dev-server-log')).code).toBe(1);
    expect((await cli(['--exit-code'], 'jest-ci-log')).code).toBe(0);
  });

  it('--markdown titles the fix count across the log', async () => {
    const r = await cli(['--markdown'], 'dev-server-log');
    expect(r.stdout).toContain('### 🔍 fixedin: 1 of 2 errors in this log was already fixed upstream');
  });
});
