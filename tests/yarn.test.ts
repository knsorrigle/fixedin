import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detect } from '../src/detect.js';
import type { AuthResult } from '../src/github/auth.js';
import { locateLockfile, openLockfile } from '../src/lockfile/index.js';
import {
  aliasTarget,
  isYarnBerry,
  normalizeBerryRange,
  parseClassic,
  parseYarnLock,
  readYarnLock,
  splitDescriptor,
  splitKeyList,
} from '../src/lockfile/yarn.js';
import { createClient, replayFetch } from '../src/net/client.js';
import { run } from '../src/pipeline.js';

const projects = join(import.meta.dirname, 'fixtures/projects');
const lock = (dir: string, cwd = dir) => readYarnLock(join(projects, dir, 'yarn.lock'), join(projects, cwd));
const versions = (r: ReturnType<typeof lock>, name: string) => r.find(name).map((p) => `${p.version}${p.topLevel ? '*' : ''}`);

describe('yarn descriptor helpers', () => {
  it.each([
    ['axios@npm:1.1.3', { name: 'axios', range: 'npm:1.1.3' }],
    ['@scope/pkg@^1.0.0', { name: '@scope/pkg', range: '^1.0.0' }],
    ['string-width-cjs@npm:string-width@^4.2.0', { name: 'string-width-cjs', range: 'npm:string-width@^4.2.0' }],
    ['typescript@patch:typescript@npm%3A6.0.2#optional!builtin<compat/typescript>', { name: 'typescript', range: 'patch:typescript@npm%3A6.0.2#optional!builtin<compat/typescript>' }],
  ])('splitDescriptor(%s)', (d, expected) => {
    expect(splitDescriptor(d)).toEqual(expected);
  });

  it('aliasTarget / normalizeBerryRange / splitKeyList', () => {
    expect(aliasTarget('npm:string-width@^4.2.0')).toBe('string-width');
    expect(aliasTarget('npm:@scope/real@1.0.0')).toBe('@scope/real');
    expect(aliasTarget('^4.2.0')).toBeUndefined();
    expect(normalizeBerryRange('1.1.3')).toBe('npm:1.1.3'); // yarn 2 style
    expect(normalizeBerryRange('npm:1.1.3')).toBe('npm:1.1.3');
    expect(normalizeBerryRange('workspace:*')).toBe('workspace:*');
    expect(splitKeyList('"@babel/core@^7.0.0", "@babel/core@^7.1.0"')).toEqual(['@babel/core@^7.0.0', '@babel/core@^7.1.0']);
    expect(splitKeyList('call-bind@npm:^1.0.1, call-bind@npm:^1.0.2')).toEqual(['call-bind@npm:^1.0.1', 'call-bind@npm:^1.0.2']);
  });

  it('parses classic entries and fails loudly on malformed ones', () => {
    const text = '# yarn lockfile v1\n\n\n"a@^1.0.0", a@^1.1.0:\n  version "1.2.0"\n  resolved "x"\n  dependencies:\n    b "^2"\n';
    expect(parseClassic(text, 'yarn.lock')).toEqual([{ keys: ['a@^1.0.0', 'a@^1.1.0'], version: '1.2.0', dependencies: { b: '^2' } }]);
    expect(() => parseClassic('a@^1:\n  resolved "x"\n', 'yarn.lock')).toThrow(/line 1 has no version/);
    expect(() => parseClassic('not a header\n', 'yarn.lock')).toThrow(/line 1 is not an entry header/);
  });

  it('detects the format and rejects anything else', () => {
    expect(isYarnBerry('__metadata:\n  version: 10\n')).toBe(true);
    expect(isYarnBerry('# yarn lockfile v1\n')).toBe(false);
    expect(() => parseYarnLock('', 'yarn.lock')).toThrow(/is empty/);
    expect(() => parseYarnLock('lockfileVersion: 9.0\n', 'yarn.lock')).toThrow(/neither a yarn classic/);
  });
});

describe('real yarn lockfiles', () => {
  // Generated with yarn 1.22.22 and @yarnpkg/cli-dist 2.4.2 / 3.8.7 / 4.18.1 from the same package.json.
  it.each([
    ['yarn-v1', 'classic (yarn 1)'],
    ['yarn-v2', 'Berry, __metadata 4 (yarn 2, ranges without npm:)'],
    ['yarn-v3', 'Berry, __metadata 6 (yarn 3)'],
    ['yarn-v4', 'Berry, __metadata 10 (yarn 4)'],
  ])('%s — %s', (dir) => {
    const r = lock(dir);
    expect(r.kind).toBe('yarn');
    expect(versions(r, 'axios')).toEqual(['1.1.3*']);
    expect(versions(r, 'react-dom')).toEqual(['18.2.0*']);
    expect(versions(r, '@tanstack/react-query')).toEqual(['5.0.0*']);
    expect(versions(r, '@tanstack/query-core')).toEqual(['5.0.0']); // transitive
    expect(versions(r, 'semver')).toEqual(['7.8.5*']); // devDependency ^7.5.4
    expect(versions(r, 'string-width')).toEqual(['4.2.3*']); // via npm: alias string-width-cjs
    expect(r.find('not-a-dep')).toEqual([]);
  });

  it.each(['yarn-workspace-v1', 'yarn-workspace-v4'])('%s — workspace chosen by --cwd', (dir) => {
    expect(versions(lock(dir), 'axios')).toEqual(['1.5.0*', '1.1.3']);
    const web = lock(dir, `${dir}/packages/web/src`);
    expect(versions(web, 'axios')).toEqual(['1.1.3*', '1.5.0']);
    expect(web.find('axios')[0]!.location).toBe('packages/web/node_modules/axios');
    expect(versions(web, 'string-width')).toEqual(['4.2.3*']);
    // Classic doesn't lock workspace siblings; Berry marks them 0.0.0-use.local. Both read package.json.
    expect(web.find('@mono/ui')[0]).toMatchObject({ version: '2.1.0', topLevel: true, source: expect.stringMatching(/packages[\\/]ui[\\/]package\.json$/) });
  });

  it('resolves yarn catalogs through .yarnrc.yml (real yarn 4.18 lockfile)', () => {
    const r = lock('yarn-catalog-v4');
    expect(versions(r, 'axios')).toEqual(['1.1.3*']); // catalog:
    expect(versions(r, 'semver')).toEqual(['7.8.5*']); // catalog:dev
    expect(r.warnings).toEqual([]);
  });

  it('is found from inside a workspace package and opened for that package', () => {
    const cwd = join(projects, 'yarn-workspace-v4/packages/web');
    const { found } = locateLockfile(cwd);
    expect(found).toEqual({ kind: 'yarn', path: join(projects, 'yarn-workspace-v4/yarn.lock') });
    expect(openLockfile(found!, cwd).find('axios')[0]!.version).toBe('1.1.3');
  });
});

