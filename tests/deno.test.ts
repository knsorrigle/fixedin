import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuthResult } from '../src/github/auth.js';
import { parseDenoLock, readDenoLock, resolveSpecifierValue, splitNameAt, stripDenoPeers } from '../src/lockfile/deno.js';
import { locateLockfile, openLockfile } from '../src/lockfile/index.js';
import { createClient, replayFetch } from '../src/net/client.js';
import { parseError } from '../src/parse/index.js';
import { run } from '../src/pipeline.js';

const fixtures = join(import.meta.dirname, 'fixtures');
const projects = join(fixtures, 'projects');
const lock = (dir: string, cwd = dir) => readDenoLock(join(projects, dir, 'deno.lock'), join(projects, cwd));
const versions = (r: ReturnType<typeof lock>, name: string) => r.find(name).map((p) => `${p.version}${p.topLevel ? '*' : ''}`);

describe('deno.lock helpers', () => {
  it('splits names and strips peer suffixes', () => {
    expect(splitNameAt('@tanstack/react-query@5.0.0')).toEqual({ name: '@tanstack/react-query', rest: '5.0.0' });
    expect(splitNameAt('axios@^1.1.0')).toEqual({ name: 'axios', rest: '^1.1.0' });
    expect(stripDenoPeers('5.0.0_react@18.2.0_react-dom@18.2.0__react@18.2.0')).toBe('5.0.0');
  });

  it('resolves specifier values in both the v3 and v4/v5 spelling', () => {
    expect(resolveSpecifierValue('react-dom', 'npm:react-dom@18.2.0_react@18.2.0')).toEqual({ name: 'react-dom', version: '18.2.0' });
    expect(resolveSpecifierValue('react-dom', '18.2.0_react@18.2.0')).toEqual({ name: 'react-dom', version: '18.2.0' });
    expect(resolveSpecifierValue('@tanstack/react-query', 'npm:@tanstack/react-query@5.0.0_react@18.2.0')).toEqual({
      name: '@tanstack/react-query',
      version: '5.0.0',
    });
  });

  it('rejects unreadable, too-old and too-new lockfiles with a reason', () => {
    expect(() => parseDenoLock('{', 'deno.lock')).toThrow(/Could not parse deno\.lock/);
    expect(() => parseDenoLock('{}', 'deno.lock')).toThrow(/no readable "version"/);
    expect(() => parseDenoLock('{"version":"2"}', 'deno.lock')).toThrow(/versions 3–5\. Running any Deno ≥1\.40 command/);
    expect(() => parseDenoLock('{"version":"6"}', 'deno.lock')).toThrow(/open an issue/);
  });

  it('ignores jsr: and https: imports (no npm version to compare)', () => {
    const r = parseDenoLock(
      JSON.stringify({
        version: '5',
        specifiers: { 'jsr:@std/path@1': '1.0.8', 'npm:axios@1.1.3': '1.1.3' },
        jsr: { '@std/path@1.0.8': {} },
        npm: { 'axios@1.1.3': {} },
        workspace: { dependencies: ['jsr:@std/path@1', 'npm:axios@1.1.3'] },
      }),
      '/p/deno.lock',
      '/p',
    );
    expect(r.find('@std/path')).toEqual([]);
    expect(r.find('axios')[0]).toMatchObject({ version: '1.1.3', topLevel: true });
  });
});

