import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findInNodeModules,
  locateLockfile,
  LockfileError,
  openLockfile,
  flattenV1,
  parsePackageLock,
  readPackageLock,
} from '../src/lockfile/index.js';

const project = join(import.meta.dirname, 'fixtures/projects/axios-app');

function tmp(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fixedin-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

describe('package-lock.json', () => {
  it('reads a real npm v3 lockfile', () => {
    const lock = readPackageLock(join(project, 'package-lock.json'));
    expect(lock.find('axios')).toEqual([
      expect.objectContaining({ name: 'axios', version: '1.5.0', location: 'node_modules/axios', topLevel: true }),
    ]);
    expect(lock.find('@prisma/client')[0]!.version).toBe('5.7.1');
    expect(lock.find('not-a-dep')).toEqual([]);
  });

  it('returns nested copies after the hoisted one and does not suffix-match other names', () => {
    const lock = parsePackageLock(
      {
        lockfileVersion: 3,
        packages: {
          '': { name: 'app' },
          'node_modules/foo/node_modules/axios': { version: '0.27.2' },
          'node_modules/axios': { version: '1.5.0' },
          'node_modules/my-axios': { version: '9.9.9' },
        },
      },
      'package-lock.json',
    );
    expect(lock.find('axios').map((p) => [p.version, p.topLevel])).toEqual([
      ['1.5.0', true],
      ['0.27.2', false],
    ]);
  });

  it('follows workspace links', () => {
    const lock = parsePackageLock(
      {
        lockfileVersion: 3,
        packages: {
          'node_modules/@acme/ui': { resolved: 'packages/ui', link: true },
          'packages/ui': { version: '2.1.0' },
        },
      },
      'package-lock.json',
    );
    expect(lock.find('@acme/ui')[0]!.version).toBe('2.1.0');
  });

  it('finds aliased packages by their real name (real npm 10 lockfile)', () => {
    // "node_modules/string-width-cjs": { "name": "string-width", "version": "4.2.3" }
    const r = readPackageLock(join(import.meta.dirname, 'fixtures/projects/npm-alias-v3/package-lock.json'));
    expect(r.find('string-width')).toEqual([expect.objectContaining({ version: '4.2.3', location: 'node_modules/string-width-cjs', topLevel: true })]);
    expect(r.find('string-width-cjs')).toEqual([]);
  });

  it('ignores the root and workspace-folder entries (only install locations count)', () => {
    const r = parsePackageLock(
      {
        lockfileVersion: 3,
        packages: {
          '': { name: 'app', version: '1.0.0' },
          'packages/ui': { name: '@acme/ui', version: '2.1.0' },
          'node_modules/@acme/ui': { resolved: 'packages/ui', link: true },
        },
      },
      'package-lock.json',
    );
    expect(r.find('@acme/ui').map((p) => p.location)).toEqual(['node_modules/@acme/ui']);
    expect(r.find('app')).toEqual([]);
  });

  it('rejects a lockfile with neither packages nor dependencies', () => {
    expect(() => parsePackageLock({ lockfileVersion: 2 }, 'package-lock.json')).toThrow(/no "packages" or "dependencies" section; fixedin reads versions 1–3/);
  });
});

describe('package-lock.json lockfileVersion 1 (npm 6)', () => {
  // Real lockfile from `npm@6.14.18 install --package-lock-only`: wait-on@6 pulls in a nested axios 0.25.
  const v1 = () => readPackageLock(join(import.meta.dirname, 'fixtures/projects/npm6-v1/package-lock.json'));

  it('reads the hoisted copy first and nested copies after it', () => {
    expect(v1().find('axios').map((p) => [p.version, p.location, p.topLevel])).toEqual([
      ['1.1.3', 'node_modules/axios', true],
      ['0.25.0', 'node_modules/wait-on/node_modules/axios', false],
    ]);
  });

  it('handles scoped, dev, aliased and file: dependencies', () => {
    const r = v1();
    expect(r.find('@tanstack/react-query')[0]!.version).toBe('5.0.0');
    expect(r.find('semver')[0]!.version).toBe('7.8.5'); // "dev": true
    expect(r.find('string-width')[0]).toMatchObject({ version: '4.2.3', location: 'node_modules/string-width-cjs' }); // npm:string-width@4.2.3
    expect(r.find('@local/ui')[0]!.version).toBe('2.1.0'); // file:local-ui → its package.json
  });

  it('flattenV1 builds v2-style install paths', () => {
    expect(
      flattenV1({ a: { version: '1.0.0', dependencies: { b: { version: '2.0.0', dependencies: { '@s/c': { version: '3.0.0' } } } } } }, '/x'),
    ).toEqual({
      'node_modules/a': { version: '1.0.0' },
      'node_modules/a/node_modules/b': { version: '2.0.0' },
      'node_modules/a/node_modules/b/node_modules/@s/c': { version: '3.0.0' },
    });
  });

  it('accepts a v1 lockfile with no dependencies', () => {
    expect(parsePackageLock({ lockfileVersion: 1 }, 'package-lock.json').find('axios')).toEqual([]);
  });

  it('prefers "packages" when a v2 lockfile carries both sections', () => {
    const r = parsePackageLock(
      { lockfileVersion: 2, packages: { 'node_modules/axios': { version: '1.5.0' } }, dependencies: { axios: { version: '0.0.1' } } },
      'package-lock.json',
    );
    expect(r.find('axios').map((p) => p.version)).toEqual(['1.5.0']);
  });

  it('reports unparseable JSON with the path', () => {
    const dir = tmp({ 'package-lock.json': '{ nope' });
    expect(() => readPackageLock(join(dir, 'package-lock.json'))).toThrow(LockfileError);
  });
});

describe('locateLockfile', () => {
  it('walks up from a monorepo package to the workspace root', () => {
    const dir = tmp({ 'package-lock.json': '{}', 'packages/web/package.json': '{}' });
    const { found, tried } = locateLockfile(join(dir, 'packages/web'));
    expect(found).toEqual({ kind: 'package-lock', path: join(dir, 'package-lock.json') });
    expect(tried[0]).toBe(join(dir, 'packages/web/package-lock.json'));
  });

  it('detects yarn.lock and reports an empty one clearly', () => {
    const dir = tmp({ 'yarn.lock': '' });
    const { found } = locateLockfile(dir);
    expect(found?.kind).toBe('yarn');
    expect(() => openLockfile(found!)).toThrow(/yarn\.lock is empty/);
  });
});

describe('findInNodeModules', () => {
  it('reads the installed package.json', () => {
    const dir = tmp({ 'node_modules/@scope/pkg/package.json': '{"version":"3.2.1"}' });
    expect(findInNodeModules(dir, '@scope/pkg').found?.version).toBe('3.2.1');
  });

  it('does not walk above the project root', () => {
    const dir = tmp({ 'node_modules/leftpad/package.json': '{"version":"1.0.0"}', 'app/package-lock.json': '{}' });
    const r = findInNodeModules(join(dir, 'app'), 'leftpad', join(dir, 'app'));
    expect(r.found).toBeUndefined();
    expect(r.tried).toEqual([join(dir, 'app/node_modules/leftpad/package.json')]);
  });
});