describe('Berry: unmatched descriptors', () => {
  const berry = (catalogRc?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'fixedin-yarn-'));
    const text = readFileSync(join(projects, 'yarn-catalog-v4/yarn.lock'), 'utf8')
      // Add a second locked axios so a guess would be ambiguous.
      .replace(
        '"axios@npm:1.1.3":',
        '"axios@npm:1.5.0":\n  version: 1.5.0\n  resolution: "axios@npm:1.5.0"\n  languageName: node\n  linkType: hard\n\n"axios@npm:1.1.3":',
      );
    writeFileSync(join(dir, 'yarn.lock'), text);
    if (catalogRc !== undefined) writeFileSync(join(dir, '.yarnrc.yml'), catalogRc);
    return readYarnLock(join(dir, 'yarn.lock'), dir);
  };

  it('never guesses between several locked versions, and says why', () => {
    const r = berry(); // no .yarnrc.yml → catalog: can't be resolved
    expect(r.find('axios').every((p) => !p.topLevel)).toBe(true);
    expect(r.warnings?.[0]).toMatch(/axios@catalog: .* 2 versions are locked \(1\.5\.0, 1\.1\.3\); not guessing/);
  });

  it('uses the only locked version when unambiguous', () => {
    expect(berry().find('semver')[0]).toMatchObject({ version: '7.8.5', topLevel: true });
  });

  it('reports an unreadable .yarnrc.yml instead of ignoring it', () => {
    const r = berry('catalog:\n  axios: &anchor 1.1.3\n');
    r.find('axios');
    expect(r.warnings?.some((w) => /Could not read catalogs from .*\.yarnrc\.yml: line 2: anchors/.test(w))).toBe(true);
  });

  it('surfaces reader warnings as lockfile diagnostics', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixedin-yarn-'));
    writeFileSync(join(dir, 'yarn.lock'), readFileSync(join(projects, 'yarn-catalog-v4/yarn.lock'), 'utf8'));
    writeFileSync(join(dir, '.yarnrc.yml'), 'catalog:\n  axios: *oops\n');
    const client = createClient(replayFetch(join(import.meta.dirname, 'fixtures/http')));
    const d = await detect('Error: x\n    at f (/app/node_modules/axios/lib/core/Axios.js:1:1)', { cwd: dir, client });
    expect(d.diagnostics.items).toContainEqual(expect.objectContaining({ level: 'warn', stage: 'lockfile', message: expect.stringMatching(/Could not read catalogs/) }));
  });
});

describe('verdicts from yarn projects (recorded)', () => {
  const client = createClient(replayFetch(join(import.meta.dirname, 'fixtures/http')));
  const auth: AuthResult = { token: 't', source: 'GITHUB_TOKEN', tried: [] };
  const stack = readFileSync(join(import.meta.dirname, 'fixtures/stacks/axios-default-create.txt'), 'utf8');

  it.each(['yarn-v1', 'yarn-v4', 'yarn-catalog-v4'])('%s: axios 1.1.3 → upgrade', async (dir) => {
    const r = await run(stack, { cwd: join(projects, dir), client, limit: 3, auth, repo: 'axios/axios' });
    expect(r.detect.lockfile?.kind).toBe('yarn');
    expect(r.verdicts[0]).toMatchObject({ kind: 'FIXED_UPSTREAM_UPGRADE', installed: { version: '1.1.3' }, fixedIn: '1.2.0' });
  });

  it('classic workspace: a different verdict per package', async () => {
    const dir = join(projects, 'yarn-workspace-v1');
    const web = await run(stack, { cwd: join(dir, 'packages/web'), client, limit: 3, auth, repo: 'axios/axios' });
    const root = await run(stack, { cwd: dir, client, limit: 3, auth, repo: 'axios/axios' });
    expect(web.verdicts[0]).toMatchObject({ kind: 'FIXED_UPSTREAM_UPGRADE', installed: { version: '1.1.3' } });
    expect(root.verdicts[0]).toMatchObject({ kind: 'ALREADY_HAVE_FIX', installed: { version: '1.5.0' } });
  });
});
