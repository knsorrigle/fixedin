/**
 * JSR packages (Deno's registry): a real hono bug reproduced in Deno 2.9 —
 * hono 4.5.1 throws "reading 'isEscaped'" for a component returning <></>
 * (honojs/hono#3235), fixed by PR #3241 in 4.5.5 (4.5.4 still throws, 4.5.5
 * doesn't). Recorded; tests never hit the network.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuthResult } from '../src/github/auth.js';
import { jsrPackage, provenanceCommit } from '../src/jsr.js';
import { readDenoLock } from '../src/lockfile/deno.js';
import { createClient, replayFetch, type FetchLike } from '../src/net/client.js';
import { parseError } from '../src/parse/index.js';
import { run } from '../src/pipeline.js';
import { declaredDependencies } from '../src/relation.js';
import { similarity } from '../src/search/similarity.js';

const fixtures = join(import.meta.dirname, 'fixtures');
const project = join(fixtures, 'projects/deno-jsr');
const trace = readFileSync(join(fixtures, 'stacks/deno-jsr-hono.txt'), 'utf8');
const client = createClient(replayFetch(join(fixtures, 'http')));
const auth: AuthResult = { token: 't', source: 'GITHUB_TOKEN', tried: [] };

describe('names', () => {
  it.each([
    ['jsr:@hono/hono', '@hono/hono'],
    ['@jsr/std__path', '@std/path'], // installed through npm's JSR compatibility layer
    ['@hono/hono', undefined],
    ['hono', undefined],
  ])('%s → %s', (name, full) => {
    expect(jsrPackage(name)?.full).toBe(full);
  });
});

describe('reading a Deno project that uses JSR', () => {
  it('stack frames on https://jsr.io/… name the package, its version and where it threw', () => {
    const [pkg] = parseError(trace).packages;
    expect(pkg).toMatchObject({
      name: 'jsr:@hono/hono',
      source: 'jsr-url',
      copy: { version: '4.5.1', versionFrom: 'jsr-url' },
      frames: [{ fn: 'JSXFunctionNode.toStringToBuffer', file: 'src/jsx/base.ts' }, expect.anything(), expect.anything()],
    });
  });

  it('deno.lock (v5, written by Deno 2.9) records the JSR version; deno.json declares it', () => {
    expect(readDenoLock(join(project, 'deno.lock'), project).find('jsr:@hono/hono')).toEqual([
      { name: 'jsr:@hono/hono', version: '4.5.1', location: 'jsr:@hono/hono@4.5.1', topLevel: true, source: join(project, 'deno.lock') },
    ]);
    // Both the exact import and the "hono/" prefix mapping name the JSR package.
    expect(declaredDependencies(project).names).toContain('jsr:@hono/hono');
  });
});

describe('end to end (recorded)', () => {
  it('matches #3235, traces PR #3241, and finds 4.5.5 from the versions\' provenance commits', async () => {
    const r = await run(trace, { cwd: project, client, limit: 5, auth });
    const v = r.verdicts[0]!;
    expect(v).toMatchObject({
      kind: 'FIXED_UPSTREAM_UPGRADE',
      packageName: 'jsr:@hono/hono',
      repo: { owner: 'honojs', repo: 'hono' },
      match: { number: 3235, similarity: { frames: { top: true } } },
      fix: { number: 3241 },
      fixedIn: '4.5.5',
      installed: { version: '4.5.1' },
      relation: { kind: 'direct' },
      releaseNote: { source: 'github-release' },
    });
    // No tags were needed: each probed version's commit came from its Sigstore statement.
    expect(r.detect.diagnostics.items.find((d) => d.stage === 'release' && d.message.includes('compare probe'))!.message).toMatch(/4\.5\.5=contains/);
  });
});

describe('provenance', () => {
  const stub = (subject: string): FetchLike => async (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    const statement = { subject: [{ name: subject }], predicate: { buildDefinition: { resolvedDependencies: [{ digest: { gitCommit: 'abc123' } }] } } };
    const body = url.includes('api.jsr.io') ? { rekorLogId: '1' } : { x: { attestation: { data: Buffer.from(JSON.stringify(statement)).toString('base64') } } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const p = jsrPackage('jsr:@acme/lib')!;

  it('the commit a version was built from', async () => {
    expect(await provenanceCommit(createClient(stub('pkg:jsr/@acme/lib@1.2.3')), p, '1.2.3')).toBe('abc123');
  });

  it('ignores a statement about a different package or version', async () => {
    expect(await provenanceCommit(createClient(stub('pkg:jsr/@acme/lib@1.2.4')), p, '1.2.3')).toBeUndefined();
    expect(await provenanceCommit(createClient(stub('pkg:jsr/@evil/lib@1.2.3')), p, '1.2.3')).toBeUndefined();
  });
});

describe('same message, same throw site, different title', () => {
  const query = "TypeError: Cannot read properties of null (reading 'isEscaped')";
  const frames = { pkg: 'jsr:@hono/hono', frames: [{ fn: 'JSXFunctionNode.toStringToBuffer', file: 'src/jsx/base.ts' }] };
  const pasted = (frame: string) => `Crashes.\n\n\`\`\`\n${query}\n    at ${frame}\n\`\`\``;

  it('is a match', () => {
    const s = similarity(query, 'Fragment does not work in custom JSX Component', pasted('JSXFunctionNode.toStringToBuffer (https://jsr.io/@hono/hono/4.5.1/src/jsx/base.ts:251:64)'), frames);
    expect(s.score).toBeGreaterThanOrEqual(0.75);
  });

  it('real case: zod#6070, where the throw site is in zod\'s own error helpers (treeifyError)', async () => {
    const zodTrace = readFileSync(join(fixtures, 'stacks/zod-treeify-error.txt'), 'utf8');
    const r = await run(zodTrace, { cwd: join(fixtures, 'projects/axios-app'), client, limit: 5, auth });
    expect(r.verdicts[0]).toMatchObject({ packageName: 'zod', kind: 'FIXED_UPSTREAM_UPGRADE', match: { number: 6070 }, fix: { number: 6213 }, fixedIn: '4.5.0' });
  });

  it('without the same throw site it stays below the threshold', () => {
    const s = similarity(query, 'Fragment does not work in custom JSX Component', pasted('render (https://jsr.io/@hono/hono/4.5.1/src/jsx/dom/render.ts:10:1)'), frames);
    expect(s.score).toBeLessThan(0.6);
  });
});
