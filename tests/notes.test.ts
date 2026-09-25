/**
 * The release-note line for a fix: GitHub release first, then the changelog
 * (package directory for monorepos, then root), within that version's section.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuthResult } from '../src/github/auth.js';
import { createGitHub } from '../src/github/client.js';
import { createClient, replayFetch, type FetchLike } from '../src/net/client.js';
import { findMentions, findReleaseNote, flattenMarkdown, versionHeading, versionSection } from '../src/notes/index.js';
import { toReport } from '../src/output/json.js';
import { formatVerdicts } from '../src/output/terminal.js';
import { run } from '../src/pipeline.js';
import type { FixRef } from '../src/trace/index.js';
import { crossesMajor } from '../src/verdict/index.js';

const fixtures = join(import.meta.dirname, 'fixtures');
const viteChangelog = readFileSync(join(fixtures, 'notes/vite-CHANGELOG-excerpt.md'), 'utf8'); // real, first 142 lines
const viteRelease = JSON.parse(readFileSync(join(fixtures, 'notes/vite-release-v8.2.2.json'), 'utf8')) as { html_url: string; body: string };
const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');
const fix = (number: number, sha: string): FixRef => ({ kind: 'pull_request', number, url: `https://x/pull/${number}`, sha, evidence: 'closed-by-pr' });

describe('version sections', () => {
  it.each([
    ['## [1.2.0] - 2022-11-10', '1.2.0', true], // axios
    ['## <small>[8.2.2](https://github.com/vitejs/vite/compare/v8.2.1...v8.2.2) (2026-08-20)</small>', '8.2.2', true], // vite
    ['# v1.2.0', '1.2.0', true],
    ['## 1.2.0 (2022-11-22)', '1.2.0', true],
    ['## [11.2.0] - 2023-01-01', '1.2.0', false],
    ['## [1.2.0-beta.1]', '1.2.0', false],
    ['- fixed in 1.2.0', '1.2.0', false], // not a heading
  ])('%s  (%s → %s)', (line, version, matches) => {
    expect(versionHeading(version).test(line)).toBe(matches);
  });

  it("doesn't mistake a compare link in the next version's heading for the section (real vite changelog)", () => {
    // "## [8.3.0](…/compare/v8.2.2...v8.3.0)" mentions v8.2.2 but is not its section.
    const section = versionSection(viteChangelog, '8.2.2')!;
    expect(section.find((l) => l.trim())).toBe('### Features');
    expect(section.some((l) => l.includes('8.3.0'))).toBe(false);
    expect(section.some((l) => l.includes('#23295'))).toBe(true);
    expect(versionSection(viteChangelog, '1.0.0')).toBeUndefined();
  });
});

describe('finding the line', () => {
  const lines = [
    '- changed: refactored module exports [#5162](https://github.com/axios/axios/pull/5162)',
    '- fix: something else [#51620](https://github.com/axios/axios/pull/51620)',
    '* **css:** fixed a thing, closes [#5011](https://github.com/axios/axios/issues/5011)',
    '* chore: bump ([0c3a1e9](https://github.com/axios/axios/commit/0c3a1e9fde4dd309e82d719b256907eb5cba591b))',
  ];

  it('prefers the PR, then the issue, then the commit — and never a longer number', () => {
    expect(findMentions(lines, { fix: fix(5162, 'aaaaaaa'), issueNumber: 1 })).toEqual({
      matchedBy: 'pull-request',
      lines: ['changed: refactored module exports #5162'],
    });
    expect(findMentions(lines, { fix: fix(9999, 'aaaaaaa'), issueNumber: 5011 })).toEqual({ matchedBy: 'issue', lines: ['css: fixed a thing, closes #5011'] });
    expect(findMentions(lines, { fix: fix(9999, '0c3a1e9fde4dd309e82d719b256907eb5cba591b'), issueNumber: 1 })).toMatchObject({ matchedBy: 'commit' });
    expect(findMentions(lines, { fix: fix(516, 'bbbbbbb'), issueNumber: 50 })).toBeUndefined();
  });

  it('flattens markdown', () => {
    expect(flattenMarkdown('* **deps:** update ([#23217](https://x/issues/23217)) ([ba958bd](https://x/commit/ba958bd))')).toBe('deps: update (#23217) (ba958bd)');
  });
});

describe('findReleaseNote', () => {
  /** Serves GitHub API paths from a map; anything else is a 404. */
  const stub = (routes: Record<string, unknown>) => {
    const seen: string[] = [];
    const f: FetchLike = async (input) => {
      const path = decodeURIComponent(new URL(input instanceof Request ? input.url : input.toString()).pathname);
      seen.push(path);
      const body = routes[path];
      return body === undefined
        ? new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { gh: createGitHub(createClient(f), 't'), seen };
  };
  const b64 = (s: string) => Buffer.from(s).toString('base64');

  it("vite: the release just says 'see CHANGELOG', so it reads packages/vite/CHANGELOG.md (real content)", async () => {
    const { gh } = stub({
      '/repos/vitejs/vite/releases/tags/v8.2.2': viteRelease,
      '/repos/vitejs/vite/contents/packages/vite': [{ name: 'CHANGELOG.md', path: 'packages/vite/CHANGELOG.md', type: 'file' }, { name: 'src', path: 'packages/vite/src', type: 'dir' }],
      '/repos/vitejs/vite/contents/packages/vite/CHANGELOG.md': { content: b64(viteChangelog), encoding: 'base64', html_url: 'https://github.com/vitejs/vite/blob/main/packages/vite/CHANGELOG.md' },
    });
    const r = await findReleaseNote(gh, { owner: 'vitejs', repo: 'vite', directory: 'packages/vite' }, {
      version: '8.2.2',
      packageName: 'vite',
      fix: fix(23295, '2804636ff608d105928009d274ffba7cfbe55340'),
      issueNumber: 1,
    });
    expect(r.note).toEqual({
      source: 'changelog',
      url: 'https://github.com/vitejs/vite/blob/main/packages/vite/CHANGELOG.md',
      lines: ["css: don't pass empty targets to lightningcss (#23295) (2804636)"],
      matchedBy: 'pull-request',
    });
    expect(r.tried).toEqual(['GitHub release v8.2.2: no line mentions the fix', 'packages/vite/CHANGELOG.md: found']);
  });

  it('tries tag spellings, then the root changelog, and reports each step when nothing mentions the fix', async () => {
    const { gh, seen } = stub({
      '/repos/o/r/contents': [{ name: 'History.md', path: 'History.md', type: 'file' }],
      '/repos/o/r/contents/History.md': { content: b64('# 2.0.0\n- unrelated (#1)\n# 1.0.0\n- older'), encoding: 'base64' },
    });
    const r = await findReleaseNote(gh, { owner: 'o', repo: 'r' }, { version: '2.0.0', packageName: 'pkg', fix: fix(42, 'ccccccc'), issueNumber: 7 });
    expect(r.note).toBeUndefined();
    expect(seen.filter((p) => p.includes('/releases/tags/'))).toEqual([
      '/repos/o/r/releases/tags/v2.0.0',
      '/repos/o/r/releases/tags/2.0.0',
      '/repos/o/r/releases/tags/pkg@2.0.0',
      '/repos/o/r/releases/tags/pkg@v2.0.0',
    ]);
    expect(r.tried.at(-1)).toBe('History.md: no line mentions the fix');
  });

  it('uses the tag the release search already found', async () => {
    const { gh, seen } = stub({ '/repos/o/r/releases/tags/pkg-v3.0.0': { html_url: 'https://github.com/o/r/releases/tag/pkg-v3.0.0', body: '- fix: the bug (#42)' } });
    const r = await findReleaseNote(gh, { owner: 'o', repo: 'r' }, { version: '3.0.0', packageName: 'pkg', ref: 'pkg-v3.0.0', refIsTag: true, fix: fix(42, 'c'), issueNumber: 7 });
    expect(r.note).toMatchObject({ source: 'github-release', lines: ['fix: the bug (#42)'] });
    expect(seen).toEqual(['/repos/o/r/releases/tags/pkg-v3.0.0']);
  });
});

