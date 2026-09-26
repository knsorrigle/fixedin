/**
 * --markdown: the verdicts as GitHub-flavored markdown, for PR comments and
 * job summaries (used by the GitHub Action in action.yml).
 *
 * Issue titles, release notes and error messages come from strangers, so every
 * piece of untrusted text is neutralized before it lands in a comment: no
 * @-mentions (they would ping people), no raw HTML, no markdown that could
 * break out of its place, and no links other than the ones fixedin builds.
 */
import { SKIP_REASONS, type LogRunResult, type RunResult } from '../pipeline.js';
import type { Verdict } from '../verdict/index.js';

/** Marks fixedin's own PR comment, so the Action updates it instead of adding another. */
export const COMMENT_MARKER = '<!-- fixedin -->';

const HEADLINE: Record<Verdict['kind'], string> = {
  FIXED_UPSTREAM_UPGRADE: '✖ Fixed upstream — upgrade',
  ALREADY_HAVE_FIX: '⚠️ You already have the fix — likely a different bug',
  FIX_UNRELEASED: '◐ Fix merged, not released yet',
  OPEN_ISSUE: '● Known open issue',
  CLOSED_NO_FIX_FOUND: '? Closed, no fix traced',
  NO_MATCH: '○ No matching issue',
};

/** Untrusted text → safe inline markdown. */
export function inline(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const cut = oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
  return (
    cut
      // HTML and markdown punctuation that could restructure the comment.
      .replace(/[\\`*_{}[\]<>()|!~]/g, (c) => `\\${c}`)
      // "@someone" / "@org/team" would notify them; a zero-width joiner breaks the mention.
      .replace(/@(?=[\w-])/g, '@\u200d')
      // "#123" / "owner/repo#123" would link to an issue in the *reader's* repo.
      .replace(/#(?=\d)/g, '#\u200d')
      // Bare URLs auto-link; break the scheme so only links fixedin builds are clickable.
      .replace(/\b(https?):\/\//gi, '$1\u200d://')
  );
}

/** Untrusted text for a fenced code block: pick a fence longer than any backtick run inside. */
export function codeBlock(text: string, lang = ''): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

/** Only https URLs on github.com / npmjs.com that fixedin itself produced. */
function link(label: string, url: string | undefined): string {
  if (!url || !/^https:\/\/(github\.com|www\.npmjs\.com)\//.test(url)) return label;
  return `[${label}](${url.replace(/[()\s]/g, encodeURIComponent)})`;
}

function verdictBlock(v: Verdict, query: string): string {
  const out: string[] = [];
  const who = v.packageName ?? `${v.repo.owner}/${v.repo.repo}`;
  out.push(`#### ${HEADLINE[v.kind]}: \`${who.replace(/`/g, '')}\``);
  out.push('');
  out.push(`> ${inline(query)}`);
  out.push('');
  if (v.match) {
    const ref = `${v.repo.owner}/${v.repo.repo}#${v.match.number}`;
    out.push(`- **Matched:** ${link(ref, v.match.url)} (${v.match.state}) — ${inline(v.match.title, 120)} · similarity ${v.match.similarity.score.toFixed(2)}${v.match.similarity.score < 0.75 ? ' _(weak match)_' : ''}`);
  }
  if (v.fix) {
    const by = v.fix.kind === 'pull_request' ? link(`PR #${v.fix.number}`, v.fix.url) : link(`commit ${v.fix.sha.slice(0, 7)}`, v.fix.url);
    const shipped = v.fixedIn ? ` → shipped in **v${v.fixedIn}**` : v.kind === 'FIX_UNRELEASED' ? ' → not in any release yet' : '';
    out.push(`- **Fixed by:** ${by}${shipped}${v.fix.evidence === 'referenced-pr-near-close' ? ' _(inferred)_' : ''}`);
  }
  if (v.releaseNote) {
    out.push(`- **Release note:** ${v.releaseNote.lines.map((l) => `“${inline(l, 160)}”`).join(' · ')} (${link('source', v.releaseNote.url)})`);
  }
  if (v.packageName) {
    const i = v.installed;
    out.push(`- **You have:** ${i ? `\`${i.version.replace(/`/g, '')}\`${i.selectedBy && !i.topLevel ? ` at \`${i.location.replace(/`/g, '')}\`` : ''}` : '_not installed here_'}`);
  }
  if (v.relation?.kind === 'transitive') {
    const p = v.remedy?.parent ?? v.relation.chain[0]!;
    out.push(`- **Comes from:** \`${p.name}@${p.version}\`${p.range ? ` (requires \`${v.packageName} ${p.range}\`)` : ''}`);
  }
  if (v.workaround) out.push(`- **Workaround:** ${link(`comment by ${v.workaround.author.replace(/[^\w-]/g, '')}`, v.workaround.url)}`);
  out.push('');
  out.push(`**→ ${inline(v.advice, 300)}**`);
  if (v.majorUpgrade) out.push(`\n⚠️ \`${v.majorUpgrade.from}\` → \`${v.majorUpgrade.to}\` is a major upgrade — check the release notes for breaking changes.`);
  if (v.remedy?.command) out.push('', codeBlock(v.remedy.command, 'sh'));
  if (v.remedy?.override) {
    out.push('', `${v.remedy.kind === 'override' ? 'Override' : 'Or force it'} in \`package.json\` (${inline(v.remedy.override.note, 200)}):`, '', codeBlock(JSON.stringify(JSON.parse(v.remedy.override.snippet), null, 2), 'json'));
  }
  return out.join('\n');
}

