import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClient, replayFetch } from '../src/net/client.js';
import { parseGitHubUrl, parseRepository, registryUrl, resolveRepo, ResolveError } from '../src/resolve/index.js';

const client = createClient(replayFetch(join(import.meta.dirname, 'fixtures/http')));

describe('parseRepository', () => {
  it.each([
    ['git+https://github.com/axios/axios.git', { owner: 'axios', repo: 'axios' }],
    ['https://github.com/axios/axios', { owner: 'axios', repo: 'axios' }],
    ['git://github.com/axios/axios.git', { owner: 'axios', repo: 'axios' }],
    ['git+ssh://git@github.com/axios/axios.git', { owner: 'axios', repo: 'axios' }],
    ['git@github.com:axios/axios.git', { owner: 'axios', repo: 'axios' }],
    ['github:vercel/next.js', { owner: 'vercel', repo: 'next.js' }],
    ['vercel/next.js', { owner: 'vercel', repo: 'next.js' }],
    ['https://www.github.com/facebook/react#readme', { owner: 'facebook', repo: 'react' }],
    [
      'https://github.com/prisma/prisma/tree/main/packages/client',
      { owner: 'prisma', repo: 'prisma', directory: 'packages/client' },
    ],
  ])('%s', (input, expected) => {
    expect(parseRepository(input)).toEqual(expected);
  });

  it('keeps the monorepo directory from the object form', () => {
    expect(
      parseRepository({ type: 'git', url: 'https://github.com/facebook/react.git', directory: './packages/react-dom/' }),
    ).toEqual({ owner: 'facebook', repo: 'react', directory: 'packages/react-dom' });
  });

  it.each(['gitlab:foo/bar', 'https://gitlab.com/foo/bar.git', 'https://bitbucket.org/a/b', 'not a url', ''])(
    'rejects non-GitHub %j',
    (input) => {
      expect(parseRepository(input)).toBeUndefined();
    },
  );

  it('rejects a bare host with no repo', () => {
    expect(parseGitHubUrl('https://github.com/axios')).toBeUndefined();
  });
});

describe('registryUrl', () => {
  it('encodes scoped names', () => {
    expect(registryUrl('@prisma/client', '/latest')).toBe('https://registry.npmjs.org/@prisma%2Fclient/latest');
    expect(registryUrl('axios')).toBe('https://registry.npmjs.org/axios');
  });
});

describe('resolveRepo (recorded registry responses)', () => {
  it('resolves a simple package', async () => {
    expect(await resolveRepo(client, 'axios')).toMatchObject({ owner: 'axios', repo: 'axios', via: 'repository' });
  });

  it('resolves a scoped monorepo package with a directory', async () => {
    expect(await resolveRepo(client, '@prisma/client')).toMatchObject({
      owner: 'prisma',
      repo: 'prisma',
      directory: 'packages/client',
    });
  });

  it('fails loudly, naming the URL, when there is no recording (i.e. no network in tests)', async () => {
    const err = await resolveRepo(client, 'definitely-not-recorded-pkg').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResolveError);
    expect((err as ResolveError).tried).toEqual(['https://registry.npmjs.org/definitely-not-recorded-pkg/latest']);
    expect((err as Error).message).toMatch(/No recorded fixture/);
  });
});
