/**
 * Advice for transitive dependencies: who pulled the copy in, and what gets
 * the fix into the project — refresh, upgrade the parent, or override.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuthResult } from '../src/github/auth.js';
import { readBunLock } from '../src/lockfile/bun.js';
import { readDenoLock } from '../src/lockfile/deno.js';
import { readPackageLock, type Dependent, type InstalledPackage, type LockfileReader } from '../src/lockfile/index.js';
import { readPnpmLock } from '../src/lockfile/pnpm.js';
import { readYarnLock } from '../src/lockfile/yarn.js';
import { createClient, replayFetch, type FetchLike } from '../src/net/client.js';
import { formatVerdicts } from '../src/output/terminal.js';
import { run } from '../src/pipeline.js';
import { declaredDependencies, relationOf } from '../src/relation.js';
import type { Packument } from '../src/release/index.js';
import { overrideFor, packageManagerOf, planRemedy, rangeGetsFix, refreshCommand, type PackageManager } from '../src/remedy/index.js';

const fixtures = join(import.meta.dirname, 'fixtures');
const projects = join(fixtures, 'projects');
const recorded = createClient(replayFetch(join(fixtures, 'http')));
const show = (ds: Dependent[]) => ds.map((d) => `${d.name}@${d.version}${d.range ? ` ${d.range}` : ''}`);
const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

describe('dependents(): who depends on this exact copy (real lockfiles)', () => {
  it('npm v3 and v1: the nested axios belongs to wait-on; the shared follow-redirects to both axios copies', () => {
    for (const r of [readPackageLock(join(projects, 'npm-nested/package-lock.json')), readPackageLock(join(projects, 'npm6-v1/package-lock.json'))]) {
      expect(show(r.dependents!('axios', '0.25.0'))).toEqual(['wait-on@6.0.1 ^0.25.0']);
      expect(r.dependents!('axios', '1.1.3')).toEqual([]); // the project's own copy
      expect(show(r.dependents!('follow-redirects', '1.16.0'))).toEqual(['axios@1.1.3 ^1.15.0', 'axios@0.25.0 ^1.14.7']);
    }
  });

  it('pnpm 7/8/9/12: exact versions, peer suffixes stripped, no ranges', () => {
    for (const dir of ['pnpm-v7', 'pnpm-v8', 'pnpm-v9', 'pnpm-v12']) {
      const r = readPnpmLock(join(projects, dir, 'pnpm-lock.yaml'), join(projects, dir));
      expect(show(r.dependents!('follow-redirects', '1.16.0'))).toEqual(['axios@1.1.3']);
      expect(show(r.dependents!('react', '18.2.0')).sort()).toEqual(['@tanstack/react-query@5.0.0', 'react-dom@18.2.0']);
    }
  });

  it('yarn classic and Berry (yarn 4 ranges lose their "npm:" prefix)', () => {
    for (const dir of ['yarn-v1', 'yarn-v2', 'yarn-v3', 'yarn-v4']) {
      const r = readYarnLock(join(projects, dir, 'yarn.lock'), join(projects, dir));
      expect(show(r.dependents!('follow-redirects', '1.16.0'))).toEqual(['axios@1.1.3 ^1.15.0']);
      expect(show(r.dependents!('emoji-regex', r.find('emoji-regex')[0]!.version))).toEqual(['string-width@4.2.3 ^8.0.0']);
    }
  });

  it('bun: install-path keys resolve like Node (workspace copy vs hoisted)', () => {
    const r = readBunLock(join(projects, 'bun-workspace-v1.4/bun.lock'), join(projects, 'bun-workspace-v1.4'));
    expect(show(r.dependents!('follow-redirects', '1.16.0')).sort()).toEqual(['axios@1.1.3 ^1.15.0', 'axios@1.5.0 ^1.15.0']);
  });

  it('deno v3 (exact refs) and v5 (bare names when unambiguous)', () => {
    for (const dir of ['deno-v1.46', 'deno-v2.9']) {
      const r = readDenoLock(join(projects, dir, 'deno.lock'), join(projects, dir));
      expect(show(r.dependents!('follow-redirects', '1.16.0'))).toEqual(['axios@1.1.3']);
    }
  });
});

describe('declaredDependencies', () => {
  it('reads package.json (aliases declare their real package) and deno.json imports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixedin-decl-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { a: '1', 'sw-cjs': 'npm:string-width@4' }, devDependencies: { b: '1' } }));
    writeFileSync(join(dir, 'deno.jsonc'), '{ // comment\n "imports": { "x": "npm:@scope/pkg@1/sub", "std": "jsr:@std/path@1" }, }');
    expect([...declaredDependencies(dir).names].sort()).toEqual(['@scope/pkg', 'a', 'b', 'string-width', 'sw-cjs']);
  });

  it("a workspace member's own package.json wins over the root's", () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixedin-decl-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { root: '1' } }));
    mkdirSync(join(dir, 'packages/web'), { recursive: true });
    writeFileSync(join(dir, 'packages/web/package.json'), JSON.stringify({ dependencies: { web: '1' } }));
    expect([...declaredDependencies(join(dir, 'packages/web'), dir).names]).toEqual(['web']);
  });

  it('reports an unreadable manifest instead of ignoring it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixedin-decl-'));
    writeFileSync(join(dir, 'package.json'), '{ nope');
    expect(declaredDependencies(dir).problems[0]).toMatch(/Could not read .*package\.json/);
  });
});

describe('relationOf', () => {
  const copy = (version: string, over: Partial<InstalledPackage> = {}): InstalledPackage => ({
    name: 'axios',
    version,
    location: 'node_modules/axios',
    topLevel: true,
    source: 'package-lock.json',
    ...over,
  });
  const reader = (graph: Record<string, Dependent[]>): LockfileReader => ({
    kind: 'package-lock',
    file: 'package-lock.json',
    find: () => [],
    dependents: (n, v) => graph[`${n}@${v}`] ?? [],
  });

  it('direct when declared and the app loads that copy', () => {
    expect(relationOf('axios', copy('1.1.3'), reader({}), new Set(['axios']))).toEqual({ kind: 'direct' });
  });

  it('transitive for a nested copy even when the package is also declared', () => {
    const r = relationOf(
      'axios',
      copy('0.25.0', { topLevel: false, selectedBy: 'frame-install-path', location: 'node_modules/wait-on/node_modules/axios' }),
      reader({ 'axios@0.25.0': [{ name: 'wait-on', version: '6.0.1', range: '^0.25.0' }] }),
      new Set(['axios', 'wait-on']),
    );
    expect(r).toMatchObject({ kind: 'transitive', chain: [{ name: 'wait-on' }] });
  });

  it('walks up to a declared ancestor, and says why when it cannot tell', () => {
    const g = reader({ 'c@1.0.0': [{ name: 'b', version: '2.0.0' }], 'b@2.0.0': [{ name: 'a', version: '3.0.0' }] });
    expect(relationOf('c', copy('1.0.0', { name: 'c' }), g, new Set(['a']))).toMatchObject({ kind: 'transitive', chain: [{ name: 'b' }, { name: 'a' }] });
    expect(relationOf('z', copy('1.0.0', { name: 'z' }), g, new Set())).toMatchObject({ kind: 'unknown', reason: expect.stringMatching(/nothing in package-lock\.json depends on z@1\.0\.0/) });
    expect(relationOf('c', copy('1.0.0', { name: 'c' }), undefined, new Set())).toMatchObject({ kind: 'unknown' });
  });
});

describe('commands and overrides — each verified against the real package manager', () => {
  // npm 11, pnpm 10, yarn 1.22 / 4.18, bun 1.4, deno 2.9. See src/remedy/index.ts.
  it.each<[PackageManager, string | undefined, string]>([
    ['npm', 'npm update axios', '{"overrides":{"wait-on":{"axios":"^1.2.0"}}}'],
    ['pnpm', 'pnpm update axios', '{"pnpm":{"overrides":{"wait-on>axios":"^1.2.0"}}}'],
    ['yarn-classic', undefined, '{"resolutions":{"wait-on/axios":"^1.2.0"}}'],
    ['yarn-berry', 'yarn up -R axios', '{"resolutions":{"wait-on/axios":"^1.2.0"}}'],
    ['bun', 'bun update axios', '{"overrides":{"axios":"^1.2.0"}}'],
    ['deno', 'rm deno.lock && deno install', '{"overrides":{"wait-on":{"axios":"^1.2.0"}}}'],
  ])('%s', (pm, command, snippet) => {
    expect(refreshCommand(pm, 'axios').command).toBe(command);
    expect(overrideFor(pm, 'wait-on', 'axios', '^1.2.0').snippet).toBe(snippet);
  });

  it('yarn 1 gets steps, not `yarn upgrade` (which ignores transitive dependencies)', () => {
    expect(refreshCommand('yarn-classic', 'axios').note).toMatch(/delete the "axios@…" entries from yarn\.lock, then run `yarn install`/);
  });

  it('maps lockfiles to package managers', () => {
    expect(packageManagerOf({ kind: 'yarn', flavor: 'classic' })).toBe('yarn-classic');
    expect(packageManagerOf({ kind: 'yarn', flavor: 'berry' })).toBe('yarn-berry');
    expect(packageManagerOf(undefined)).toBe('npm');
  });
});

describe('planRemedy', () => {
  const axiosVersions = ['0.25.0', '0.27.2', '1.1.3', '1.2.0', '1.2.1', '1.6.1', '1.20.0'];
  const packument = (name: string, versions: Record<string, Record<string, string> | undefined>): Packument =>
    ({
      name,
      versions: Object.fromEntries(Object.entries(versions).map(([v, deps]) => [v, { version: v, ...(deps ? { dependencies: deps } : {}) }])),
    }) as Packument;
  const axios = packument('axios', Object.fromEntries(axiosVersions.map((v) => [v, undefined])));
  const clientFor = (parent: Packument): ReturnType<typeof createClient> => {
    const f: FetchLike = async () => new Response(JSON.stringify(parent), { status: 200, headers: { 'content-type': 'application/json' } });
    return createClient(f);
  };
  const transitive = (parent: Dependent) => ({ kind: 'transitive' as const, via: [parent], chain: [parent] });

  it('refresh: the parent range already allows a fixed version', async () => {
    const r = await planRemedy({ name: 'axios', installedVersion: '1.1.3', fixedIn: '1.2.0', relation: transitive({ name: '@line/bot-sdk', version: '8.4.1', range: '^1.0.0' }), pm: 'npm', packument: axios, client: recorded });
    expect(r).toMatchObject({ kind: 'refresh', command: 'npm update axios' });
    expect(r!.override).toBeUndefined(); // nothing to force
    expect(r!.summary).toMatch(/already allows 1\.20\.0; the lockfile just pinned 1\.1\.3/);
  });

  it('upgrade-parent, flagging a major bump (real wait-on history: 7.0.0 still pins ^0.27.2)', async () => {
    const waitOn = packument('wait-on', { '6.0.1': { axios: '^0.25.0' }, '7.0.0': { axios: '^0.27.2' }, '7.2.0': { axios: '^1.6.1' } });
    const r = await planRemedy({ name: 'axios', installedVersion: '0.25.0', fixedIn: '1.2.0', relation: transitive({ name: 'wait-on', version: '6.0.1', range: '^0.25.0' }), pm: 'npm', packument: axios, client: clientFor(waitOn) });
    expect(r).toMatchObject({ kind: 'upgrade-parent', upgradeParentTo: { version: '7.2.0', range: '^1.6.1', majorBump: true } });
    expect(r!.override!.snippet).toBe('{"overrides":{"wait-on":{"axios":"^1.2.0"}}}');
  });

  it('upgrade-parent when a newer parent drops the dependency entirely', async () => {
    const parent = packument('p', { '1.0.0': { axios: '1.1.3' }, '2.0.0': {} });
    const r = await planRemedy({ name: 'axios', installedVersion: '1.1.3', fixedIn: '1.2.0', relation: transitive({ name: 'p', version: '1.0.0', range: '1.1.3' }), pm: 'npm', packument: axios, client: clientFor(parent) });
    expect(r).toMatchObject({ kind: 'upgrade-parent', upgradeParentTo: { version: '2.0.0', range: null } });
    expect(r!.summary).toMatch(/2\.0\.0 no longer depends on axios/);
  });

  it('override when no parent release accepts a fixed version', async () => {
    const parent = packument('p', { '1.0.0': { axios: '1.1.3' }, '1.0.1': { axios: '~1.1.0' } });
    const r = await planRemedy({ name: 'axios', installedVersion: '1.1.3', fixedIn: '1.2.0', relation: transitive({ name: 'p', version: '1.0.0', range: '1.1.3' }), pm: 'pnpm', packument: axios, client: clientFor(parent) });
    expect(r).toMatchObject({ kind: 'override', override: { snippet: '{"pnpm":{"overrides":{"p>axios":"^1.2.0"}}}' } });
  });

  it('nothing for a direct dependency', async () => {
    expect(await planRemedy({ name: 'axios', installedVersion: '1.1.3', fixedIn: '1.2.0', relation: { kind: 'direct' }, pm: 'npm', packument: axios, client: recorded })).toBeUndefined();
  });

  it('rangeGetsFix', () => {
    expect(rangeGetsFix('^1.0.0', axiosVersions, '1.2.0')).toBe('1.20.0');
    expect(rangeGetsFix('1.1.3', axiosVersions, '1.2.0')).toBeUndefined();
  });
});

describe('end to end: axios/axios#5011 reached through another package (recorded)', () => {
  const auth: AuthResult = { token: 't', source: 'GITHUB_TOKEN', tried: [] };
  const stack = readFileSync(join(fixtures, 'stacks/axios-default-create.txt'), 'utf8');
  const go = (dir: string) => run(stack, { cwd: join(projects, dir), client: recorded, limit: 1, auth, repo: 'axios/axios' });

  it.each(['nest-npm', 'nest-pnpm'])('%s: @nestjs/axios@1.0.0 pins axios 1.1.3 → upgrade it to 1.0.1', async (dir) => {
    const r = await go(dir);
    const v = r.verdicts[0]!;
    expect(v).toMatchObject({
      kind: 'FIXED_UPSTREAM_UPGRADE',
      fixedIn: '1.2.0',
      installed: { version: '1.1.3' },
      relation: { kind: 'transitive', chain: [{ name: '@nestjs/axios', version: '1.0.0' }] },
      // npm's lockfile records the range; for pnpm it comes from the registry.
      remedy: { kind: 'upgrade-parent', parent: { range: '1.1.3' }, upgradeParentTo: { version: '1.0.1', range: '1.2.1', majorBump: false } },
    });
    const out = strip(formatVerdicts(r, join(projects, dir), 1));
    expect(out).toContain('Comes from: @nestjs/axios@1.0.0 (requires axios 1.1.3)');
    expect(out).toContain('→ Upgrade @nestjs/axios to >=1.0.1 (it requires axios 1.2.1, which has the fix)');
  });

  it("line-npm: @line/bot-sdk's ^1.0.0 already allows the fix → refresh the lockfile", async () => {
    const r = await go('line-npm');
    expect(r.verdicts[0]).toMatchObject({ kind: 'FIXED_UPSTREAM_UPGRADE', remedy: { kind: 'refresh', command: 'npm update axios', parent: { name: '@line/bot-sdk', range: '^1.0.0' } } });
    expect(strip(formatVerdicts(r, join(projects, 'line-npm'), 1))).toContain('Refresh it: npm update axios');
  });

  it('a direct dependency keeps the plain upgrade advice', async () => {
    const r = await go('axios-1.1.3');
    expect(r.verdicts[0]).toMatchObject({ advice: 'Upgrade to >=1.2.0', relation: { kind: 'direct' } });
    expect(r.verdicts[0]!.remedy).toBeUndefined();
  });
});
