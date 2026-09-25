/**
 * Local similarity between the error query and an issue. GitHub returns
 * score=1 for every search hit (hybrid and lexical alike), so ranking needs
 * our own number. Deliberately simple and explainable: weighted token
 * coverage of the query by the issue title and body, plus a bonus when the
 * error message appears verbatim.
 */

// Words that appear in most JS errors — they matter, but a hit on them
// says much less than a hit on "headers" or "useState".
const GENERIC = new Set([
  'error', 'typeerror', 'referenceerror', 'syntaxerror', 'rangeerror', 'cannot', 'read', 'properties',
  'property', 'undefined', 'null', 'reading', 'not', 'is', 'a', 'function', 'failed', 'module', 'find',
  'unexpected', 'token', 'object', 'type', 'value', 'invalid',
]);
const STOPWORDS = new Set(['the', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'an', 'be', 'with', 'from', 'by', 'it', 'this', 'that', 'as', 'are', 'was', 'if', 'you', 'use']);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_$@./-]+/g) ?? [])
    .flatMap((t) => t.split(/[./]/)) // "axios.get" → axios, get
    .map((t) => t.replace(/^[-_]+|[-_]+$/g, ''))
    .filter((t) => t.length > 1 || /\d/.test(t))
    .filter((t) => !STOPWORDS.has(t));
}

function weight(token: string): number {
  return GENERIC.has(token) ? 0.35 : 1;
}

/** Weighted fraction of query tokens present in `text`. */
export function coverage(queryTokens: string[], text: string): number {
  if (!queryTokens.length) return 0;
  const have = new Set(tokenize(text));
  let total = 0;
  let hit = 0;
  for (const t of queryTokens) {
    const w = weight(t);
    total += w;
    if (have.has(t)) hit += w;
  }
  return total ? hit / total : 0;
}

/** Strip the "TypeError: " style prefix, lowercase, collapse whitespace and quotes. */
export function normalizeMessage(s: string): string {
  return s
    .replace(/^\s*[\w$]*(Error|Exception)(\s*\[[\w-]+\])?:\s*/, '')
    .toLowerCase()
    .replace(/[`'"‘’“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SimilarityBreakdown {
  score: number;
  title: number;
  body: number;
  verbatim: boolean;
}

export function similarity(query: string, title: string, body: string | null | undefined): SimilarityBreakdown {
  const q = [...new Set(tokenize(query))];
  const b = (body ?? '').slice(0, 20_000);
  const titleCov = coverage(q, title);
  const bodyCov = coverage(q, b);
  const msg = normalizeMessage(query);
  // Require a reasonably specific message before trusting a substring match.
  const verbatim = msg.length >= 15 && normalizeMessage(`${title}\n${b}`).includes(msg);
  const blended = 0.6 * titleCov + 0.4 * Math.max(bodyCov, titleCov);
  const score = verbatim ? Math.max(blended, 0.8 + 0.2 * titleCov) : blended;
  return { score: round(score), title: round(titleCov), body: round(bodyCov), verbatim };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
