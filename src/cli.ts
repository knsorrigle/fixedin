#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import { resolve } from 'node:path';
import pc from 'picocolors';
import pkg from '../package.json' with { type: 'json' };
import { defaultClient } from './net/client.js';
import { toReport } from './output/json.js';
import { run } from './pipeline.js';
import { formatDetect, formatDiagnostics, formatNetStats, formatSearches, formatVerdicts } from './output/terminal.js';

interface CliOptions {
  cwd: string;
  json: boolean;
  limit: number;
  repo?: string;
  verbose: boolean;
  cache: boolean;
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
  .option('--no-cache', `don't read or write the disk cache (~/.cache/fixedin)`)
  .version(pkg.version, '-V, --version')
  .action(async (words: string[], opts: CliOptions) => {
    let input = words.join(' ');
    if (!input && !process.stdin.isTTY) input = await readStdin();
    if (!input.trim()) {
      program.error('No error text given. Pass it as an argument or pipe a stack trace:\n  pbpaste | fixedin');
    }

    const cwd = resolve(opts.cwd);
    const client = defaultClient(process.env, {
      noCache: !opts.cache,
      // Always explain waits (on stderr, so --json stays clean).
      onWait: (ms, reason) => console.error(pc.dim(`… ${reason}; waiting ${Math.ceil(ms / 1000)}s`)),
    });
    const result = await run(input, {
      cwd,
      client,
      limit: opts.limit,
      ...(opts.repo ? { repo: opts.repo } : {}),
    });
    const diagnostics = result.detect.diagnostics.items;
    const stats = client.stats;
    for (const e of stats?.cache?.errors ?? []) result.detect.diagnostics.warn('net', `Cache: ${e}`);

    if (opts.json) {
      process.stdout.write(JSON.stringify(toReport(result, pkg.version), null, 2) + '\n');
      if (opts.verbose) console.error(formatNetStats(stats));
      return;
    }
    if (opts.verbose) {
      console.log(formatDetect(result.detect, cwd));
      console.log(formatSearches(result));
    }
    console.log(formatVerdicts(result, cwd, opts.limit));
    const diag = formatDiagnostics(diagnostics, opts.verbose);
    if (diag) console.error('\n' + diag);
    if (opts.verbose) console.error(formatNetStats(stats));
  });

program.parseAsync().catch((err: unknown) => {
  console.error(pc.red('fixedin failed:'), err instanceof Error ? err.message : err);
  if (process.env.DEBUG && err instanceof Error) console.error(err.stack);
  process.exit(1);
});
