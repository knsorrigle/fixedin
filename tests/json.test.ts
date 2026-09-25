import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AuthResult } from '../src/github/auth.js';
import { createClient, replayFetch } from '../src/net/client.js';
import { ReportSchema, SCHEMA_VERSION, toReport } from '../src/output/json.js';
import { run } from '../src/pipeline.js';

const fixtures = join(import.meta.dirname, 'fixtures');
const client = createClient(replayFetch(join(fixtures, 'http')));
const auth: AuthResult = { token: 't', source: 'GITHUB_TOKEN', tried: [] };

describe('--json report', () => {
  it('is valid against the schema and carries the verdict', async () => {
    const r = await run(readFileSync(join(fixtures, 'stacks/axios-default-create.txt'), 'utf8'), {
      cwd: join(fixtures, 'projects/axios-1.1.3'),
      client,
      limit: 3,
      auth,
      repo: 'axios/axios',
    });
    const report = toReport(r, '0.0.0-test');
    expect(ReportSchema.safeParse(JSON.parse(JSON.stringify(report))).success).toBe(true);
    expect(report.schemaVersion).toBe(SCHEMA_VERSION);
    expect(report.results[0]!.verdict).toMatchObject({ kind: 'FIXED_UPSTREAM_UPGRADE', fixedIn: '1.2.0', installedHasFix: 'missing' });
    expect(report.results[0]!.verdict.fix).toMatchObject({ number: 5162, sha: '0c3a1e9fde4dd309e82d719b256907eb5cba591b' });
    expect(report.results[0]!.matches).toHaveLength(3);
    // No undefined holes: every optional field is an explicit null, so a
    // JSON round-trip loses nothing.
    expect(JSON.parse(JSON.stringify(report))).toStrictEqual(report);
  });

  it('matches the published JSON Schema in docs/ (run `npm run schema` after changing it)', () => {
    const published = JSON.parse(readFileSync(join(import.meta.dirname, '../docs/report.schema.json'), 'utf8'));
    expect(published).toEqual(JSON.parse(JSON.stringify(z.toJSONSchema(ReportSchema))));
  });
});
