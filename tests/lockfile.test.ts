import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findInNodeModules,
  locateLockfile,
  LockfileError,
  openLockfile,
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

  it('rejects lockfileVersion 1 with a remedy', () => {
    expect(() => parsePackageLock({ lockfileVersion: 1 }, 'package-lock.json')).toThrow(/npm install --package-lock-only/);
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
