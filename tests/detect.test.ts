import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detect } from '../src/detect.js';
import { createClient, replayFetch } from '../src/net/client.js';

const fixtures = join(import.meta.dirname, 'fixtures');
const client = createClient(replayFetch(join(fixtures, 'http')));
const cwd = join(fixtures, 'projects/axios-app');

describe('detect (parse → lockfile → resolve)', () => {
  it('finds axios, its installed version and repo from a stack trace', async () => {
    const r = await detect(readFileSync(join(fixtures, 'stacks/axios-econnrefused.txt'), 'utf8'), { cwd, client });
    expect(r.lockfile?.kind).toBe('package-lock');
    expect(r.packages.map((p) => [p.candidate.name, p.installed?.version, `${p.repo?.owner}/${p.repo?.repo}`])).toEqual([
      ['axios', '1.5.0', 'axios/axios'],
      ['follow-redirects', '1.16.0', 'follow-redirects/follow-redirects'],
    ]);
    expect(r.diagnostics.items.filter((d) => d.level !== 'info')).toEqual([]);
  });

  it('warns (with what it tried) for packages that are not installed', async () => {
    const r = await detect(readFileSync(join(fixtures, 'stacks/jest-suite.txt'), 'utf8'), { cwd, client });
    const nanoid = r.diagnostics.items.find((d) => d.message.startsWith('nanoid'));
    expect(nanoid).toMatchObject({ level: 'warn', stage: 'lockfile' });
    expect(nanoid?.tried?.[0]).toMatch(/package-lock\.json \(no entry\)$/);
  });

  it('--repo skips registry lookups and validates its format', async () => {
    const r = await detect('TypeError: boom', { cwd, client, repo: 'axios/axios' });
    expect(r.explicitRepo).toEqual({ owner: 'axios', repo: 'axios' });
    await expect(detect('x', { cwd, client, repo: 'nope' })).rejects.toThrow(/owner\/name/);
  });
});
