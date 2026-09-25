/**
 * The command line, as a function: parse argv, run, print, and return the exit
 * code instead of calling process.exit — so tests drive the real CLI in-process
 * and piped --json output is never cut off by an early exit.
 */
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { resolve } from 'node:path';
import pc from 'picocolors';
import pkg from '../package.json' with { type: 'json' };
import { resolveToken } from './github/auth.js';
import { defaultClient, type NetClient } from './net/client.js';
import { toReport } from './output/json.js';
import { formatMarkdown } from './output/markdown.js';
import { formatDetect, formatDiagnostics, formatNetStats, formatSearches, formatVerdicts } from './output/terminal.js';
import { run, type RunResult } from './pipeline.js';

export interface IO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** Piped input, or undefined when stdin is a terminal. */
  readStdin: () => Promise<string | undefined>;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Tests inject a replaying client; the CLI builds the default one. */
  client?: NetClient;
}

interface CliOptions {
  cwd: string;
  json: boolean;
  markdown: boolean;
  limit: number;
  repo?: string;
  verbose: boolean;
  cache: boolean;
  exitCode: boolean;
}

/**
 * With --exit-code (like `git diff --exit-code`):
 *   0  no released fix you're missing — no match, you already have it, still open, or unreleased
 *   1  a released fix exists that you don't have (any FIXED_UPSTREAM_UPGRADE verdict)
 *   2  fixedin couldn't tell: it failed, got bad arguments, or a search failed outright
 * A found fix wins over a partial failure: 1 means "act on this" even if another repo errored.
 */
export const EXIT = { NOTHING_TO_DO: 0, FIX_AVAILABLE: 1, ERROR: 2 } as const;

export function exitCodeFor(result: RunResult): 0 | 1 | 2 {
  if (result.verdicts.some((v) => v.kind === 'FIXED_UPSTREAM_UPGRADE')) return EXIT.FIX_AVAILABLE;
  if (result.detect.diagnostics.items.some((d) => d.level === 'error')) return EXIT.ERROR;
  return EXIT.NOTHING_TO_DO;
}

function parsePositiveInt(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('must be a positive integer');
  return n;
}

export async function main(argv: string[], io: IO): Promise<number> {
  // Known before parsing, so even a usage error can honour --exit-code's "2 = couldn't tell".
  const wantsExitCode = argv.includes('--exit-code');
  const failure = wantsExitCode ? EXIT.ERROR : 1;
  let code = 0;

  const program = new Command()
    .name('fixedin')
    .description('Paste an error; find out if it was fixed upstream and whether your installed version has the fix.')
    .argument('[error...]', 'error message (or pipe a stack trace on stdin)')
    .option('--cwd <dir>', 'project directory to read the lockfile from', io.cwd)
    .option('--json', 'machine-readable output', false)
    .option('--markdown', 'GitHub-flavored markdown, for PR comments and job summaries', false)
    .option('--limit <n>', 'max issues to show per repo', parsePositiveInt, 5)
    .option('--repo <owner/name>', 'search this GitHub repo instead of detecting packages')
    .option('-v, --verbose', 'show every attempt, cache hits and rate-limit quota', false)
    .option('--no-cache', `don't read or write the disk cache (~/.cache/fixedin)`)
    .option('--exit-code', 'exit 1 if a released fix exists that you don\'t have, 2 if fixedin couldn\'t tell, else 0', false)
    .version(pkg.version, '-V, --version')
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .action(async (words: string[], opts: CliOptions) => {
      let input = words.join(' ');
      if (!input) input = (await io.readStdin()) ?? '';
      if (!input.trim()) {
        io.stderr('No error text given. Pass it as an argument or pipe a stack trace:\n  pbpaste | fixedin\n');
        code = failure;
        return;
      }

      const cwd = resolve(io.cwd, opts.cwd);
      const client =
        io.client ??
        defaultClient(io.env, {
          noCache: !opts.cache,
          // Always explain waits (on stderr, so --json stays clean).
          onWait: (ms, reason) => io.stderr(pc.dim(`… ${reason}; waiting ${Math.ceil(ms / 1000)}s\n`)),
        });
      // Token from io.env (not process.env), so main() is self-contained and tests
      // never depend on whoever is logged into `gh` on the machine running them.
      const auth = await resolveToken(io.env);
      const result = await run(input, { cwd, client, limit: opts.limit, auth, ...(opts.repo ? { repo: opts.repo } : {}) });
      const stats = client.stats;
      for (const e of stats?.cache?.errors ?? []) result.detect.diagnostics.warn('net', `Cache: ${e}`);

      if (opts.json && opts.markdown) {
        io.stderr('--json and --markdown are mutually exclusive.\n');
        code = failure;
        return;
      }
      if (opts.markdown) {
        io.stdout(formatMarkdown(result, pkg.version) + '\n');
        const diag = formatDiagnostics(result.detect.diagnostics.items, opts.verbose);
        if (diag) io.stderr('\n' + diag + '\n');
      } else if (opts.json) {
        io.stdout(JSON.stringify(toReport(result, pkg.version), null, 2) + '\n');
        if (opts.verbose) io.stderr(formatNetStats(stats) + '\n');
      } else {
        if (opts.verbose) {
          io.stdout(formatDetect(result.detect, cwd) + '\n');
          io.stdout(formatSearches(result) + '\n');
        }
        io.stdout(formatVerdicts(result, cwd, opts.limit) + '\n');
        const diag = formatDiagnostics(result.detect.diagnostics.items, opts.verbose);
        if (diag) io.stderr('\n' + diag + '\n');
        if (opts.verbose) io.stderr(formatNetStats(stats) + '\n');
      }
      if (opts.exitCode) code = exitCodeFor(result);
    });

  try {
    await program.parseAsync(argv, { from: 'node' });
    return code;
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help / --version exit 0; usage errors were already printed by commander.
      return err.exitCode === 0 ? 0 : failure;
    }
    io.stderr(`${pc.red('fixedin failed:')} ${err instanceof Error ? err.message : String(err)}\n`);
    if (io.env.DEBUG && err instanceof Error) io.stderr(`${err.stack}\n`);
    return failure;
  }
}
