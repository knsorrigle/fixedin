import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detect } from '../src/detect.js';
import type { AuthResult } from '../src/github/auth.js';
import { parseBunIdent, parseBunLock, readBunLock, stripJsonc } from '../src/lockfile/bun.js';
import { locateLockfile, openLockfile } from '../src/lockfile/index.js';
import { createClient, replayFetch } from '../src/net/client.js';
import { run } from '../src/pipeline.js';

const projects = join(import.meta.dirname, 'fixtures/projects');
const lock = (dir: string, cwd = dir) => readBunLock(join(projects, dir, 'bun.lock'), join(projects, cwd));
const versions = (r: ReturnType<typeof lock>, name: string) => r.find(name).map((p) => `${p.version}${p.topLevel ? '*' : ''}`);
const client = createClient(replayFetch(join(import.meta.dirname, 'fixtures/http')));

describe('bun.lock syntax', () => {
  it('stripJsonc drops trailing commas and comments but never touches strings', () => {
    const src = '{\n  // comment\n  "a": [1, 2,],\n  "b": "x, ] // not a comment",\n  "c": "q\\",}", /* block */\n}';
    expect(JSON.parse(stripJsonc(src))).toEqual({ a: [1, 2], b: 'x, ] // not a comment', c: 'q",}' });
  });

  it.each([
    ['axios@1.1.3', { name: 'axios', version: '1.1.3' }],
    ['@tanstack/react-query@5.0.0', { name: '@tanstack/react-query', version: '5.0.0' }],
    ['@mono/ui@workspace:packages/ui', { name: '@mono/ui', workspace: 'packages/ui' }],
    ['nope', undefined],
  ])('parseBunIdent(%s)', (ident, expected) => {
    expect(parseBunIdent(ident)).toEqual(expected);
  });
});

describe('real bun.lock files', () => {
  // Generated with `bun@<v> install --lockfile-only` from the same package.json.
  it.each([
    ['bun-v1.1', 'lockfileVersion 0 (Bun 1.1, --save-text-lockfile)'],
    ['bun-v1.2', 'lockfileVersion 1 (Bun 1.2)'],
    ['bun-v1.4', 'lockfileVersion 2 (Bun 1.4)'],
  ])('%s — %s', (dir) => {
    const r = lock(dir);
    expect(r.kind).toBe('bun');
    expect(versions(r, 'axios')).toEqual(['1.1.3*']);
    expect(versions(r, 'react-dom')).toEqual(['18.2.0*']);
    expect(versions(r, '@tanstack/react-query')).toEqual(['5.0.0*']);
    expect(versions(r, '@tanstack/query-core')).toEqual(['5.0.0']); // transitive
    expect(versions(r, 'semver')).toEqual(['7.8.5*']); // devDependency ^7.5.4
    expect(versions(r, 'string-width')).toEqual(['4.2.3*']); // npm: alias string-width-cjs
    expect(r.find('not-a-dep')).toEqual([]);
  });

  it.each(['bun-workspace-v1.2', 'bun-workspace-v1.4'])('%s — workspace-local copy beats the hoisted one', (dir) => {
    expect(versions(lock(dir), 'axios')).toEqual(['1.5.0*', '1.1.3']);
    const web = lock(dir, `${dir}/packages/web/src`);
    // "@mono/web/axios": ["axios@1.1.3"] wins over hoisted "axios": ["axios@1.5.0"]
    expect(versions(web, 'axios')).toEqual(['1.1.3*', '1.5.0']);
    expect(web.find('axios')[0]!.location).toBe('packages/web/node_modules/axios');
    expect(versions(web, 'string-width')).toEqual(['4.2.3*']);
    expect(web.find('@mono/ui')[0]).toMatchObject({ version: '2.1.0', topLevel: true });
  });

  it('is found from inside a workspace package and opened for that package', () => {
    const cwd = join(projects, 'bun-workspace-v1.4/packages/web');
    const { found } = locateLockfile(cwd);
    expect(found).toEqual({ kind: 'bun', path: join(projects, 'bun-workspace-v1.4/bun.lock') });
    expect(openLockfile(found!, cwd).find('axios')[0]!.version).toBe('1.1.3');
  });
});

describe('bun.lock errors', () => {
  it('rejects malformed, foreign and future lockfiles with a reason', () => {
    expect(() => parseBunLock('{ "lockfileVersion": 1, ', 'bun.lock')).toThrow(/Could not parse bun\.lock/);
    expect(() => parseBunLock('{ "packages": {} }', 'bun.lock')).toThrow(/doesn't look like a bun\.lock/);
    expect(() => parseBunLock('{ "lockfileVersion": 3, "workspaces": {}, "packages": {} }', 'bun.lock')).toThrow(/lockfileVersion 3; fixedin reads versions 0–2/);
  });

  it('explains how to convert a binary bun.lockb, and detect() falls back to node_modules', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixedin-bun-'));
    writeFileSync(join(dir, 'bun.lockb'), Buffer.from([0x23, 0x21, 0x2f, 0x75, 0x00, 0xff]));
    const { found } = locateLockfile(dir);
    expect(found).toEqual({ kind: 'bun', path: join(dir, 'bun.lockb') });
    expect(() => openLockfile(found!)).toThrow(/bun install --save-text-lockfile/);
    const d = await detect('Error: x\n    at f (/app/node_modules/axios/lib/core/Axios.js:1:1)', { cwd: dir, client });
    expect(d.diagnostics.items).toContainEqual(expect.objectContaining({ level: 'warn', stage: 'lockfile', message: expect.stringMatching(/binary lockfile/) }));
  });

  it('prefers bun.lock over a leftover bun.lockb', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixedin-bun-'));
    writeFileSync(join(dir, 'bun.lockb'), '');
    writeFileSync(join(dir, 'bun.lock'), readFileSync(join(projects, 'bun-v1.4/bun.lock')));
    expect(locateLockfile(dir).found?.path).toBe(join(dir, 'bun.lock'));
  });
});

describe('verdicts from bun projects (recorded)', () => {
  const auth: AuthResult = { token: 't', source: 'GITHUB_TOKEN', tried: [] };
  const stack = readFileSync(join(import.meta.dirname, 'fixtures/stacks/axios-default-create.txt'), 'utf8');

  it('single project: axios 1.1.3 from bun.lock → upgrade', async () => {
    const r = await run(stack, { cwd: join(projects, 'bun-v1.4'), client, limit: 3, auth, repo: 'axios/axios' });
    expect(r.detect.lockfile?.kind).toBe('bun');
    expect(r.verdicts[0]).toMatchObject({ kind: 'FIXED_UPSTREAM_UPGRADE', installed: { version: '1.1.3' }, fixedIn: '1.2.0' });
  });

  it('workspace: a different verdict per package', async () => {
    const dir = join(projects, 'bun-workspace-v1.4');
    const web = await run(stack, { cwd: join(dir, 'packages/web'), client, limit: 3, auth, repo: 'axios/axios' });
    const root = await run(stack, { cwd: dir, client, limit: 3, auth, repo: 'axios/axios' });
    expect(web.verdicts[0]).toMatchObject({ kind: 'FIXED_UPSTREAM_UPGRADE', installed: { version: '1.1.3' } });
    expect(root.verdicts[0]).toMatchObject({ kind: 'ALREADY_HAVE_FIX', installed: { version: '1.5.0' } });
  });
});
