/**
 * The real command line, driven in-process through main() with replayed
 * responses: exit codes, output streams, and argument handling.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { exitCodeFor, main } from '../src/main.js';
import { createClient, replayFetch } from '../src/net/client.js';
import type { RunResult } from '../src/pipeline.js';
import { Diagnostics } from '../src/diagnostics.js';

const fixtures = join(import.meta.dirname, 'fixtures');
const stack = (n: string) => readFileSync(join(fixtures, 'stacks', `${n}.txt`), 'utf8');

async function cli(args: string[], opts: { stdin?: string; project?: string } = {}) {
  let stdout = '';
  let stderr = '';
  const code = await main(['node', 'fixedin', ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    readStdin: async () => opts.stdin,
    env: { GITHUB_TOKEN: 'test-token' },
    cwd: join(fixtures, 'projects', opts.project ?? 'axios-app'),
    client: createClient(replayFetch(join(fixtures, 'http'))),
  });
  return { code, stdout: stdout.replace(/\u001b\[[0-9;]*m/g, ''), stderr };
}

describe('--exit-code', () => {
  it('1 when a released fix exists that you do not have', async () => {
    const r = await cli(['--exit-code', '--repo', 'axios/axios'], { stdin: stack('axios-default-create'), project: 'axios-1.1.3' });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('→ Upgrade to >=1.2.0');
  });

  it.each([
    ['already have the fix', ['--repo', 'axios/axios'], stack('axios-default-create'), 'axios-app'],
    ['no matching issue', ['--repo', 'axios/axios', 'TypeError: frobnicator quantum flux capacitor overheated in zorgblatt'], undefined, 'axios-app'],
    ['open issue', ['--repo', 'axios/axios', 'AxiosError toJSON skips response'], undefined, 'axios-app'],
    ['closed without a traced fix', [], stack('axios-headers'), 'axios-app'],
  ])('0 when %s', async (_label, args, stdin, project) => {
    expect((await cli(['--exit-code', ...args], { ...(stdin ? { stdin } : {}), project })).code).toBe(0);
  });

  it('2 when a search fails outright', async () => {
    const r = await cli(['--exit-code', '--repo', 'nobody/nothing', 'TypeError: x is not a function']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Every search in nobody\/nothing failed/);
  });

  it('2 for bad arguments or missing input (1 without the flag, as before)', async () => {
    expect((await cli(['--exit-code', '--limit', '0', 'x'])).code).toBe(2);
    expect((await cli(['--limit', '0', 'x'])).code).toBe(1);
    expect((await cli(['--exit-code'])).code).toBe(2);
    expect((await cli([])).code).toBe(1);
  });

  it('works with --json: stdout is complete, valid JSON', async () => {
    const r = await cli(['--exit-code', '--json', '--repo', 'axios/axios'], { stdin: stack('axios-default-create'), project: 'axios-1.1.3' });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).results[0].verdict.kind).toBe('FIXED_UPSTREAM_UPGRADE');
  });

  it('without --exit-code a found fix still exits 0', async () => {
    expect((await cli(['--repo', 'axios/axios'], { stdin: stack('axios-default-create'), project: 'axios-1.1.3' })).code).toBe(0);
  });

  it('--version and --help exit 0', async () => {
    const v = await cli(['--version']);
    expect(v).toMatchObject({ code: 0 });
    expect(v.stdout.trim()).toBe(pkg.version);
    const h = await cli(['--help']);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain('--exit-code');
  });
});

describe('exitCodeFor', () => {
  const result = (kinds: string[], errorDiag = false): RunResult => {
    const diagnostics = new Diagnostics();
    if (errorDiag) diagnostics.error('search', 'Every search in x/y failed.');
    return { verdicts: kinds.map((kind) => ({ kind })), detect: { diagnostics } } as unknown as RunResult;
  };

  it('a found fix wins over a failure in another repo', () => {
    expect(exitCodeFor(result(['NO_MATCH', 'FIXED_UPSTREAM_UPGRADE'], true))).toBe(1);
  });
  it('an error with no fix found → 2; nothing actionable → 0', () => {
    expect(exitCodeFor(result(['NO_MATCH'], true))).toBe(2);
    expect(exitCodeFor(result(['ALREADY_HAVE_FIX', 'FIX_UNRELEASED', 'OPEN_ISSUE', 'CLOSED_NO_FIX_FOUND', 'NO_MATCH']))).toBe(0);
  });
});
