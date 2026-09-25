/**
 * A deliberately tiny reader for the YAML subset pnpm writes in pnpm-lock.yaml:
 * block mappings with consistent indentation, plain/single-/double-quoted
 * scalars, and inline flow collections (`{integrity: …}`, `[x64]`) that we keep
 * as raw strings. Block sequences (`- item`) are skipped — the lockfile reader
 * never needs them. This avoids a YAML dependency for one machine-generated format.
 *
 * Also handles what pnpm emits for long `deprecated:` messages: block scalars
 * (`|`, `|-`, `>`) and quoted strings wrapped over several lines.
 *
 * Not a general YAML parser: anchors, aliases and tags are rejected with an
 * error naming the line, rather than misread.
 */

export type YamlValue = string | YamlMap;
export interface YamlMap {
  [key: string]: YamlValue;
}

export class YamlSubsetError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${line}: ${message}`);
    this.name = 'YamlSubsetError';
  }
}

/** Split multi-document files (pnpm ≥9.7 can prepend an env document) on `---`. */
export function splitDocuments(text: string): string[] {
  return text.split(/^---[ \t]*$/m).filter((d) => d.trim());
}

export function parseYamlSubset(text: string): YamlMap {
  const root: YamlMap = {};
  // Stack of open mappings with the indent of their keys.
  const stack: Array<{ indent: number; map: YamlMap }> = [{ indent: -1, map: root }];
  let pendingKey: { key: string; indent: number; parent: YamlMap } | undefined;
  let inSequenceBelow: number | undefined;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const lineNo = i + 1;
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    if (raw.slice(0, indent).includes('\t')) throw new YamlSubsetError('tab indentation is not supported', lineNo);
    const content = raw.slice(indent);

    // Skip block sequences and everything nested in them.
    if (inSequenceBelow !== undefined) {
      if (indent > inSequenceBelow || (indent === inSequenceBelow && content.startsWith('- '))) continue;
      inSequenceBelow = undefined;
    }
    if (content === '-' || content.startsWith('- ')) {
      // The key that introduced the sequence gets an empty value.
      if (pendingKey) {
        pendingKey.parent[pendingKey.key] = '';
        pendingKey = undefined;
      }
      inSequenceBelow = indent;
      continue;
    }

    // A pending "key:" becomes a mapping if the next line is indented deeper.
    if (pendingKey) {
      if (indent > pendingKey.indent) {
        const child: YamlMap = {};
        pendingKey.parent[pendingKey.key] = child;
        stack.push({ indent, map: child });
      } else {
        pendingKey.parent[pendingKey.key] = '';
      }
      pendingKey = undefined;
    }

    while (stack.length > 1 && indent < stack.at(-1)!.indent) stack.pop();
    const top = stack.at(-1)!;
    if (indent !== top.indent && top.indent !== -1) {
      throw new YamlSubsetError(`unexpected indentation (${indent} spaces, expected ${top.indent})`, lineNo);
    }
    if (top.indent === -1) top.indent = indent;

    const { key, rest } = splitKey(content, lineNo);
    if (rest === '') {
      pendingKey = { key, indent, parent: top.map };
    } else if (/^[|>][-+]?\d*$/.test(rest)) {
      // Block scalar: every following line indented deeper (or blank) belongs to it.
      const body: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        if (next.trim() && next.length - next.trimStart().length <= indent) break;
        body.push(next);
        i++;
      }
      top.map[key] = blockScalar(rest, body);
    } else if (/^[&*!]/.test(rest)) {
      throw new YamlSubsetError('anchors, aliases and tags are not supported', lineNo);
    } else {
      // A quoted scalar may be wrapped onto following lines; fold them in.
      let value = rest;
      while (isUnterminatedQuote(value) && i + 1 < lines.length) {
        const next = lines[++i]!.trim();
        value = next ? `${value} ${next}` : `${value}\n`;
      }
      top.map[key] = scalar(value, lineNo);
    }
  }
  if (pendingKey) pendingKey.parent[pendingKey.key] = '';
  return root;
}

function splitKey(content: string, lineNo: number): { key: string; rest: string } {
  if (content.startsWith("'") || content.startsWith('"')) {
    const q = content[0]!;
    let j = 1;
    let key = '';
    for (; j < content.length; j++) {
      const ch = content[j]!;
      if (q === "'" && ch === "'" && content[j + 1] === "'") {
        key += "'";
        j++;
      } else if (q === '"' && ch === '\\') {
        key += content[++j] ?? '';
      } else if (ch === q) {
        break;
      } else {
        key += ch;
      }
    }
    const after = content.slice(j + 1);
    if (!after.startsWith(':')) throw new YamlSubsetError('expected ":" after quoted key', lineNo);
    return { key, rest: after.slice(1).trim() };
  }
  // Plain key: ends at the first ": " or a trailing ":".
  const m = content.match(/^(.*?):(?:\s+(.*))?$/);
  if (!m) throw new YamlSubsetError(`expected "key: value", got ${JSON.stringify(content.slice(0, 60))}`, lineNo);
  return { key: m[1]!, rest: (m[2] ?? '').trim() };
}

function isUnterminatedQuote(v: string): boolean {
  if (v.startsWith("'")) {
    // Closed by a lone ' ('' is an escaped quote).
    return !/^'(?:[^']|'')*'\s*(#.*)?$/.test(v);
  }
  if (v.startsWith('"')) return !/^"(?:[^"\\]|\\.)*"\s*(#.*)?$/.test(v);
  return false;
}

/** Literal (|) keeps newlines, folded (>) joins lines with spaces; chomping - strips, + keeps. */
function blockScalar(header: string, body: string[]): string {
  const nonBlank = body.filter((l) => l.trim());
  const indent = nonBlank.length ? Math.min(...nonBlank.map((l) => l.length - l.trimStart().length)) : 0;
  const lines = body.map((l) => l.slice(indent));
  let text = header.startsWith('|') ? lines.join('\n') : lines.map((l) => l || '\n').join(' ').replace(/ ?\n ?/g, '\n');
  if (header.includes('-')) text = text.replace(/\n+$/, '');
  else if (!header.includes('+')) text = text.replace(/\n*$/, '\n');
  return text;
}

function scalar(rest: string, lineNo: number): string {
  if (rest.startsWith("'") || rest.startsWith('"')) {
    if (isUnterminatedQuote(rest)) throw new YamlSubsetError('unterminated quoted string', lineNo);
    const quoted = rest.replace(/\s+#.*$/, '');
    return quoted.startsWith("'") ? quoted.slice(1, -1).replace(/''/g, "'") : (JSON.parse(quoted) as string);
  }
  // Plain scalars and flow collections ({…}, […]) are kept verbatim, minus a trailing comment.
  return rest.replace(/\s+#.*$/, '');
}
