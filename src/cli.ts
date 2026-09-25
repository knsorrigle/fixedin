#!/usr/bin/env node
import { main } from './main.js';

async function readStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// process.exitCode (not process.exit) so piped output is fully flushed first.
process.exitCode = await main(process.argv, {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  readStdin,
  env: process.env,
  cwd: process.cwd(),
});
