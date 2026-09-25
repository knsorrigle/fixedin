/**
 * parse/: turn raw error text (one line or a full stack trace) into
 *   - a cleaned query string suitable for issue search
 *   - error codes (ERR_*, errno-style E*, Prisma P####)
 *   - candidate npm packages, ranked by how likely they are the culprit
 */

export type CandidateSource = 'stack-frame' | 'vite-deps' | 'deno-npm-cache' | 'module-not-found';

export interface PackageCandidate {
  name: string;
  /** How many stack frames / mentions referenced this package. */
  hits: number;
  /** Index of the first line mentioning it (lower = closer to the throw site). */
  firstLine: number;
  source: CandidateSource;
  /** Test runners, bundlers etc. that show up in almost every trace. */
  lowSignal: boolean;
  /** What the first frame (closest to the throw) says about which copy threw. */
  copy?: FrameCopy;
}

/**
 * The installed copy a stack frame points at.
 *   installPath: "/app/node_modules/wait-on/node_modules/axios" — matched against
 *                lockfile install locations to find a nested copy.
 *   version:     embedded by some installers, so no lockfile is needed:
 *                pnpm   node_modules/.pnpm/axios@1.1.3_…/node_modules/axios
 *                bun    node_modules/.bun/axios@1.1.3/node_modules/axios
 *                yarn   .yarn/cache/axios-npm-1.1.3-<hash>-<hash>.zip/node_modules/axios
 *                deno   …/npm/registry.npmjs.org/axios/1.1.3/
 */
export interface FrameCopy {
  installPath?: string;
  version?: string;
  versionFrom?: 'pnpm' | 'bun' | 'yarn-cache' | 'deno-cache';
}

export interface ParsedError {
  /** The line chosen as the error message, before cleaning. */
  messageLine: string;
  /** Cleaned search query. */
  query: string;
  errorCodes: string[];
  packages: PackageCandidate[];
}

// Frames from these packages appear in nearly every trace of their kind and
// are rarely the cause. They're still reported, just ranked last.
const LOW_SIGNAL = [
  /^jest(-.*)?$/,
  /^@jest\//,
  /^vitest$/,
  /^@vitest\//,
  /^mocha$/,
  /^ts-node$/,
  /^tsx$/,
  /^@babel\/runtime$/,
  /^regenerator-runtime$/,
  /^tslib$/,
  /^source-map-support$/,
  /^pirates$/,
];

// errno / npm-style codes. An explicit list, because a bare /E[A-Z]+/ matches
// "ERROR", "ESM", "ESLINT", …
const ERRNO_CODES = new Set([
  'EACCES', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EAI_AGAIN', 'EBADENGINE', 'EBADF', 'EBUSY',
  'ECANCELED', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EEXIST', 'EHOSTUNREACH',
  'EINTEGRITY', 'EINVAL', 'EIO', 'EISDIR', 'ELIFECYCLE', 'ELOOP', 'EMFILE', 'ENAMETOOLONG',
  'ENETUNREACH', 'ENFILE', 'ENOENT', 'ENOMEM', 'ENOSPC', 'ENOTDIR', 'ENOTEMPTY', 'ENOTFOUND',
  'ENOTSUP', 'EPERM', 'EPIPE', 'EPROTO', 'ERESOLVE', 'EROFS', 'ESPIPE', 'ETIMEDOUT', 'ETXTBSY',
  'EXDEV', 'E401', 'E403', 'E404', 'E500', 'EJSONPARSE', 'EUNSUPPORTEDPROTOCOL',
]);

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const FRAME = /^\s*at\s|^\s*[\w$.<>]*@\S+:\d+(:\d+)?\s*$/; // V8 "at …" and Firefox/Safari "fn@file:1:2"