const NO_TARGET = '_No npm package in the error could be matched to a GitHub repo._';

const footer = (version: string) =>
  `<sub>${link(`fixedin ${version.replace(/[^\w.-]/g, '')}`, 'https://github.com/knsorrigle/fixedin')} · matched against public GitHub issues; check the linked issue before acting.</sub>`;

const verdicts = (r: RunResult) => r.verdicts.map((v) => verdictBlock(v, r.detect.parsed.query)).join('\n\n---\n\n');

export function formatMarkdown(r: RunResult, version: string): string {
  const fixes = r.verdicts.filter((v) => v.kind === 'FIXED_UPSTREAM_UPGRADE').length;
  const title =
    fixes > 0
      ? `### 🔍 fixedin: ${fixes === 1 ? 'this failure was' : `${fixes} failures were`} already fixed upstream`
      : r.verdicts.length
        ? '### 🔍 fixedin: no released fix you are missing'
        : '### 🔍 fixedin: nothing to check';
  return [COMMENT_MARKER, title, '', r.verdicts.length ? verdicts(r) : NO_TARGET, '', footer(version)].join('\n');
}

/** A whole log: one section per distinct error. A single error looks exactly like formatMarkdown. */
export function formatLogMarkdown(log: LogRunResult, version: string): string {
  if (log.errors.length === 1 && !log.skipped.length) return formatMarkdown(log.errors[0]!, version);
  const n = log.errors.length;
  const fixed = log.errors.filter((e) => e.verdicts.some((v) => v.kind === 'FIXED_UPSTREAM_UPGRADE')).length;
  const title =
    fixed > 0
      ? `### 🔍 fixedin: ${fixed} of ${n} errors in this log ${fixed === 1 ? 'was' : 'were'} already fixed upstream`
      : `### 🔍 fixedin: no released fix you are missing (${n} errors checked)`;
  const sections = log.errors.map((e, i) => {
    const where = `${e.source ? `\`${e.source.replace(/`/g, '')}\` · ` : ''}line ${e.lines.join(', ')}${e.lines.length > 1 ? ` (${e.lines.length}×)` : ''}`;
    return [`#### Error ${i + 1} of ${n} · ${where}`, '', e.verdicts.length ? verdicts(e).replace(/^####/gm, '#####') : NO_TARGET].join('\n');
  });
  const out = [COMMENT_MARKER, title, '', sections.join('\n\n---\n\n')];
  if (log.skipped.length) {
    out.push('', `<details><summary>Not checked: ${log.skipped.length} other error${log.skipped.length === 1 ? '' : 's'}</summary>`, '');
    for (const s of log.skipped) out.push(`- ${s.source ? `\`${s.source.replace(/`/g, '')}\` · ` : ''}line ${s.line}: ${inline(s.query, 120)} — ${SKIP_REASONS[s.reason]}`);
    out.push('', '</details>');
  }
  out.push('', footer(version));
  return out.join('\n');
}
