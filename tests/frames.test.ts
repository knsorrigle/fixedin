/**
 * Matching errors that have no identifier ("fetch failed", "Cannot use import
 * statement…") by where in the package they failed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuthResult } from '../src/github/auth.js';
import { createGitHub } from '../src/github/client.js';
import { createClient, replayFetch, type FetchLike } from '../src/net/client.js';
import { extractPackages, packageFrame } from '../src/parse/index.js';
import { run } from '../src/pipeline.js';
import { findFixRelease, releaseLineOf, type Packument } from '../src/release/index.js';
import {
  ANCHOR_MISS_CAP,
  fileTail,
  frameEvidence,
  informative,
  methodName,
  similarity,
  TOP_FRAME_FLOOR,
  unhash,
  WEAK_FRAME_FLOOR,
} from '../src/search/similarity.js';
import { MATCH_THRESHOLD, STRONG_MATCH } from '../src/verdict/index.js';

const fixtures = join(import.meta.dirname, 'fixtures');

describe('packageFrame', () => {
  it.each([
    ['    at settle (/app/node_modules/axios/lib/core/settle.js:19:34)', 'axios', { fn: 'settle', file: 'lib/core/settle.js' }],
    ['    at async invokeRequest (D:\\x\\node_modules\\next\\dist\\server\\lib\\server-ipc\\invoke-request.js:17:12)', 'next', { fn: 'invokeRequest', file: 'dist/server/lib/server-ipc/invoke-request.js' }],
    ['    at Axios.<computed> [as get] (/a/node_modules/axios/lib/core/Axios.js:136:17)', 'axios', { fn: 'Axios.get', file: 'lib/core/Axios.js' }],
    ['    at wrap [as get] (/a/node_modules/axios/lib/helpers/bind.js:9:15)', 'axios', { fn: 'wrap', file: 'lib/helpers/bind.js' }],
    ['    at /a/node_modules/axios/lib/core/Axios.js:1:1', 'axios', { file: 'lib/core/Axios.js' }],
    ['    at Object.<anonymous> (/a/node_modules/nanoid/index.browser.js:1:1)', 'nanoid', { file: 'index.browser.js' }], // module top level: no function
    ['    at new Client (/a/node_modules/pg/lib/client.js:1:1)', 'pg', { fn: 'Client', file: 'lib/client.js' }],
    ['    at AxiosError.from (file:///u/Library/Caches/deno/npm/registry.npmjs.org/axios/1.1.3/lib/core/AxiosError.js:89:14)', 'axios', { fn: 'AxiosError.from', file: 'lib/core/AxiosError.js' }],
    ['    at f (/a/node_modules/.pnpm/axios@1.1.3/node_modules/axios/dist/node/axios.cjs:3151:10)', 'axios', { fn: 'f', file: 'dist/node/axios.cjs' }],
    ['useQuery@http://localhost:5173/node_modules/@tanstack/query/build/x.js?v=abc:3120:11', '@tanstack/query', { fn: 'useQuery', file: 'build/x.js' }],
  ])('%s', (line, name, expected) => {
    expect(packageFrame(line, name)).toEqual(expected);
  });

  it('is not fooled by a non-frame line mentioning the path', () => {
    expect(packageFrame('Error loading /app/node_modules/axios/index.js', 'axios')).toBeUndefined();
  });

  it('keeps up to three distinct frames per package, throw site first', () => {
    const lines = ['Error: x', ...['a', 'b', 'b', 'c', 'd'].map((f) => `    at ${f} (/app/node_modules/pkg/lib/${f}.js:1:1)`)];
    expect(extractPackages(lines)[0]!.frames!.map((f) => f.fn)).toEqual(['a', 'b', 'c']);
  });
});

describe('what counts as an informative frame', () => {
  it.each([
    [{ fn: 'settle', file: 'lib/core/settle.js' }, true],
    [{ fn: 'invokeRequest', file: 'dist/server/lib/server-ipc/invoke-request.js' }, true],
    [{ fn: 'Function.AxiosError.from', file: 'lib/core/AxiosError.js' }, false], // error factory
    [{ fn: 'In.handleRequestError', file: 'runtime/library.js' }, false], // error reporter (every Prisma error)
    [{ fn: 'Axios.request', file: 'lib/core/Axios.js' }, false], // generic
    [{ file: 'index.browser.js' }, true], // anonymous, but a small source file
    [{ file: 'dist/node/axios.cjs' }, false], // anonymous in a bundle: says nothing
  ])('%j → %s', (frame, expected) => {
    expect(informative(frame)).toBe(expected);
  });

  it('normalizes names and build hashes', () => {
    expect(methodName('Function.AxiosError.from')).toBe('from');
    expect(methodName('Object.<anonymous>')).toBe('Object');
    expect(unhash('dist/node/chunks/dep-8f5c9b2e.js')).toBe('dist/node/chunks/dep.js');
    expect(unhash('dist/node/chunks/dep-D-7EJmVm.js')).toBe('dist/node/chunks/dep.js');
    expect(unhash('lib/event-listener.js')).toBe('lib/event-listener.js'); // a word, not a hash
    expect(fileTail('dist/server/lib/server-ipc/invoke-request.js')).toBe('server-ipc/invoke-request.js');
  });
});

describe('frame evidence and scoring', () => {
  const ours = [
    { fn: 'loadConfigFromBundledFile', file: 'dist/node/chunks/dep-8f5c9b2e.js' },
    { fn: 'loadConfigFromFile', file: 'dist/node/chunks/dep-8f5c9b2e.js' },
  ];
  const trace = (fns: string[], hash = 'Ab12Cd34') => fns.map((f) => `    at ${f} (file:///p/node_modules/vite/dist/node/chunks/dep-${hash}.js:1:1)`).join('\n');

  it('the same throw site, even from a build with different chunk hashes', () => {
    expect(frameEvidence(trace(['loadConfigFromBundledFile', 'loadConfigFromFile']), 'vite', ours)).toEqual({ matched: 2, of: 2, top: true, otherTrace: false });
  });

  it('a different path through the same package', () => {
    expect(frameEvidence(trace(['transformRequest', 'handleHMRUpdate']), 'vite', ours)).toMatchObject({ matched: 0, otherTrace: true });
  });

  it('no trace at all is neutral', () => {
    expect(frameEvidence('It crashes when I start the dev server.', 'vite', ours)).toMatchObject({ matched: 0, otherTrace: false });
  });

  it('no informative frames → no evidence (Prisma error plumbing)', () => {
    expect(frameEvidence('anything', '@prisma/client', [{ fn: 'In.handleRequestError', file: 'runtime/library.js' }])).toBeUndefined();
  });

  const ctx = { pkg: 'vite', frames: ours };
  const q = 'Error [ERR_REQUIRE_ESM]: require() of ES Module not supported.';

  it('lifts an anchorless issue with the same throw site: strong with message overlap, weak without', () => {
    const strong = similarity(q, 'require() of ES Module not supported in vite.config', trace(['loadConfigFromBundledFile']), ctx);
    expect(strong.score).toBeGreaterThanOrEqual(TOP_FRAME_FLOOR);
    expect(TOP_FRAME_FLOOR).toBeGreaterThanOrEqual(STRONG_MATCH);
    const weak = similarity(q, 'Dev server crashes', trace(['loadConfigFromBundledFile']), ctx);
    expect(weak.score).toBe(WEAK_FRAME_FLOOR);
    expect(WEAK_FRAME_FLOOR).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(WEAK_FRAME_FLOOR).toBeLessThan(STRONG_MATCH);
  });

  it('caps an issue that pasted a different trace through the package', () => {
    const s = similarity(q, 'require() of ES Module not supported', trace(['transformRequest', 'handleHMRUpdate']), ctx);
    expect(s.score).toBeLessThanOrEqual(ANCHOR_MISS_CAP);
    expect(s.frames).toMatchObject({ otherTrace: true });
  });

  it('frames are ignored when the message has its own anchor', () => {
    const s = similarity('TypeError: adapter is not a function', 'unrelated', trace(['transformRequest', 'x']), ctx);
    expect(s.frames).toBeUndefined();
  });
});

describe('release search on maintenance branches', () => {
  it.each([
    ['v3.1', '3.1.x'],
    ['1.x', '1.x'],
    ['v1.x', '1.x'],
    ['release-2', '2.x'],
    ['main', undefined],
    ['next', undefined],
  ])('releaseLineOf(%s) = %s', (branch, line) => {
    expect(releaseLineOf(branch)).toBe(line);
  });

  // Shaped like vite: the fix went to v3.1 → 3.1.6; mainline 3.2.0+ diverged.
  const versions: Array<[string, string]> = [
    ['3.1.5', '2022-10-06T01:00:00Z'],
    ['3.1.6', '2022-10-06T20:00:00Z'],
    ['3.1.7', '2022-10-10T00:00:00Z'],
    ['3.2.0', '2022-10-26T00:00:00Z'],
    ['4.0.0', '2022-12-09T00:00:00Z'],
    ['5.0.0', '2023-11-16T00:00:00Z'],
    ['6.0.0', '2024-11-26T00:00:00Z'],
  ];
  const packument: Packument = {
    name: 'vite',
    versions: Object.fromEntries(versions.map(([v]) => [v, { version: v, gitHead: `g${v}` }])),
    time: Object.fromEntries(versions),
  };
  const contains = new Set(['g3.1.6', 'g3.1.7']);
  const gh = () => {
    const calls: string[] = [];
    const f: FetchLike = async (input) => {
      const ref = decodeURIComponent(new URL(input instanceof Request ? input.url : input.toString()).pathname).split('...')[1]!;
      calls.push(ref);
      return new Response(JSON.stringify({ status: contains.has(ref) ? 'ahead' : 'diverged' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { gh: createGitHub(createClient(f), 't'), calls };
  };
  const repo = { owner: 'vitejs', repo: 'vite' };

  it('searches only the branch\'s release line', async () => {
    const { gh: g, calls } = gh();
    const r = await findFixRelease(g, repo, packument, 'fix', { mergedAt: '2022-10-06T13:30:28Z', baseRef: 'v3.1' });
    expect(r.fixedIn).toBe('3.1.6');
    expect(calls.every((c) => c.startsWith('g3.1.'))).toBe(true);
  });

  it('without the branch hint, checks releases in date order before calling it unreleased', async () => {
    const { gh: g } = gh();
    const r = await findFixRelease(g, repo, packument, 'fix', { mergedAt: '2022-10-06T13:30:28Z', baseRef: 'backport-fixes' });
    expect(r.fixedIn).toBe('3.1.6');
    expect(r.notes.join(' ')).toMatch(/date order/);
  });
});

describe('end to end (recorded)', () => {
  const client = createClient(replayFetch(join(fixtures, 'http')));
  const auth: AuthResult = { token: 't', source: 'GITHUB_TOKEN', tried: [] };
  const go = (trace: string, limit = 5) =>
    run(readFileSync(join(fixtures, 'stacks', `${trace}.txt`), 'utf8'), { cwd: join(fixtures, 'projects/axios-app'), client, limit, auth });

  it('next "fetch failed": the frame search finds the canonical issue with the same invokeRequest trace', async () => {
    const r = await go('next-server');
    expect(r.searches[0]!.attempts.find((a) => a.purpose === 'frames')).toMatchObject({ requested: 'lexical', totalCount: 26 });
    expect(r.verdicts[0]!.match).toMatchObject({ number: 54961, similarity: { frames: { top: true } } });
  });

  it('jest + nanoid: the shared index.browser.js frame picks the exact issue', async () => {
    expect((await go('jest-suite')).verdicts[0]!.match!.number).toBe(462);
  });

  it('vite: a fix merged into the v3.1 branch is found in 3.1.6', async () => {
    const v = (await go('vite-esm')).verdicts.find((x) => x.packageName === 'vite')!;
    expect(v).toMatchObject({ kind: 'FIXED_UPSTREAM_UPGRADE', match: { number: 10358 }, fix: { number: 10360, baseRef: 'v3.1' }, fixedIn: '3.1.6' });
  });

  it('prisma: error-plumbing frames add no evidence, so the match stays weak', async () => {
    const m = (await go('prisma-p2002')).verdicts[0]!.match!;
    expect(m.number).toBe(25081);
    expect(m.similarity.score).toBeLessThan(STRONG_MATCH);
    expect(m.similarity.frames).toBeUndefined();
  });

  it('--limit only changes what is shown, never the verdict', async () => {
    const [one, five] = await Promise.all([go('vite-esm', 1), go('vite-esm', 5)]);
    const pick = (r: Awaited<ReturnType<typeof go>>) => r.verdicts.map((v) => [v.kind, v.match?.number, v.fixedIn]);
    expect(pick(one)).toEqual(pick(five));
    expect(one.searches.find((s) => s.repo.repo === 'vite')!.matches).toHaveLength(1);
  });
});
