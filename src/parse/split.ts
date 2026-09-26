/**
 * A test or CI log usually holds more than one failure. Split it into one
 * block per error, so each is matched on its own instead of the first error's
 * message being searched with every package from the whole log.
 *
 * A block starts at an error line ("TypeError: …", "Error [ERR_X]: …",
 * "Cannot find module …") or at a test runner's per-failure header (jest's
 * "● suite › test", "FAIL file", vitest's "⎯⎯⎯" rules, webpack's "ERROR in").
 * What stays in the block it belongs to:
 *   - cause chains: "Caused by: Error: …", "[cause]: Error: …" (they don't start
 *     the line with the error name)
 *   - anything before the first error: runner headers, the source excerpt Node
 *     prints above an uncaught error
 */
import { ANSI, FRAME, KNOWN_MESSAGE } from './index.js';

export interface ErrorBlock {
  text: string;
  /** 1-based input line of the block's error (or of its start, when it has no error line). */
  line: number;
}

/** jest "● suite › test" / "FAIL file", vitest "⎯⎯⎯ Failed Tests ⎯⎯⎯" / "⎯⎯⎯[1/3]⎯", webpack "ERROR in ./src/x.js". */
const RUNNER_HEADER = /^\s*(?:●\s|FAIL\s|⎯{3,}|ERROR in\s)/;

/**
 * Decoration allowed before the error name on a starting line: next's "⨯ ",
 * "[vite] ", Deno's lowercase "error: ", browsers' "Uncaught (in promise) ".
 */
const START_PREFIX = /^(?:[^\w\s[]{1,3}\s+|\[[\w-]+\]\s+|error:\s+)?(?:Uncaught\s+(?:\(in promise\)\s+)?)?/;
const ERROR_START = /^\w*(?:Error|Exception)(?:\s*\[[\w-]+\])?:/;

export function isErrorStart(line: string): boolean {
  const t = line.trim().replace(START_PREFIX, '');
  return ERROR_START.test(t) || KNOWN_MESSAGE.test(t);
}

export function splitErrors(input: string): ErrorBlock[] {
  const lines = input.replace(ANSI, '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: Array<{ start: number; end: number; errorAt: number | undefined }> = [];
  let start = 0;
  // What the current block holds so far: a header or prelude alone doesn't end it.
  let errorAt: number | undefined;
  let hasFrame = false;

  lines.forEach((line, i) => {
    const header = RUNNER_HEADER.test(line);
    const error = !header && isErrorStart(line);
    if ((header || error) && (errorAt !== undefined || hasFrame)) {
      blocks.push({ start, end: i, errorAt });
      start = i;
      errorAt = undefined;
      hasFrame = false;
    }
    if (error) errorAt ??= i;
    else if (FRAME.test(line)) hasFrame = true;
  });
  blocks.push({ start, end: lines.length, errorAt });

  return blocks
    .map(({ start: s, end, errorAt: e }) => ({ text: lines.slice(s, end).join('\n').trim(), line: (e ?? s) + 1 }))
    .filter((b) => b.text);
}
