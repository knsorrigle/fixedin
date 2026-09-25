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
  /**
   * For messages without an anchor: how the issue's pasted stack traces compare
   * with ours inside the same package. Absent when we have no in-package frames.
   */
  frames?: FrameEvidence;
}

export interface FrameEvidence {
  /** How many of our in-package frames the issue shows. */
  matched: number;
  of: number;
  /** The frame closest to the throw is among them (the strongest signal). */
  top: boolean;
  /** The issue pastes a trace through the same package that doesn't include our frames. */
  otherTrace: boolean;
}

/** Score a throw-site frame match lifts an anchorless issue to, when the message overlaps too: the "strong match" line. */
export const TOP_FRAME_FLOOR = 0.75;
/** …and when only the frame matches: over the match threshold, but shown as weak. */
export const WEAK_FRAME_FLOOR = 0.62;

/** "chunks/dep-8f5c9b2e.js" → "chunks/dep.js": bundlers hash chunk names per build. */
export function unhash(path: string): string {
  // A build hash has digits or mixed case ("8f5c9b2e", "D-7EJmVm"); a word doesn't ("listener").
  return path.replace(/[-.]([\w-]{6,20})(?=\.[cm]?js\b)/g, (m, h: string) => (/\d/.test(h) || (/[A-Z]/.test(h) && /[a-z]/.test(h)) ? '' : m));
}

/** Last two path segments, hash-stripped: what's stable across machines and builds. */
export function fileTail(file: string): string {
  return unhash(file).split('/').slice(-2).join('/');
}

/** "Function.AxiosError.from" / "AxiosError.from" → "from"; anonymous → undefined. */
export function methodName(fn: string | undefined): string | undefined {
  return fn?.split('.').filter((x) => x && !x.startsWith('<')).at(-1);
}

/**
 * Frames that every error from a library passes through say nothing about which
 * bug it is: error factories and reporters (AxiosError.from, handleRequestError,
 * createError) and generic plumbing (request, emit, call).
 */
const PLUMBING = /(error|err|exception|throw|reject|raise|fail|assert|invariant|warn|log)/i;
const GENERIC_METHODS = new Set(['request', 'get', 'set', 'emit', 'call', 'apply', 'run', 'next', 'then', 'handle', 'invoke', 'exec', 'execute', 'process', 'dispatch', 'from', 'wrap', 'bind', 'default', 'constructor', 'anonymous']);

/** Is this frame specific enough to identify a code path? */
export function informative(f: { fn?: string; file: string }): boolean {
  const m = methodName(f.fn);
  if (!m) return !BUNDLED.test(f.file); // an anonymous frame in a small source file still pins the file
  return !PLUMBING.test(m) && !GENERIC_METHODS.has(m.toLowerCase());
}

// A frame in a single bundled file (dist/axios.cjs, runtime/library.js) says
// little by file alone — thousands of issues share it — so it needs its function too.
const BUNDLED = /(^|\/)(dist|build|cjs|umd|esm|runtime|chunks)\/|\.(development|production|min)\.[cm]?js$|\.cjs$/;

export function frameEvidence(
  text: string,
  pkg: string,
  frames: Array<{ fn?: string; file: string }>,
): FrameEvidence | undefined {
  const useful = frames.filter(informative);
  if (!useful.length) return undefined;
  const lines = unhash(text.replace(/\\/g, '/')).split(/\r?\n/);
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inPkg = new RegExp(`node_modules/(\\.(pnpm|bun)/[^/]*/node_modules/)?${escaped}/|/npm/[^/]+/${escaped}/\\d+\\.\\d+\\.\\d+`);
  const pkgLines = lines.filter((l) => inPkg.test(l));
  const shows = (f: { fn?: string; file: string }) => {
    const tail = fileTail(f.file);
    const m = methodName(f.fn);
    if (!m && BUNDLED.test(f.file)) return false;
    const fnRe = m ? new RegExp(`(^|[^\\w$])${m.replace(/\$/g, '\\$')}([^\\w$]|$)`) : undefined;
    return lines.some((l) => l.includes(tail) && (!fnRe || fnRe.test(l)));
  };
  const hits = useful.map(shows);
  const matched = hits.filter(Boolean).length;
  return { matched, of: useful.length, top: hits[0] ?? false, otherTrace: matched === 0 && pkgLines.length >= 2 };
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

export function similarity(
  query: string,
  title: string,
  body: string | null | undefined,
  context?: { pkg: string; frames: Array<{ fn?: string; file: string }> },
): SimilarityBreakdown {
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
  // No identifier to anchor on ("fetch failed", "connect ECONNREFUSED"): the stack
  // trace says where it failed. Same code path → same bug; a different path
  // through the same package → a different bug.
  let frames: FrameEvidence | undefined;
  if (!a && context?.frames.length) {
    frames = frameEvidence(`${title}\n${b}`, context.pkg, context.frames);
    // The same throw site plus a fair share of the message: a strong match. The
    // same throw site alone: a match, but labelled weak (hubs like config loaders
    // sit under many different errors).
    if (frames?.top) score = Math.max(score, (Math.max(titleCov, bodyCov) >= 0.4 ? TOP_FRAME_FLOOR : WEAK_FRAME_FLOOR) + 0.05 * (frames.matched - 1));
    else if (frames && frames.matched > 0) score += 0.05 * frames.matched;
    else if (frames?.otherTrace) score = Math.min(score, ANCHOR_MISS_CAP);
    score = Math.min(score, 1);
  }
  return {
    score: round(score),
    title: round(titleCov),
    body: round(bodyCov),
    verbatim,
    ...(anchor ? { anchor } : {}),
    ...(frames ? { frames } : {}),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
