/**
 * Which installed copy threw? Stack frames can say more than the package name:
 * nested npm paths match a specific lockfile entry, and pnpm/bun/yarn/Deno
 * paths embed the version outright.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detect, selectCopy } from '../src/detect.js';
import type { AuthResult } from '../src/github/auth.js';
import type { InstalledPackage } from '../src/lockfile/index.js';
import { createClient, replayFetch } from '../src/net/client.js';
import { formatVerdicts } from '../src/output/terminal.js';
import { frameCopy, installPathIn, parseError } from '../src/parse/index.js';
import { run } from '../src/pipeline.js';

const fixtures = join(import.meta.dirname, 'fixtures');
const stack = (n: string) => readFileSync(join(fixtures, 'stacks', `${n}.txt`), 'utf8');
const client = createClient(replayFetch(join(fixtures, 'http')));
const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

describe('frame paths (real traces)', () => {
  it('npm: a nested copy under another package', () => {
    const axios = parseError(stack('npm-nested-axios')).packages[0]!;
    expect(axios.copy).toEqual({ installPath: '/Users/dev/shop-api/node_modules/wait-on/node_modules/axios' });
  });

  it('pnpm: version from the virtual store directory', () => {
    expect(parseError(stack('pnpm-axios-adapter')).packages[0]!.copy).toMatchObject({ version: '1.1.3', versionFrom: 'pnpm' });
    // pnpm 7 store names carry peer suffixes: babel-loader@9.1.3_@babel+core@7.23.2_webpack@5.89.0
    const p = parseError(stack('pnpm-nested')).packages;
    expect(p.map((x) => [x.name, x.copy?.version])).toEqual([
      ['find-cache-dir', '3.3.2'],
      ['babel-loader', '9.1.3'],
    ]);
  });

  it('yarn PnP: version from the zip cache name', () => {
    expect(parseError(stack('yarn-pnp-axios-adapter')).packages[0]!.copy).toMatchObject({ version: '1.1.3', versionFrom: 'yarn-cache' });
  });

  it('Deno: version from the npm cache path', () => {
    expect(parseError(stack('deno-axios-econnrefused')).packages.map((x) => x.copy)).toEqual([
      { version: '1.1.3', versionFrom: 'deno-cache' },
      { version: '1.16.0', versionFrom: 'deno-cache' },
    ]);
  });

  it('a hoisted frame gives only the install path', () => {
    expect(parseError(stack('axios-headers')).packages[0]!.copy).toEqual({ installPath: '/Users/dev/shop-api/node_modules/axios' });
  });
});

describe('frameCopy edge cases', () => {
  const at = (path: string) => `    at f (${path}:1:1)`;
  it.each([
    ['scoped pnpm with peers', '/a/node_modules/.pnpm/@tanstack+react-query@5.0.0_react-dom@18.2.0_react@18.2.0/node_modules/@tanstack/react-query/build/index.js', '@tanstack/react-query', { version: '5.0.0', versionFrom: 'pnpm' }],
    ['bun isolated install', '/a/node_modules/.bun/axios@1.1.3/node_modules/axios/index.js', 'axios', { version: '1.1.3', versionFrom: 'bun' }],
    ['scoped yarn zip', '/a/.yarn/cache/@tanstack-react-query-npm-5.0.0-0123456789-abcdef0123.zip/node_modules/@tanstack/react-query/x.js', '@tanstack/react-query', { version: '5.0.0', versionFrom: 'yarn-cache' }],
    ['yarn prerelease', '/a/.yarn/cache/next-npm-15.0.0-canary.1-0123456789-abcdef0123.zip/node_modules/next/x.js', 'next', { version: '15.0.0-canary.1', versionFrom: 'yarn-cache' }],
    ['pnpm dir of a different package', '/a/node_modules/.pnpm/axios-retry@3.0.0/node_modules/axios/index.js', 'axios', { installPath: '/a/node_modules/.pnpm/axios-retry@3.0.0/node_modules/axios' }],
  ])('%s', (_label, path, name, expected) => {
    expect(frameCopy(at(path), name, 'stack-frame')).toMatchObject(expected);
    if (!('version' in expected)) expect(frameCopy(at(path), name, 'stack-frame')?.version).toBeUndefined();
  });

  it.each([
    ['    at f (C:\\app\\node_modules\\wait-on\\node_modules\\axios\\lib\\a.js:1:1)', 'axios', 'C:/app/node_modules/wait-on/node_modules/axios'],
    ['    at f (file:///C:/app/node_modules/axios/lib/a.js:1:1)', 'axios', 'C:/app/node_modules/axios'],
    ['    at f (webpack-internal:///./node_modules/react-dom/cjs/x.js:1:1)', 'react-dom', './node_modules/react-dom'],
    ['    at f (/app/node_modules/axios-retry/index.js:1:1)', 'axios', undefined], // a different package
  ])('installPathIn(%s, %s)', (line, name, expected) => {
    expect(installPathIn(line, name)).toBe(expected);
  });
});

describe('selectCopy', () => {
  const c = (version: string, location: string, topLevel = location === 'node_modules/axios'): InstalledPackage => ({
    name: 'axios',
    version,
    location,
    topLevel,
    source: 'package-lock.json',
  });
  const copies = [c('1.1.3', 'node_modules/axios'), c('0.25.0', 'node_modules/wait-on/node_modules/axios'), c('0.21.4', 'node_modules/x/node_modules/axios')];

  it('picks the nested copy the frame path points at (longest match wins)', () => {
    expect(selectCopy('axios', { installPath: '/app/node_modules/wait-on/node_modules/axios' }, copies)).toMatchObject({
      version: '0.25.0',
      selectedBy: 'frame-install-path',
      topLevelVersion: '1.1.3',
    });
  });

  it('keeps the top-level copy for a hoisted frame, without claiming the frame chose it', () => {
    const r = selectCopy('axios', { installPath: '/app/node_modules/axios' }, copies);
    expect(r).toEqual(copies[0]);
  });

  it('matches an embedded version to its lockfile entry', () => {
    expect(selectCopy('axios', { version: '0.21.4', versionFrom: 'pnpm' }, copies)).toMatchObject({
      location: 'node_modules/x/node_modules/axios',
      selectedBy: 'frame-version',
      topLevelVersion: '1.1.3',
    });
  });

  it('trusts an embedded version even when no lockfile knows it', () => {
    expect(selectCopy('axios', { version: '1.2.0', versionFrom: 'yarn-cache', installPath: '/a/.yarn/cache/x.zip/node_modules/axios' }, [])).toEqual({
      name: 'axios',
      version: '1.2.0',
      location: '/a/.yarn/cache/x.zip/node_modules/axios',
      topLevel: false,
      source: '/a/.yarn/cache/x.zip/node_modules/axios',
      selectedBy: 'frame-version',
    });
  });

  it('falls back to the top-level copy with no frame information', () => {
    expect(selectCopy('axios', undefined, copies)).toBe(copies[0]);
    expect(selectCopy('axios', undefined, [])).toBeUndefined();
  });
});

describe('end to end (recorded)', () => {
  const auth: AuthResult = { token: 't', source: 'GITHUB_TOKEN', tried: [] };

  it('npm: reports the nested 0.25.0 that threw, not the hoisted 1.1.3', async () => {
    const cwd = join(fixtures, 'projects/npm-nested'); // real npm 10 lockfile with both copies
    const r = await run(stack('npm-nested-axios'), { cwd, client, limit: 3, auth });
    const v = r.verdicts[0]!;
    expect(v.installed).toMatchObject({
      version: '0.25.0',
      location: 'node_modules/wait-on/node_modules/axios',
      selectedBy: 'frame-install-path',
      topLevelVersion: '1.1.3',
    });
    // The release check ran against the copy that threw.
    expect(r.detect.packages[0]!.otherCopies.map((x) => x.version)).toEqual(['1.1.3']);
    expect(strip(formatVerdicts(r, cwd, 1))).toContain(
      'You have: 0.25.0 at node_modules/wait-on/node_modules/axios (from package-lock.json) — the copy in the stack trace; top-level axios is 1.1.3',
    );
  });

  it.each(['pnpm-axios-adapter', 'yarn-pnp-axios-adapter'])('%s: the version comes from the path when there is no lockfile', async (trace) => {
    const cwd = mkdtempSync(join(tmpdir(), 'fixedin-nolock-'));
    const d = await detect(stack(trace), { cwd, client });
    expect(d.packages[0]!.installed).toMatchObject({ version: '1.1.3', selectedBy: 'frame-version' });
    // No "not installed" warning: the trace itself is the evidence.
    expect(d.diagnostics.items.filter((x) => x.level === 'warn' && /not installed/.test(x.message))).toEqual([]);
  });
});
