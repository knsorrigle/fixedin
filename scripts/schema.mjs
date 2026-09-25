// Regenerates docs/report.schema.json from the zod schema in src/output/json.ts.
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { ReportSchema } from '../dist/index.js';

const out = new URL('../docs/report.schema.json', import.meta.url);
writeFileSync(out, JSON.stringify(z.toJSONSchema(ReportSchema), null, 2) + '\n');
console.log(`wrote ${out.pathname}`);