/** A package segment directly after the LAST node_modules/ in a path. */
const NODE_MODULES_PKG = /node_modules[\\/]+(?!.*node_modules[\\/])((?:@[^\\/\s:()'"]+[\\/]+)?[^\\/\s:()'"]+)/;
const VITE_DEP = /node_modules[\\/]\.vite[\\/]deps[\\/]([^\\/\s:?()'"]+?)\.[mc]?js/;
/**
 * Deno runs npm packages from its cache, not node_modules:
 *   …/deno/npm/registry.npmjs.org/axios/1.1.3/lib/core/Axios.js
 *   …/deno/npm/registry.npmjs.org/@scope/pkg/1.0.0/index.js
 * A registry host segment followed by a version segment keeps this specific.
 */
const DENO_NPM_CACHE =
  /[\\/]npm[\\/][a-z0-9.-]+\.[a-z]{2,}(?::\d+)?[\\/]((?:@[^\\/\s:()'"]+[\\/])?[^\\/\s:()'"]+)[\\/](\d+\.\d+\.\d+[^\\/\s]*)[\\/]/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MODULE_NOT_FOUND = [
  /Cannot find module ['"]([^'"]+)['"]/,
  /Can't resolve ['"]([^'"]+)['"]/,
  /Failed to resolve import ['"]([^'"]+)['"]/,
  /Cannot find package ['"]([^'"]+)['"]/,
];

export function parseError(input: string): ParsedError {
  const lines = input.replace(ANSI, '').replace(/\r\n?/g, '\n').split('\n');
  const messageLine = pickMessageLine(lines);
  return {
    messageLine,
    query: cleanQuery(messageLine),
    errorCodes: extractErrorCodes(input),
    packages: extractPackages(lines),
  };
}

/**
 * The "first line" of the error. Prefer the first line that looks like
 * `SomethingError: message`; otherwise the first non-empty, non-frame line.
 * Skips runner decoration like jest's "● Test suite failed to run".
 */
export function pickMessageLine(lines: string[]): string {
  const firstFrame = lines.findIndex((l) => FRAME.test(l));
  const candidates = lines
    .slice(0, firstFrame === -1 ? 40 : Math.max(firstFrame, 1))
    .map((l) => l.trim())
    .filter((l) => l && !FRAME.test(l) && !isDecoration(l));
  const errorLike = candidates.find((l) => ERROR_LINE.test(l)) ?? candidates.find((l) => KNOWN_MESSAGE.test(l));
  let chosen = errorLike ?? candidates[0] ?? '';
  // Drop decoration before the error name: "⨯ ", "● ", "[vite] ", timestamps.
  const m = chosen.match(/((?:\w*Error|Exception)(?:\s*\[[\w-]+\])?:.*)$/);
  chosen = (m?.[1] ?? chosen).trim();
  // "PrismaClientKnownRequestError:" with the message several lines later:
  // use the last prose line before the first stack frame.
  if (/:$/.test(chosen)) {
    const detail = candidates.slice(candidates.indexOf(errorLike ?? '') + 1).filter((l) => !/:$/.test(l) && !looksLikePath(l)).at(-1);
    if (detail) chosen = `${chosen} ${detail}`;
  }
  return chosen;
}

const ERROR_LINE = /(^|\s)(\w*Error|Exception)(\s*\[[\w-]+\])?:(\s*\S|\s*$)/;
const KNOWN_MESSAGE = /^(Module not found|Failed to resolve|Cannot find (module|package))\b/;

function isDecoration(l: string): boolean {
  return (
    /^[-=─━~^|]+$/.test(l) || // rules and carets
    /^[>→]?\s*\d+\s*(\||\s)/.test(l) || // code excerpts: "> 3 | import …", "→ 27 const …"
    /^(FAIL|PASS)\s/.test(l) ||
    /^●/.test(l) ||
    /^https?:\/\/\S+$/.test(l) || // bare doc links
    /^\.{0,2}\/?[\w./-]+:\d+(:\d+)?$/.test(l) // "./app/page.tsx:3:1"
  );
}

function looksLikePath(l: string): boolean {
  return /^(-\s+)?([A-Za-z]:\\|\/|\.{1,2}\/)\S+$/.test(l);
}

/** Strip anything machine-specific so the query matches other people's reports. */
export function cleanQuery(line: string): string {
  let q = line;
  // A stack frame pasted onto the same line: "… ECONNREFUSED at /srv/app/x.js:1:2"
  q = q.replace(/\s+at\s+(?:[\w$.<>\[\] ]+\s+\()?(?:file:|node:|webpack|https?:|\/|[A-Za-z]:\\).*$/, '');
  // URLs to local files / dev servers
  q = q.replace(/\b(?:file|webpack(?:-internal)?|https?):\/\/\/?(?:localhost|127\.0\.0\.1)?[^\s'"`)]*/g, ' ');
  // Windows absolute paths
  q = q.replace(/\b[A-Za-z]:\\[^\s'"`)]*/g, ' ');
  // POSIX absolute paths (need at least one more segment so "/" alone survives)
  q = q.replace(/(^|[\s'"`(=])\/[^\s'"`)]*\/[^\s'"`)]*/g, '$1 ');
  // Remaining relative paths into node_modules
  q = q.replace(/(?:\.{1,2}\/)?node_modules\/[^\s'"`)]*/g, ' ');
  // UUIDs
  q = q.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ' ');
  // IPv4 addresses (with optional port)
  q = q.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, ' ');
  // Hex addresses and long hex hashes
  q = q.replace(/\b0x[0-9a-f]+\b/gi, ' ');
  q = q.replace(/\b[0-9a-f]{12,}\b/gi, ' ');
  // :line:col, (line:col), "line 12, column 4"
  q = q.replace(/\(\s*\d+\s*[:,]\s*\d+\s*\)/g, ' ');
  q = q.replace(/:\d+(?::\d+)?\b/g, ' ');
  q = q.replace(/\bline \d+(?:,? col(?:umn)? \d+)?/gi, ' ');
  // Empty quotes/parens left behind, then whitespace
  // (only parens that held something we removed — keep "require()")
  q = q.replace(/(['"`])\s+\1/g, ' ').replace(/\(\s+\)/g, ' ');
  return q.replace(/\s+/g, ' ').trim();
}

export function extractErrorCodes(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\b(ERR_[A-Z0-9_]+)\b/g)) found.add(m[1]!);
  for (const m of text.matchAll(/\b(E[A-Z0-9_]{2,})\b/g)) if (ERRNO_CODES.has(m[1]!)) found.add(m[1]!);
  // Explicit `code: 'X'` / `code: "X"` — trust any all-caps identifier here.
  for (const m of text.matchAll(/\bcode:\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g)) found.add(m[1]!);
  // Prisma error codes (P1001, P2002, …) only when Prisma is involved.
  if (/prisma/i.test(text)) for (const m of text.matchAll(/\b(P[1-6]\d{3})\b/g)) found.add(m[1]!);
  return [...found];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Install path of `name` in a frame: everything up to and including ".../node_modules/<name>". */
export function installPathIn(line: string, name: string): string | undefined {
  const l = line.replace(/\\/g, '/');
  const marker = `node_modules/${name}`;
  let end = -1;
  for (let i = l.indexOf(marker); i !== -1; i = l.indexOf(marker, i + 1)) {
    const after = l[i + marker.length];
    if (after === undefined || after === '/' || after === ':' || after === ')') end = i + marker.length;
  }
  if (end === -1) return undefined;
  const head = l.slice(0, end);
  const start = Math.max(head.lastIndexOf('('), head.lastIndexOf(' '), head.lastIndexOf('"'), head.lastIndexOf("'")) + 1;
  return head
    .slice(start)
    .replace(/^webpack-internal:\/\/\//, '') // relative: "webpack-internal:///./node_modules/x"
    .replace(/^file:\/\//, '')
    .replace(/^\/([A-Za-z]:\/)/, '$1'); // file:///C:/… → C:/…
}

/** What a frame says about which copy of `name` it ran. */
export function frameCopy(line: string, name: string, source: CandidateSource): FrameCopy | undefined {
  const l = line.replace(/\\/g, '/');
  if (source === 'deno-npm-cache') {
    const m = l.match(DENO_NPM_CACHE);
    const v = m?.[2];
    return v && SEMVER.test(v) ? { version: v, versionFrom: 'deno-cache' } : undefined;
  }
  if (source !== 'stack-frame') return undefined;
  const installPath = installPathIn(line, name);
  const copy: FrameCopy = installPath ? { installPath } : {};

  // pnpm / bun virtual store: ".pnpm/@scope+pkg@1.2.3_peer@4.5.6/node_modules/@scope/pkg"
  const store = installPath?.match(new RegExp(`/node_modules/\\.(pnpm|bun)/([^/]+)/node_modules/${escapeRe(name)}$`));
  const enc = name.replace('/', '+');
  if (store && store[2]!.startsWith(`${enc}@`)) {
    const v = store[2]!.slice(enc.length + 1).split(/[_(]/)[0]!;
    if (SEMVER.test(v)) return { ...copy, version: v, versionFrom: store[1] === 'pnpm' ? 'pnpm' : 'bun' };
  }
  // yarn Berry zip cache: "@scope-pkg-npm-1.2.3-0123456789-abcdef0123.zip/node_modules/@scope/pkg/"
  const zip = l.match(new RegExp(`/${escapeRe(name.replace('/', '-'))}-npm-([^/]+?)-[0-9a-f]{10}(?:-[0-9a-f]{10})?\\.zip/node_modules/${escapeRe(name)}/`));
  if (zip && SEMVER.test(zip[1]!)) return { ...copy, version: zip[1]!, versionFrom: 'yarn-cache' };
  return installPath ? copy : undefined;
}

export function extractPackages(lines: string[]): PackageCandidate[] {
  const byName = new Map<string, PackageCandidate>();
  const add = (raw: string, line: number, source: CandidateSource) => {
    const name = normalizePackageName(raw);
    if (!name) return;
    const existing = byName.get(name);
    if (existing) {
      existing.hits++;
      // The first frame is the throw site; later ones only fill a gap.
      existing.copy ??= frameCopy(lines[line]!, name, source);
      return;
    }
    const copy = frameCopy(lines[line]!, name, source);
    byName.set(name, { name, hits: 1, firstLine: line, source, lowSignal: LOW_SIGNAL.some((r) => r.test(name)), ...(copy ? { copy } : {}) });
  };

  lines.forEach((line, i) => {
    const vite = line.match(VITE_DEP);
    if (vite) {
      const name = viteDepToPackage(vite[1]!);
      if (name) add(name, i, 'vite-deps');
      return;
    }
    const nm = line.match(NODE_MODULES_PKG);
    if (nm) add(nm[1]!, i, 'stack-frame');
    else {
      const deno = line.match(DENO_NPM_CACHE);
      if (deno) add(deno[1]!, i, 'deno-npm-cache');
    }
    for (const re of MODULE_NOT_FOUND) {
      const m = line.match(re);
      if (m) add(bareSpecifierToPackage(m[1]!) ?? '', i, 'module-not-found');
    }
  });

  return [...byName.values()].sort(
    (a, b) => Number(a.lowSignal) - Number(b.lowSignal) || a.firstLine - b.firstLine || b.hits - a.hits,
  );
}

function normalizePackageName(raw: string): string | undefined {
  const name = raw.replace(/\\/g, '/').replace(/\/+/g, '/');
  // .pnpm, .bin, .cache, .vite, .prisma — tooling directories, not packages.
  if (name.startsWith('.')) return undefined;
  if (!isValidPackageName(name)) return undefined;
  return name;
}

export function isValidPackageName(name: string): boolean {
  // Uppercase is allowed: legacy packages like JSONStream still exist.
  return /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(name);
}

/** "lodash/fp" → "lodash", "@scope/pkg/sub" → "@scope/pkg"; relative/node: specifiers → undefined. */
export function bareSpecifierToPackage(spec: string): string | undefined {
  if (/^(\.|\/|[A-Za-z]:\\|node:|#|~\/|@\/)/.test(spec)) return undefined;
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  return isValidPackageName(name) ? name : undefined;
}

/**
 * Vite's optimized deps are flattened to one file per entry:
 *   react-dom.js, react-dom_client.js, @tanstack_react-query.js, chunk-ABC123.js
 */
export function viteDepToPackage(file: string): string | undefined {
  if (/^chunk-/.test(file)) return undefined;
  if (file.startsWith('@')) {
    const [scope, rest] = [file.slice(0, file.indexOf('_')), file.slice(file.indexOf('_') + 1)];
    if (!rest) return undefined;
    return `${scope}/${rest.split('_')[0]}`;
  }
  return file.split('_')[0];
}
