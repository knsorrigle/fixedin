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
  /**
   * The identifier the error is about ("adapter" in "adapter is not a function")
   * and where the issue mentions it in the same role; absent when the message
   * has no recognised shape.
   */
  anchor?: { term: string; found: 'title' | 'body' | 'none' };
}

/**
 * Score cap when the issue never mentions the error's anchor in the same role.
 * Deliberately below MATCH_THRESHOLD (0.6, src/verdict) so such an issue can
 * be listed as nearby but never decides a verdict.
 */
export const ANCHOR_MISS_CAP = 0.55;

export interface Anchor {
  /** The identifier, e.g. "adapter", "headers", "@vercel/analytics/react". */
  term: string;
  /** Normalized phrases (see normalizeMessage) any one of which counts as a mention. */
  phrases: string[];
}

const IDENT = String.raw`[\w$.#\[\]]+`;

/**
 * Most JS errors are a fixed template around one identifier. Two issues share
 * the template ("… is not a function") far more often than they share the bug,
 * so the identifier *in that role* is what has to match.
 */
export function extractAnchor(query: string): Anchor | undefined {
  const q = query.replace(/[‘’“”]/g, "'");
  const last = (x: string) => x.split('.').filter(Boolean).at(-1) ?? x;
  const make = (term: string, phrases: string[]): Anchor => ({ term, phrases: phrases.map((p) => normalizeMessage(p)) });

  // "X is not a function" / "…constructor" / "…defined" / "…iterable" / "…a valid …"
  // (V8 writes "foo(...) is not a function" when calling a call's result.)
  let m = q.match(new RegExp(`(${IDENT})(?:\\(\\.\\.\\.\\))?\\s+is not (a function|a constructor|defined|iterable|an object)`));
  if (m) {
    const term = last(m[1]!);
    return make(term, [`${term} is not ${m[2]}`, `${term}(...) is not ${m[2]}`]);
  }
  // "(reading 'X')" and the pre-V8-9.3 spelling "Cannot read property 'X' of undefined"
  m = q.match(/\((reading|setting) ['"]([^'"]+)['"]\)/) ?? q.match(/Cannot (read|set) propert(?:y|ies) ['"]([^'"]+)['"] of/);
  if (m) {
    const verb = m[1] === 'setting' || m[1] === 'set' ? 'set' : 'read';
    const term = m[2]!;
    return make(term, verb === 'read' ? [`reading '${term}'`, `property '${term}' of`] : [`setting '${term}'`, `property '${term}' of`]);
  }
  // Module resolution: the specifier itself is specific enough.
  m = q.match(/(?:Cannot find (?:module|package)|Can't resolve|Failed to resolve import) ['"]([^'"]+)['"]/);
  if (m) return make(m[1]!, [m[1]!]);
  return undefined;
}

/** `phrase` in `text`, starting at an identifier boundary ("recreate is not…" doesn't mention "create is not…"). */
export function mentions(text: string, phrase: string): boolean {
  for (let i = text.indexOf(phrase); i !== -1; i = text.indexOf(phrase, i + 1)) {
    if (i === 0 || !/[\w$]/.test(text[i - 1]!)) return true;
  }
  return false;
}

export function similarity(query: string, title: string, body: string | null | undefined): SimilarityBreakdown {
  const q = [...new Set(tokenize(query))];
  const b = (body ?? '').slice(0, 20_000);
  const titleCov = coverage(q, title);
  const bodyCov = coverage(q, b);
  const msg = normalizeMessage(query);
  const nTitle = normalizeMessage(title);
  const nBody = normalizeMessage(b);
  // Require a reasonably specific message before trusting a substring match.
  const specific = msg.length >= 15;
  const inTitle = specific && nTitle.includes(msg);
  const inBody = specific && !inTitle && nBody.includes(msg);
  const verbatim = inTitle || inBody;
  const blended = 0.6 * titleCov + 0.4 * Math.max(bodyCov, titleCov);
  // Verbatim in the title is near-certain. Verbatim only in the body is weaker:
  // common errors get pasted into the logs of many unrelated issues.
  let score = inTitle ? Math.max(blended, 0.8 + 0.2 * titleCov) : inBody ? Math.max(blended, 0.5 + 0.4 * titleCov) : blended;

  const a = extractAnchor(query);
  let anchor: SimilarityBreakdown['anchor'];
  if (a) {
    const found = a.phrases.some((p) => mentions(nTitle, p)) ? 'title' : a.phrases.some((p) => mentions(nBody, p)) ? 'body' : 'none';
    anchor = { term: a.term, found };
    if (found === 'none') score = Math.min(score, ANCHOR_MISS_CAP);
  }
  return { score: round(score), title: round(titleCov), body: round(bodyCov), verbatim, ...(anchor ? { anchor } : {}) };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
