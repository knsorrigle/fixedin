import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuthResult } from '../src/github/auth.js';
import { locateLockfile, openLockfile } from '../src/lockfile/index.js';
import {
  parsePackageKey,
  parsePnpmLock,
  readPnpmLock,
  resolveDepVersion,
  selectImporter,
  stripPeerSuffix,
} from '../src/lockfile/pnpm.js';
import { parseYamlSubset, splitDocuments } from '../src/lockfile/yaml.js';
import { createClient, replayFetch } from '../src/net/client.js';
import { run } from '../src/pipeline.js';

const projects = join(import.meta.dirname, 'fixtures/projects');
const lock = (dir: string, cwd = dir) => readPnpmLock(join(projects, dir, 'pnpm-lock.yaml'), join(projects, cwd));
const versions = (r: ReturnType<typeof lock>, name: string) => r.find(name).map((p) => `${p.version}${p.topLevel ? '*' : ''}`);

describe('YAML subset reader', () => {
  it('reads nested maps, quoted keys and keeps flow collections raw', () => {
    const doc = parseYamlSubset(
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        "      '@scope/pkg':",
        '        specifier: ^1.0.0',
        '        version: 1.2.0',
        "      'it''s':",
        '        version: "2.0.0"',
        'packages:',
        "  '@scope/pkg@1.2.0':",
        '    resolution: {integrity: sha512-abc==}',
        '    cpu: [x64]',
        '    transitivePeerDependencies:',
        '      - supports-color',
        '      - debug',
        '    dev: false',
      ].join('\n'),
    );
    expect(doc).toEqual({
      lockfileVersion: '9.0',
      importers: { '.': { dependencies: { '@scope/pkg': { specifier: '^1.0.0', version: '1.2.0' }, "it's": { version: '2.0.0' } } } },
      packages: { '@scope/pkg@1.2.0': { resolution: '{integrity: sha512-abc==}', cpu: '[x64]', transitivePeerDependencies: '', dev: 'false' } },
    });
  });

  it('handles block scalars and quoted strings wrapped over lines (pnpm deprecation messages)', () => {
    const doc = parseYamlSubset(
      [
        'a:',
        '  deprecated: |-',
        '    line one',
        '    line two',
        '  folded: >',
        '    joined',
        '    words',
        "  wrapped: 'this message was",
        "    wrapped by the serializer'",
        '  next: ok',
      ].join('\n'),
    );
    expect(doc.a).toEqual({ deprecated: 'line one\nline two', folded: 'joined words\n', wrapped: 'this message was wrapped by the serializer', next: 'ok' });
  });

  it('splits multi-document lockfiles', () => {
    expect(splitDocuments('---\nlockfileVersion: 9.0\n\n---\nlockfileVersion: 9.0\nimporters:\n')).toHaveLength(2);
  });

  it('rejects what it cannot read, naming the line', () => {
    expect(() => parseYamlSubset('a: &anchor 1')).toThrow(/line 1: anchors/);
    expect(() => parseYamlSubset('a:\n    b: 1\n  c: 2')).toThrow(/line 3: unexpected indentation/);
    expect(() => parseYamlSubset("a: 'never closed")).toThrow(/line 1: unterminated/);
  });
});

describe('pnpm key/version formats', () => {
  it.each([
    ['18.2.0_react@18.2.0', 5, '18.2.0'],
    ['5.0.0_biqbaboplfbrettd7655fr4n2y', 5, '5.0.0'],
    ['18.2.0(react@18.2.0)', 6, '18.2.0'],
    ['5.0.0(react-dom@18.2.0(react@18.2.0))(react@18.2.0)', 9, '5.0.0'],
    ['1.1.3', 9, '1.1.3'],
  ])('stripPeerSuffix(%s, v%i)', (v, major, expected) => {
    expect(stripPeerSuffix(v, major)).toBe(expected);
  });

  it.each([
    ['/@tanstack/react-query/5.0.0_biqbaboplfbrettd7655fr4n2y', 5, { name: '@tanstack/react-query', version: '5.0.0' }],
    ['/axios/1.1.3', 5, { name: 'axios', version: '1.1.3' }],
    ['/@tanstack/react-query@5.0.0(react-dom@18.2.0)(react@18.2.0)', 6, { name: '@tanstack/react-query', version: '5.0.0' }],
    ['@tanstack/react-query@5.0.0(react-dom@18.2.0(react@18.2.0))(react@18.2.0)', 9, { name: '@tanstack/react-query', version: '5.0.0' }],
    ['axios@1.1.3', 9, { name: 'axios', version: '1.1.3' }],
  ])('parsePackageKey(%s, v%i)', (key, major, expected) => {
    expect(parsePackageKey(key, major)).toEqual(expected);
  });

  it('resolves links, aliases (all three spellings) and non-registry sources', () => {
    expect(resolveDepVersion('@mono/ui', 'link:../ui', 9)).toEqual({ kind: 'link', path: '../ui' });
    for (const [raw, major] of [['/string-width/4.2.3', 5], ['/string-width@4.2.3', 6], ['string-width@4.2.3', 9]] as const) {
      expect(resolveDepVersion('string-width-cjs', raw, major)).toEqual({ kind: 'version', ref: { name: 'string-width', version: '4.2.3' } });
    }
    expect(resolveDepVersion('x', 'file:../x.tgz', 9).kind).toBe('other');
    expect(resolveDepVersion('react-dom', '18.2.0(react@18.2.0)', 9)).toEqual({ kind: 'version', ref: { name: 'react-dom', version: '18.2.0' } });
  });

  it('selects the deepest importer containing cwd', () => {
    const ids = ['.', 'packages/web', 'packages/web-admin', 'apps/api'];
    expect(selectImporter(ids, '/repo', '/repo')).toBe('.');
    expect(selectImporter(ids, '/repo', '/repo/packages/web/src/pages')).toBe('packages/web');
    expect(selectImporter(ids, '/repo', '/repo/packages/web-admin')).toBe('packages/web-admin');
    expect(selectImporter(ids, '/repo', '/repo/tools')).toBe('.');
    expect(selectImporter(['packages/a'], '/repo', '/repo')).toBeUndefined();
  });
});

