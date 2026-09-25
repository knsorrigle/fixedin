/**
 * --markdown, for PR comments and job summaries. Issue titles and release notes
 * are written by strangers, so escaping is tested as carefully as the content.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuthResult } from '../src/github/auth.js';
import { main } from '../src/main.js';
import { createClient, replayFetch } from '../src/net/client.js';
import { codeBlock, COMMENT_MARKER, formatMarkdown, inline } from '../src/output/markdown.js';
import { run } from '../src/pipeline.js';

const fixtures = join(import.meta.dirname, 'fixtures');
const client = createClient(replayFetch(join(fixtures, 'http')));
const auth: AuthResult = { token: 't', source: 'GITHUB_TOKEN', tried: [] };
const stack = (n: string) => readFileSync(join(fixtures, 'stacks', `${n}.txt`), 'utf8');

describe('untrusted text', () => {
  it('cannot @-mention anyone', () => {
    expect(inline('ping @octocat and @org/team')).not.toMatch(/@[\w]/);
    expect(inline('user@example.com')).toBe('user@‍example.com');
  });

  it('cannot link to issues in the reader\'s repo', () => {
    expect(inline('see #5162 and owner/repo#12')).not.toMatch(/#\d/);
  });

  it('cannot inject HTML, links, images or break out of its line', () => {
    const out = inline('<img src=x onerror=alert(1)> [click](https://evil.example) ![i](x) `code` **bold**\n\n## heading');
    // Every character that could start HTML, a link or an image is backslash-escaped.
    expect(out).not.toMatch(/(?<!\\)[<>[\]()!`*]/);
    expect(out).not.toContain('\n');
    expect(out).not.toMatch(/https:\/\//);
  });

  it('truncates long text', () => {
    expect(inline('x'.repeat(500), 50)).toHaveLength(50);
  });

  it('code blocks use a fence longer than any backtick run inside', () => {
    expect(codeBlock('a ``` b')).toBe('````\na ``` b\n````');
    expect(codeBlock('plain', 'sh')).toBe('```sh\nplain\n```');
  });
});

describe('formatMarkdown (recorded real cases)', () => {
  const go = async (trace: string, project: string, repo?: string) =>
    formatMarkdown(await run(stack(trace), { cwd: join(fixtures, 'projects', project), client, limit: 5, auth, ...(repo ? { repo } : {}) }), '0.0.0-test');

  it('a fix you do not have: headline, links, release note, advice', async () => {
    const md = await go('axios-default-create', 'axios-1.1.3', 'axios/axios');
    expect(md.startsWith(COMMENT_MARKER)).toBe(true);
    expect(md).toContain('### 🔍 fixedin: this failure was already fixed upstream');
    expect(md).toContain('[axios/axios#5011](https://github.com/axios/axios/issues/5011)');
    expect(md).toContain('[PR #5162](https://github.com/axios/axios/pull/5162) → shipped in **v1.2.0**');
    expect(md).toContain('**→ Upgrade to \\>=1.2.0**');
  });

  it('a transitive dependency: where it comes from, and a package.json override block', async () => {
    const md = await go('axios-default-create', 'nest-npm', 'axios/axios');
    expect(md).toContain('**Comes from:** `@nestjs/axios@1.0.0` (requires `axios 1.1.3`)');
    expect(md).toMatch(/```json\n\{\n {2}"overrides": \{\n {4}"@nestjs\/axios": \{\n {6}"axios": "\^1\.2\.0"/);
  });

  it('nothing to upgrade to', async () => {
    const md = await go('axios-headers', 'axios-app');
    expect(md).toContain('### 🔍 fixedin: no released fix you are missing');
    expect(md).toContain('? Closed, no fix traced');
  });

  it('only links to github.com / npmjs.com', async () => {
    const md = await go('axios-default-create', 'nest-npm', 'axios/axios');
    for (const [, url] of md.matchAll(/\]\((\S+?)\)/g)) expect(url).toMatch(/^https:\/\/(github\.com|www\.npmjs\.com)\//);
  });
});

describe('--markdown on the command line', () => {
  const cli = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await main(['node', 'fixedin', ...args], {
      stdout: (s) => (stdout += s),
      stderr: (s) => (stderr += s),
      readStdin: async () => stack('axios-default-create'),
      env: { GITHUB_TOKEN: 'test-token' },
      cwd: join(fixtures, 'projects/axios-1.1.3'),
      client,
    });
    return { code, stdout, stderr };
  };

  it('prints markdown and still honours --exit-code', async () => {
    const r = await cli(['--markdown', '--exit-code', '--repo', 'axios/axios']);
    expect(r.code).toBe(1);
    expect(r.stdout.startsWith(COMMENT_MARKER)).toBe(true);
  });

  it('refuses --json together with --markdown', async () => {
    const r = await cli(['--markdown', '--json', '--exit-code', '--repo', 'axios/axios']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/mutually exclusive/);
  });
});