describe('real deno.lock files', () => {
  // Generated with `deno@<v> cache main.ts` from the same deno.json imports.
  it.each([
    ['deno-v1.46', 'version 3 (Deno 1.46)'],
    ['deno-v2.0', 'version 4 (Deno 2.0)'],
    ['deno-v2.3', 'version 5 (Deno 2.3)'],
    ['deno-v2.9', 'version 5 (Deno 2.9)'],
  ])('%s — %s', (dir) => {
    const r = lock(dir);
    expect(r.kind).toBe('deno');
    expect(versions(r, 'axios')).toEqual(['1.1.3*']);
    expect(versions(r, 'react-dom')).toEqual(['18.2.0*']); // peer suffix stripped
    expect(versions(r, '@tanstack/react-query')).toEqual(['5.0.0*']);
    expect(versions(r, '@tanstack/query-core')).toEqual(['5.0.0']); // transitive
    expect(versions(r, 'semver')).toEqual(['7.8.5*']); // npm:semver@^7.5.4
    expect(versions(r, 'string-width')).toEqual(['4.2.3*']); // imported under the alias string-width-cjs
    expect(r.find('not-a-dep')).toEqual([]);
  });

  it.each(['deno-workspace-v2.0', 'deno-workspace-v2.9'])('%s — workspace members from deno.json and package.json', (dir) => {
    expect(versions(lock(dir), 'axios')).toEqual(['1.5.0*', '1.1.3']);
    const web = lock(dir, `${dir}/packages/web/src`); // member with deno.json imports
    expect(versions(web, 'axios')).toEqual(['1.1.3*', '1.5.0']);
    expect(versions(web, 'string-width')).toEqual(['4.2.3*']);
    expect(web.find('axios')[0]!.location).toBe('packages/web/node_modules/axios');
    const api = lock(dir, `${dir}/packages/api`); // member with package.json dependencies
    expect(versions(api, 'axios')).toEqual(['1.1.3*', '1.5.0']);
    expect(versions(api, 'semver')).toEqual(['7.5.4*']);
    expect(versions(api, 'string-width')).toEqual(['4.2.3']); // web's dependency, not api's
  });

  it('is found from inside a workspace member and opened for that member', () => {
    const cwd = join(projects, 'deno-workspace-v2.9/packages/api');
    const { found } = locateLockfile(cwd);
    expect(found).toEqual({ kind: 'deno', path: join(projects, 'deno-workspace-v2.9/deno.lock') });
    expect(openLockfile(found!, cwd).find('semver')[0]).toMatchObject({ version: '7.5.4', topLevel: true });
  });
});

describe('Deno stack traces', () => {
  it('finds packages in Deno npm-cache frames (real trace, ANSI colours included)', () => {
    const p = parseError(readFileSync(join(fixtures, 'stacks/deno-axios-econnrefused.txt'), 'utf8'));
    expect(p.query).toBe('Error: connect ECONNREFUSED');
    expect(p.errorCodes).toEqual(['ECONNREFUSED']);
    expect(p.packages.map((x) => [x.name, x.source])).toEqual([
      ['axios', 'deno-npm-cache'],
      ['follow-redirects', 'deno-npm-cache'],
    ]);
  });

  it.each([
    ['at f (file:///C:/Users/me/AppData/Local/deno/npm/registry.npmjs.org/@tanstack/react-query/5.0.0/build/index.js:1:1)', ['@tanstack/react-query']],
    ['at g (/home/u/.cache/deno/npm/npm.example.com:8443/axios/1.1.3/index.js:1:1)', ['axios']],
    ['at h (/home/u/code/npm/tools/v1.2.3/x.js:1:1)', []], // no registry host segment → not a cache path
  ])('%s', (frame, expected) => {
    expect(parseError(`Error: x\n    ${frame}`).packages.map((x) => x.name)).toEqual(expected);
  });
});

describe('verdicts from Deno projects (recorded)', () => {
  const client = createClient(replayFetch(join(fixtures, 'http')));
  const auth: AuthResult = { token: 't', source: 'GITHUB_TOKEN', tried: [] };

  it('a real Deno trace needs no --repo: package from the cache path, version from deno.lock', async () => {
    const r = await run(readFileSync(join(fixtures, 'stacks/deno-axios-econnrefused.txt'), 'utf8'), {
      cwd: join(projects, 'deno-v2.9'),
      client,
      limit: 3,
      auth,
    });
    expect(r.detect.lockfile?.kind).toBe('deno');
    expect(r.verdicts.map((v) => [v.packageName, v.installed?.version])).toEqual([
      ['axios', '1.1.3'],
      ['follow-redirects', '1.16.0'],
    ]);
  });

  it('workspace: a different verdict per member', async () => {
    const stack = readFileSync(join(fixtures, 'stacks/axios-default-create.txt'), 'utf8');
    const dir = join(projects, 'deno-workspace-v2.9');
    const api = await run(stack, { cwd: join(dir, 'packages/api'), client, limit: 3, auth, repo: 'axios/axios' });
    const root = await run(stack, { cwd: dir, client, limit: 3, auth, repo: 'axios/axios' });
    expect(api.verdicts[0]).toMatchObject({ kind: 'FIXED_UPSTREAM_UPGRADE', installed: { version: '1.1.3' }, fixedIn: '1.2.0' });
    expect(root.verdicts[0]).toMatchObject({ kind: 'ALREADY_HAVE_FIX', installed: { version: '1.5.0' } });
  });
});
