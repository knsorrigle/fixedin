#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import { resolve } from 'node:path';
import pc from 'picocolors';
import { detect } from './detect.js';
import { defaultClient } from './net/client.js';
import { formatDetect, formatDiagnostics } from './output/terminal.js';

interface CliOptions {
  cwd: string;
  json: boolean;
  limit: number;
  repo?: string;
  verbose: boolean;
}

function parsePositiveInt(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('must be a positive integer');
  return n;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const program = new Command()
  .name('fixedin')
  .description('Paste an error; find out if it was fixed upstream and whether your installed version has the fix.')
  .argument('[error...]', 'error message (or pipe a stack trace on stdin)')
  .option('--cwd <dir>', 'project directory to read the lockfile from', process.cwd())
  .option('--json', 'machine-readable output', false)
  .option('--limit <n>', 'max issues to consider per repo', parsePositiveInt, 5)
  .option('--repo <owner/name>', 'search this GitHub repo instead of detecting packages')
  .option('-v, --verbose', 'show every attempt, cache hits and rate-limit quota', false)
  .action(async (words: string[], opts: CliOptions) => {
    let input = words.join(' ');
    if (!input && !process.stdin.isTTY) input = await readStdin();
    if (!input.trim()) {
      program.error('No error text given. Pass it as an argument or pipe a stack trace:\n  pbpaste | fixedin');
    }

    const cwd = resolve(opts.cwd);
    const result = await detect(input, { cwd, client: defaultClient(), repo: opts.repo });

    if (opts.json) {
      // Interim shape; the stable zod schema lands in M4.
      const { diagnostics, ...rest } = result;
      process.stdout.write(JSON.stringify({ ...rest, diagnostics: diagnostics.items }, null, 2) + '\n');
      return;
    }
    console.log(formatDetect(result, cwd));
    const diag = formatDiagnostics(result.diagnostics.items, opts.verbose);
    if (diag) console.error('\n' + diag);
  });

program.parseAsync().catch((err: unknown) => {
  console.error(pc.red('fixedin failed:'), err instanceof Error ? err.message : err);
  if (process.env.DEBUG && err instanceof Error) console.error(err.stack);
  process.exit(1);
});
