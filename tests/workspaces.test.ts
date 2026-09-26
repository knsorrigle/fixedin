/**
 * Monorepo logs name the package each line came from; each error's installed
 * versions are read from that workspace package, not the repo root.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuthResult } from '../src/github/auth.js';
import { readPackageLock } from '../src/lockfile/index.js';
import { createClient, replayFetch } from '../src/net/client.js';
import { runLog } from '../src/pipeline.js';
import { listWorkspaces, pnpmPackages, workspaceForLabel } from '../src/workspaces.js';

const fixtures = join(import.meta.dirname, 'fixtures');
const projects = join(fixtures, 'projects');
const client = createClient(replayFetch(join(fixtures, 'http')));
const auth: AuthResult = { token: 't', source: 'GITHUB_TOKEN', tried: [] };

describe('listWorkspaces', () => {
  it.each(['pnpm-workspace-v12', 'npm-workspace-v3', 'yarn-workspace-v4', 'bun-workspace-v1.4', 'yarn-workspace-v1'])('%s', (dir) => {
    expect(listWorkspaces(join(projects, dir))).toEqual([
      { dir: 'packages/ui', name: '@mono/ui' },
      { dir: 'packages/web', name: '@mono/web' },
    ]);
  });

  it('deno: workspace members from deno.json, named by their deno.json or package.json', () => {
    expect(listWorkspaces(join(projects, 'deno-workspace-v2.9'))).toEqual([
      { dir: 'packages/api', name: '@mono/api' },
      { dir: 'packages/web', name: '@mono/web' },
    ]);
  });

  it('a project without workspaces has none', () => {
    expect(listWorkspaces(join(projects, 'axios-app'))).toEqual([]);
  });

  it('reads pnpm-workspace.yaml lists, quoted or not, and stops at the next key', () => {
    expect(pnpmPackages(`packages:\n  - "apps/*"\n  - packages/** # all\n  - '!**/test/**'\ncatalog:\n  - nope\n`)).toEqual(['apps/*', 'packages/**', '!**/test/**']);
  });
});

describe('workspaceForLabel', () => {
  const ws = [
    { dir: 'apps/api', name: '@shop/api' },
    { dir: 'apps/web', name: '@shop/web' },
    { dir: 'tools/web-e2e' },
  ];
  it.each([
    ['turbo', '@shop/web:test', 'apps/web'],
    ['turbo', '@shop/web:test:unit', 'apps/web'],
    ['turbo', 'web:test', undefined], // turbo labels use the full package name
    ['pnpm', 'apps/api test', 'apps/api'],
    ['compose', 'api-1', 'apps/api'],
    ['concurrently', 'web', 'apps/web'],
    ['concurrently', '0', undefined],
    ['compose', 'db-1', undefined],
  ] as const)('%s %j → %s', (scheme, label, dir) => {
    expect(workspaceForLabel(label, scheme, ws)?.dir).toBe(dir);
  });
});

describe('npm workspaces', () => {
  const lock = join(projects, 'npm-workspace-v3/package-lock.json');
  it('a workspace package loads its own copy', () => {
    expect(readPackageLock(lock, join(projects, 'npm-workspace-v3/packages/web')).find('axios')[0]).toMatchObject({
      version: '1.1.3',
      location: 'packages/web/node_modules/axios',
      topLevel: true,
    });
  });
  it('the root, or a workspace without its own copy, loads the hoisted one', () => {
    for (const cwd of ['', 'packages/ui']) {
      expect(readPackageLock(lock, join(projects, 'npm-workspace-v3', cwd)).find('axios')[0]).toMatchObject({ version: '1.5.0', location: 'node_modules/axios', topLevel: true });
    }
  });
});

describe('a turbo log from a monorepo (recorded)', () => {
  const trace = readFileSync(join(fixtures, 'stacks/axios-default-create.txt'), 'utf8').trimEnd().split('\n');
  const log = [
    ...trace.map((l) => `@mono/web:test: ${l}`),
    '@mono/ui:test: > @mono/ui@2.1.0 test',
    ...trace.map((l) => `@mono/ui:test: ${l}`),
    '',
    ' Tasks:    0 successful, 2 total',
  ].join('\n');

  it.each(['pnpm-workspace-v12', 'npm-workspace-v3'])('%s: the same error, one verdict per package, from each package\'s own versions', async (dir) => {
    const r = await runLog(log, { cwd: join(projects, dir), client, limit: 3, auth, repo: 'axios/axios' });
    expect(r.errors.map((e) => [e.source, e.verdicts[0]!.installed?.version, e.verdicts[0]!.kind])).toEqual([
      ['@mono/web:test', '1.1.3', 'FIXED_UPSTREAM_UPGRADE'],
      ['@mono/ui:test', '1.5.0', 'ALREADY_HAVE_FIX'],
    ]);
    expect(r.errors[0]!.detect.diagnostics.items).toContainEqual(
      expect.objectContaining({ stage: 'lockfile', message: 'Versions from @mono/web (packages/web): the error came from @mono/web:test.' }),
    );
  });
});
