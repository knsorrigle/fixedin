/**
 * Monorepo tools label every line of output with where it came from, and run
 * tasks in parallel so their lines interleave:
 *
 *   turbo            "@shop/web:test: TypeError: …"
 *   pnpm -r          "apps/web test: TypeError: …"
 *   docker compose   "api-1  | TypeError: …"
 *   concurrently     "[api] TypeError: …"
 *
 * The labels hide stack frames from the parser ("…:test:     at foo (…)" is not
 * a frame) and the interleaving mixes one error's frames into another's. So:
 * find the labelling scheme used on most lines, strip it, and untangle the
 * output back into one stream per label. GitHub Actions' raw-log timestamps
 * are removed first, the same way.
 */
import { ANSI } from './index.js';

export interface Stream {
  /** "@shop/web:test", "apps/web test", "api-1", "api"; null for unlabelled lines. */
  label: string | null;
  text: string;
  /** 1-based input line of each line of `text`. */
  lines: number[];
}

export type PrefixScheme = 'turbo' | 'pnpm' | 'compose' | 'concurrently';

interface Scheme {
  name: PrefixScheme;
  re: RegExp;
  /** turbo's "web:test" must contain a letter: "12:00:01 GET /" is a time. */
  needsLetter?: boolean;
}

// Group 1 is the label; the whole match is removed.
const SCHEMES: Scheme[] = [
  // "web:test: " / "@scope/web:build: " — package:task, no spaces.
  { name: 'turbo', re: /^((?:@[\w.-]+\/)?[\w.-]+:[\w.:-]+?): ?/, needsLetter: true },
  // "apps/web test: " / "packages/ui build: " — the package's directory, then the script.
  { name: 'pnpm', re: /^((?:@[\w.-]+\/)?[\w.-]+(?:\/[\w.-]+)+ [\w:.-]+): ?/ },
  // "api-1  | " (compose v2) / "api_1  | " (v1).
  { name: 'compose', re: /^([\w.-]+)\s+\| ?/ },
  // "[api] " / "[0] ".
  { name: 'concurrently', re: /^\[([^\]\s]+)\] ?/ },
];

/** GitHub Actions raw logs: "2024-05-01T12:00:00.1234567Z ". */
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;

/** A scheme counts when it labels at least this share of the non-empty lines. */
const MIN_SHARE = 0.6;
const MIN_LINES = 4;

/** Labels name a few packages or services, each covering many lines. */
function dominant(lines: string[], re: RegExp, labelled = true, needsLetter = false): boolean {
  const nonEmpty = lines.filter((l) => l.trim());
  if (nonEmpty.length < MIN_LINES) return false;
  const matches = nonEmpty.map((l) => l.match(re)).filter((m): m is RegExpMatchArray => m !== null);
  if (matches.length / nonEmpty.length < MIN_SHARE) return false;
  if (!labelled) return true;
  const labels = new Set(matches.map((m) => m[1]!));
  return (!needsLetter || [...labels].every((l) => /[A-Za-z]/.test(l))) && labels.size * 3 <= matches.length;
}

/** Split `input` into one stream per label. Unlabelled input is a single stream, unchanged. */
export function demux(input: string): { scheme: PrefixScheme | null; streams: Stream[] } {
  let lines = input.replace(ANSI, '').replace(/\r\n?/g, '\n').split('\n');
  if (dominant(lines, TIMESTAMP, false)) lines = lines.map((l) => l.replace(TIMESTAMP, ''));

  const scheme = SCHEMES.find((s) => dominant(lines, s.re, true, s.needsLetter));
  if (!scheme) return { scheme: null, streams: [{ label: null, text: lines.join('\n'), lines: lines.map((_, i) => i + 1) }] };

  // Streams in order of first appearance; unlabelled lines (the tool's own summary) get their own.
  const byLabel = new Map<string | null, { text: string[]; lines: number[] }>();
  lines.forEach((line, i) => {
    const m = line.match(scheme.re);
    const label = m ? m[1]! : null;
    const s = byLabel.get(label) ?? { text: [], lines: [] };
    s.text.push(m ? line.slice(m[0].length) : line);
    s.lines.push(i + 1);
    byLabel.set(label, s);
  });
  return {
    scheme: scheme.name,
    streams: [...byLabel].map(([label, s]) => ({ label, text: s.text.join('\n'), lines: s.lines })),
  };
}