describe('crossesMajor', () => {
  it.each([
    ['1.1.3', '1.2.0', false],
    ['1.9.0', '2.0.0', true],
    ['0.25.0', '0.27.0', true], // 0.x: a minor bump is breaking
    ['0.25.0', '0.25.3', false],
    ['2.0.0', '1.2.0', false],
  ])('%s → %s: %s', (from, to, expected) => {
    expect(crossesMajor(from, to)).toBe(expected);
  });
});

describe('end to end: axios/axios#5011 (recorded)', () => {
  const client = createClient(replayFetch(join(fixtures, 'http')));
  const auth: AuthResult = { token: 't', source: 'GITHUB_TOKEN', tried: [] };
  const stack = readFileSync(join(fixtures, 'stacks/axios-default-create.txt'), 'utf8');

  it('quotes the v1.2.0 GitHub release note for PR #5162', async () => {
    const cwd = join(fixtures, 'projects/axios-1.1.3');
    const r = await run(stack, { cwd, client, limit: 1, auth, repo: 'axios/axios' });
    expect(r.verdicts[0]!.releaseNote).toEqual({
      source: 'github-release',
      url: 'https://github.com/axios/axios/releases/tag/v1.2.0',
      lines: ['changed: refactored module exports #5162'],
      matchedBy: 'pull-request',
    });
    expect(r.verdicts[0]!.majorUpgrade).toBeUndefined(); // 1.1.3 → 1.2.0
    const out = strip(formatVerdicts(r, cwd, 1));
    expect(out).toContain('Release note: "changed: refactored module exports #5162"');
    expect(toReport(r, 't').results[0]!.verdict).toMatchObject({ releaseNote: { matchedBy: 'pull-request' }, majorUpgrade: null });
  });
});