describe('real pnpm lockfiles', () => {
  // Generated with `pnpm@<v> install --lockfile-only` from the same package.json.
  it.each([
    ['pnpm-v7', '5.4 (pnpm 7)'],
    ['pnpm-v8', '6.0 (pnpm 8)'],
    ['pnpm-v9', '9.0 (pnpm 9)'],
    ['pnpm-v12', '9.0 (pnpm 12)'],
  ])('%s — lockfileVersion %s', (dir) => {
    const r = lock(dir);
    expect(r.kind).toBe('pnpm');
    expect(versions(r, 'axios')).toEqual(['1.1.3*']);
    expect(versions(r, 'react-dom')).toEqual(['18.2.0*']);
    expect(versions(r, '@tanstack/react-query')).toEqual(['5.0.0*']);
    expect(versions(r, '@tanstack/query-core')).toEqual(['5.0.0']); // transitive
    expect(versions(r, 'semver')).toEqual(['7.5.4*']); // devDependency
    expect(r.find('not-a-dep')).toEqual([]);
  });

  it.each(['pnpm-workspace-v8', 'pnpm-workspace-v12'])('%s — importer chosen by --cwd', (dir) => {
    const root = lock(dir);
    expect(versions(root, 'axios')).toEqual(['1.5.0*', '1.1.3']);
    const web = lock(dir, `${dir}/packages/web/src`);
    expect(versions(web, 'axios')).toEqual(['1.1.3*', '1.5.0']);
    expect(web.find('axios')[0]!.location).toBe('packages/web/node_modules/axios');
    expect(versions(web, 'string-width')).toEqual(['4.2.3*']); // via the npm: alias string-width-cjs
    expect(web.find('@mono/ui')[0]).toMatchObject({ version: '2.1.0', topLevel: true }); // workspace:* link
  });

  it('is found from inside a workspace package and opened for that importer', () => {
    const cwd = join(projects, 'pnpm-workspace-v12/packages/web');
    const { found } = locateLockfile(cwd);
    expect(found).toEqual({ kind: 'pnpm', path: join(projects, 'pnpm-workspace-v12/pnpm-lock.yaml') });
    expect(openLockfile(found!, cwd).find('axios')[0]!.version).toBe('1.1.3');
  });

  it('rejects unsupported lockfile versions and junk with a clear message', () => {
    expect(() => parsePnpmLock("lockfileVersion: '10.0'\nimporters:\n  .: {}\n", 'pnpm-lock.yaml')).toThrow(/5\.x, 6\.0 and 9\.0/);
    expect(() => parsePnpmLock('', 'pnpm-lock.yaml')).toThrow(/no importers, dependencies or packages/);
    expect(() => parsePnpmLock('lockfileVersion: 9.0\nimporters:\n\ta: 1\n', 'pnpm-lock.yaml')).toThrow(/Could not parse pnpm-lock.yaml: line 3/);
  });
});

describe('verdicts from pnpm projects (recorded)', () => {
  const client = createClient(replayFetch(join(import.meta.dirname, 'fixtures/http')));
  const auth: AuthResult = { token: 't', source: 'GITHUB_TOKEN', tried: [] };
  const stack = readFileSync(join(import.meta.dirname, 'fixtures/stacks/axios-default-create.txt'), 'utf8');

  it('single project: axios 1.1.3 from pnpm-lock.yaml → upgrade', async () => {
    const r = await run(stack, { cwd: join(projects, 'pnpm-v12'), client, limit: 3, auth, repo: 'axios/axios' });
    expect(r.detect.lockfile?.kind).toBe('pnpm');
    expect(r.verdicts[0]).toMatchObject({ kind: 'FIXED_UPSTREAM_UPGRADE', installed: { version: '1.1.3' }, fixedIn: '1.2.0' });
  });

  it('workspace: the same error gets a different verdict per package', async () => {
    const dir = join(projects, 'pnpm-workspace-v12');
    const web = await run(stack, { cwd: join(dir, 'packages/web'), client, limit: 3, auth, repo: 'axios/axios' });
    const root = await run(stack, { cwd: dir, client, limit: 3, auth, repo: 'axios/axios' });
    expect(web.verdicts[0]).toMatchObject({ kind: 'FIXED_UPSTREAM_UPGRADE', installed: { version: '1.1.3' } });
    expect(root.verdicts[0]).toMatchObject({ kind: 'ALREADY_HAVE_FIX', installed: { version: '1.5.0' } });
  });
});
