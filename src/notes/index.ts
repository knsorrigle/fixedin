/**
 * notes/: the release-note line for a fix, so the user can see what shipped
 * ("changed: refactored module exports (#5162)") before upgrading.
 *
 * Sources, first hit wins:
 *   1. the GitHub release for the fixed version (tag found the same way release/ does)
 *   2. the repo's changelog file — in the package's own directory for
 *      monorepos (packages/vite/CHANGELOG.md), then the repo root
 * Only the section for that version is searched, for lines that mention the fix's
 * PR, the issue, or the commit.
 */
import type { GitHub } from '../github/client.js';
import { describeGitHubError } from '../github/client.js';
import { TAG_PATTERNS } from '../release/index.js';
import type { RepoRef } from '../resolve/index.js';
import type { FixRef } from '../trace/index.js';

export interface ReleaseNote {
  source: 'github-release' | 'changelog';
  /** Release page, or the changelog file. */
  url: string;
  /** Matching lines, markdown links flattened ("changed: refactored module exports (#5162)"). */
  lines: string[];
  matchedBy: 'pull-request' | 'issue' | 'commit';
}

export interface NoteLookup {
  version: string;
  packageName: string;
  /** The version's tag, when the release search found one (saves guessing tag spellings). */
  ref?: string;
  refIsTag?: boolean;
  fix: FixRef;
  issueNumber: number;
}

const CHANGELOG_NAME = /^(changelog|changes|history|releases?)(\.(md|markdown|txt))?$/i;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Heading line for `version`: "## 1.2.0", "## [1.2.0](…) (2022-11-22)", "# v1.2.0" — but not 11.2.0 or 1.2.0-beta. */
export function versionHeading(version: string): RegExp {
  return new RegExp(`^#{1,4}\\s.*(?<![\\d.])v?\\[?${escape(version)}\\]?(?![\\d.-])`);
}

/** The lines of `text` under `version`'s heading, up to the next heading at the same or a higher level. */
export function versionSection(text: string, version: string): string[] | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => versionHeading(version).test(l));
  if (start === -1) return undefined;
  const level = lines[start]!.match(/^#+/)![0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = l.match(/^(#+)\s/);
    return m && m[1]!.length <= level;
  });
  return end === -1 ? rest : rest.slice(0, end);
}

/** "- changed: [#5162](https://…/pull/5162) **x**" → "changed: #5162 x" */
export function flattenMarkdown(line: string): string {
  return line
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lines mentioning the PR, else the issue, else the commit. */
export function findMentions(lines: string[], l: Pick<NoteLookup, 'fix' | 'issueNumber'>): Pick<ReleaseNote, 'lines' | 'matchedBy'> | undefined {
  const tests: Array<[ReleaseNote['matchedBy'], RegExp | undefined]> = [
    ['pull-request', l.fix.number ? new RegExp(`(#|/pull/)${l.fix.number}(?!\\d)`) : undefined],
    ['issue', new RegExp(`(#|/issues/)${l.issueNumber}(?!\\d)`)],
    ['commit', new RegExp(`(?<![0-9a-f])${l.fix.sha.slice(0, 7)}`, 'i')],
  ];
  for (const [matchedBy, re] of tests) {
    if (!re) continue;
    const hits = lines.filter((line) => re.test(line) && flattenMarkdown(line).length > 0);
    if (hits.length) return { lines: hits.slice(0, 2).map(flattenMarkdown), matchedBy };
  }
  return undefined;
}

export async function findReleaseNote(gh: GitHub, repo: RepoRef, l: NoteLookup): Promise<{ note?: ReleaseNote; tried: string[] }> {
  const tried: string[] = [];
  const { owner, repo: name } = repo;

  // 1. GitHub release for the version's tag.
  const tags = l.ref && l.refIsTag ? [l.ref] : TAG_PATTERNS.map((p) => p(l.packageName, l.version));
  for (const tag of [...new Set(tags)]) {
    try {
      const res = await gh.rest.request('GET /repos/{owner}/{repo}/releases/tags/{tag}', { owner, repo: name, tag });
      const body = res.data.body ?? '';
      const found = findMentions(versionSection(body, l.version) ?? body.split(/\r?\n/), l);
      tried.push(`GitHub release ${tag}: ${found ? 'found' : 'no line mentions the fix'}`);
      if (found) return { note: { source: 'github-release', url: res.data.html_url, ...found }, tried };
      break; // the release exists; another tag spelling won't be a different release
    } catch (err) {
      const { status, message } = describeGitHubError(err);
      if (status !== 404) {
        tried.push(`GitHub release ${tag}: ${message}`);
        break;
      }
      tried.push(`GitHub release ${tag}: none`);
    }
  }

  // 2. A changelog file on the default branch: changelogs accumulate, so the current
  //    one holds every past version's section (and some projects write the entry
  //    after tagging). The package's directory first (monorepos), then the root.
  for (const dir of [...new Set([repo.directory, ''].filter((d): d is string => d !== undefined))]) {
    let listing: Array<{ name: string; path: string; type: string }>;
    try {
      const res = await gh.rest.request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo: name, path: dir });
      listing = Array.isArray(res.data) ? (res.data as typeof listing) : [];
    } catch (err) {
      tried.push(`changelog in /${dir}: ${describeGitHubError(err).message}`);
      continue;
    }
    const file = listing.find((f) => f.type === 'file' && CHANGELOG_NAME.test(f.name));
    if (!file) {
      tried.push(`changelog in /${dir}: no changelog file`);
      continue;
    }
    try {
      const res = await gh.rest.request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo: name, path: file.path });
      const data = res.data as { content?: string; encoding?: string; html_url?: string };
      const text = data.content && data.encoding === 'base64' ? Buffer.from(data.content, 'base64').toString('utf8') : '';
      const section = versionSection(text, l.version);
      const found = section ? findMentions(section, l) : undefined;
      tried.push(`${file.path}: ${!section ? `no section for ${l.version}` : found ? 'found' : 'no line mentions the fix'}`);
      if (found) return { note: { source: 'changelog', url: data.html_url ?? `https://github.com/${owner}/${name}/blob/HEAD/${file.path}`, ...found }, tried };
    } catch (err) {
      tried.push(`${file.path}: ${describeGitHubError(err).message}`);
    }
  }
  return { tried };
}
