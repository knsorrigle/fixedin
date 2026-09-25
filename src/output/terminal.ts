import pc from 'picocolors';
import type { DetectResult } from '../detect.js';
import type { Diagnostic } from '../diagnostics.js';
import type { InstalledPackage } from '../lockfile/index.js';
import type { NetClient } from '../net/client.js';
import type { RunResult } from '../pipeline.js';
import { STRONG_MATCH, type Verdict } from '../verdict/index.js';
import { isAbsolute, relative } from 'node:path';

export function formatDetect(r: DetectResult, cwd: string): string {
  const out: string[] = [];
  out.push(`${pc.bold('Query:')} ${r.parsed.query || pc.dim('(none)')}`);
  if (r.parsed.errorCodes.length) out.push(`${pc.bold('Codes:')} ${r.parsed.errorCodes.join(', ')}`);
  if (r.lockfile) out.push(`${pc.bold('Lockfile:')} ${displayPath(r.lockfile.file, cwd)}`);
  if (r.explicitRepo) out.push(`${pc.bold('Repo:')} ${r.explicitRepo.owner}/${r.explicitRepo.repo} ${pc.dim('(--repo)')}`);
  out.push('');

  if (r.packages.length === 0) {
    out.push(pc.yellow('No packages detected.'));
  } else {
    out.push(pc.bold('Packages in the trace:'));
    const width = Math.max(...r.packages.map((p) => p.candidate.name.length));
    const versionText = (p: DetectResult['packages'][number]) =>
      p.installed ? `${p.installed.version} (${displayPath(p.installed.source, cwd)})` : 'not installed?';
    const vWidth = Math.max(...r.packages.map((p) => versionText(p).length));
    for (const p of r.packages) {
      const name = p.candidate.name.padEnd(width);
      const pad = ' '.repeat(vWidth - versionText(p).length);
      const version = p.installed
        ? `${pc.green(p.installed.version)} ${pc.dim(`(${displayPath(p.installed.source, cwd)})`)}${pad}`
        : pc.yellow('not installed?') + pad;
      const repo = p.repo
        ? `${pc.cyan(`${p.repo.owner}/${p.repo.repo}`)}${p.repo.directory ? pc.dim(` [${p.repo.directory}]`) : ''}`
        : pc.dim('no repo');
      const tags = [
        `${p.candidate.hits} frame${p.candidate.hits === 1 ? '' : 's'}`,
        p.candidate.source !== 'stack-frame' ? p.candidate.source : '',
        p.candidate.lowSignal ? 'low signal' : '',
      ].filter(Boolean);
      out.push(`  ${pc.bold(name)}  ${version}  → ${repo}  ${pc.dim(tags.join(', '))}`);
      for (const c of p.otherCopies) out.push(pc.dim(`  ${' '.repeat(width)}  also ${c.version} at ${c.location}`));
    }
  }
  return out.join('\n');
}

export function formatDiagnostics(items: Diagnostic[], verbose: boolean): string {
  const shown = items.filter((d) => verbose || d.level !== 'info');
  return shown
    .map((d) => {
      const tag = d.level === 'error' ? pc.red('error') : d.level === 'warn' ? pc.yellow('warn') : pc.dim('info');
      const lines = [`${tag} ${pc.dim(`[${d.stage}]`)} ${d.message}`];
      if (d.tried?.length && (verbose || d.level === 'error')) {
        for (const t of d.tried) lines.push(pc.dim(`      tried: ${t}`));
      } else if (d.tried?.length) {
        const noun = d.stage === 'lockfile' ? 'location' : 'attempt';
        lines.push(pc.dim(`      (${d.tried.length} ${noun}${d.tried.length === 1 ? '' : 's'} tried; --verbose to list)`));
      }
      return lines.join('\n');
    })
    .join('\n');
}

/**
 * "1.1.3 (from package-lock.json)", or for a copy picked from the stack trace:
 * "0.25.0 at node_modules/wait-on/node_modules/axios (from package-lock.json) — the copy in the stack trace; top-level axios is 1.1.3"
 */
function formatInstalled(i: InstalledPackage, name: string | undefined, cwd: string): string {
  const fromPath = i.source === i.location;
  const where = i.selectedBy && !i.topLevel ? ` at ${displayPath(i.location, cwd)}` : '';
  const from = fromPath ? pc.dim('(read from the stack trace path)') : pc.dim(`(from ${displayPath(i.source, cwd)})`);
  const why = i.selectedBy
    ? pc.dim(` — the copy in the stack trace${i.topLevelVersion ? `; top-level ${name ?? i.name} is ${i.topLevelVersion}` : ''}`)
    : '';
  return `${i.version}${where} ${from}${why}`;
}

/** Show paths relative to --cwd, unless that means climbing far out of it. Works with \\ and / separators. */
export function displayPath(p: string, cwd: string): string {
  if (!isAbsolute(p)) return p;
  const rel = relative(cwd, p);
  if (!rel) return p;
  const ups = rel.split(/[\\/]/).filter((s) => s === '..').length;
  return ups > 2 ? p : rel;
}

export function formatSearches(r: RunResult): string {
  const out: string[] = [];
  for (const s of r.searches) {
    const installed = s.packages
      .map((name) => r.detect.packages.find((p) => p.candidate.name === name))
      .map((p) => (p ? `${p.candidate.name}${p.installed ? ` ${p.installed.version}` : ''}` : ''))
      .filter(Boolean)
      .join(', ');
    const mode = s.modeUsed === 'hybrid' ? pc.green('hybrid') : s.modeUsed === 'none' ? pc.red('failed') : pc.yellow(s.modeUsed);
    out.push('');
    out.push(
      `${pc.bold(pc.cyan(`${s.repo.owner}/${s.repo.repo}`))}${installed ? pc.dim(` (${installed})`) : ''} · ${mode} search · ${s.totalCount} result${s.totalCount === 1 ? '' : 's'}`,
    );
    if (s.matches.length === 0) {
      out.push(pc.dim('  no matching issues'));
      continue;
    }
    const numWidth = Math.max(...s.matches.map((m) => String(m.number).length)) + 1;
    for (const m of s.matches) {
      const sim = m.similarity.score.toFixed(2);
      const simColored = m.similarity.score >= 0.7 ? pc.green(sim) : m.similarity.score >= 0.45 ? pc.yellow(sim) : pc.dim(sim);
      const state =
        m.state === 'open'
          ? pc.yellow('open    ')
          : m.stateReason === 'not_planned'
            ? pc.dim('wontfix ')
            : m.stateReason === 'duplicate'
              ? pc.dim('dup     ')
              : pc.green('closed  ');
      const title = m.title.length > 72 ? `${m.title.slice(0, 71)}…` : m.title;
      const extra = [m.similarity.verbatim ? 'verbatim' : '', m.reactions ? `${m.reactions} reactions` : ''].filter(Boolean);
      out.push(
        `  ${simColored}  ${pc.bold(`#${m.number}`.padEnd(numWidth))}  ${state}${title}${extra.length ? pc.dim(`  ${extra.join(', ')}`) : ''}`,
      );
      out.push(pc.dim(`        ${m.url}`));
    }
  }
  return out.join('\n');
}

const VERDICT_STYLE: Record<Verdict['kind'], { icon: string; color: (s: string) => string; label: string }> = {
  FIXED_UPSTREAM_UPGRADE: { icon: '✖', color: pc.red, label: 'fixed upstream — upgrade' },
  ALREADY_HAVE_FIX: { icon: '!', color: pc.yellow, label: 'you already have the fix' },
  FIX_UNRELEASED: { icon: '◐', color: pc.yellow, label: 'fix merged, not released' },
  OPEN_ISSUE: { icon: '●', color: pc.yellow, label: 'open issue' },
  CLOSED_NO_FIX_FOUND: { icon: '?', color: pc.dim, label: 'closed, no fix traced' },
  NO_MATCH: { icon: '○', color: pc.dim, label: 'no matching issue' },
};

/** The error message without its class prefix, as it'd be quoted in an issue. */
function displayMessage(query: string): string {
  const m = query.replace(/^\s*[\w$]*(?:Error|Exception)(?:\s*\[[\w-]+\])?:\s*/, '');
  return m.length > 90 ? `${m.slice(0, 89)}…` : m;
}

export function formatVerdicts(r: RunResult, cwd: string, limit: number): string {
  const out: string[] = [];
  const msg = displayMessage(r.detect.parsed.query);
  r.verdicts.forEach((v, idx) => {
    const style = VERDICT_STYLE[v.kind];
    const who = v.packageName ?? `${v.repo.owner}/${v.repo.repo}`;
    out.push('');
    out.push(`  ${style.color(style.icon)} ${pc.bold(who)}: "${msg}" ${pc.dim(`(${style.label})`)}`);
    if (v.match) {
      const state = v.match.state === 'open' ? pc.yellow('open') : v.match.stateReason === 'not_planned' ? pc.dim('closed: not planned') : 'closed';
      out.push(
        `    Matched: ${pc.cyan(`${v.repo.owner}/${v.repo.repo}#${v.match.number}`)} (${state}) — similarity ${v.match.similarity.score.toFixed(2)}${
          v.match.similarity.score < STRONG_MATCH ? pc.yellow(' (weak match — may be a different problem)') : ''
        }`,
      );
      out.push(pc.dim(`             ${v.match.title}`));
    }
    if (v.fix) {
      const by = v.fix.kind === 'pull_request' ? `PR #${v.fix.number}` : `commit ${v.fix.sha.slice(0, 7)}`;
      const shipped = v.fixedIn
        ? ` → shipped in ${pc.green(`v${v.fixedIn}`)}`
        : v.kind === 'FIX_UNRELEASED'
          ? ` → ${pc.yellow(`not in any release yet${v.latest ? ` (latest is v${v.latest})` : ''}`)}`
          : '';
      out.push(`    Fixed by: ${by}${shipped}${v.fix.evidence === 'referenced-pr-near-close' ? pc.dim(' (inferred: merged just before close)') : ''}`);
    }
    if (v.releaseNote) {
      const [first, ...more] = v.releaseNote.lines;
      out.push(`    Release note: ${pc.italic(`"${first}"`)}`);
      for (const line of more) out.push(`                  ${pc.italic(`"${line}"`)}`);
      out.push(pc.dim(`                  ${v.releaseNote.url}`));
    }
    // Shown for NO_MATCH too: it's the first thing a new bug report needs.
    if (v.packageName) {
      out.push(`    You have: ${v.installed ? formatInstalled(v.installed, v.packageName, cwd) : pc.yellow('unknown (not installed here)')}`);
    }
    if (v.relation?.kind === 'transitive') {
      const parent = v.remedy?.parent ?? v.relation.chain[0]!;
      const also = v.relation.via.length > 1 ? pc.dim(` and ${v.relation.via.length - 1} other package${v.relation.via.length > 2 ? 's' : ''}`) : '';
      const up = v.relation.chain.length > 1 ? pc.dim(` ← ${v.relation.chain.slice(1).map((d) => `${d.name}@${d.version}`).join(' ← ')}`) : '';
      out.push(`    Comes from: ${pc.cyan(`${parent.name}@${parent.version}`)}${parent.range ? pc.dim(` (requires ${v.packageName} ${parent.range})`) : ''}${up}${also}`);
    }
    if (v.workaround) {
      out.push(`    Workaround: ${pc.cyan(v.workaround.url)} ${pc.dim(`by @${v.workaround.author}, ${v.workaround.reactions} 👍`)}`);
      for (const line of v.workaround.excerpt.split('\n')) out.push(pc.dim(`      │ ${line}`));
    }
    const adviceColor = v.kind === 'FIXED_UPSTREAM_UPGRADE' ? pc.bold : (s: string) => s;
    out.push(`    → ${adviceColor(v.advice)}`);
    if (v.majorUpgrade) {
      out.push(pc.yellow(`      ${v.majorUpgrade.from} → ${v.majorUpgrade.to} is a major upgrade: read the release notes for breaking changes first`));
    }
    if (v.remedy?.note && v.remedy.command) out.push(pc.dim(`      (${v.remedy.note})`));
    if (v.remedy?.override) {
      const label = v.remedy.kind === 'override' ? 'package.json:' : 'or force it in package.json:';
      out.push(`      ${pc.dim(label)} ${v.remedy.override.snippet}`);
      out.push(pc.dim(`      (${v.remedy.override.note})`));
    }

    const others = (r.searches[idx]?.matches ?? []).filter((m) => m.number !== v.match?.number).slice(0, Math.max(0, limit - 1));
    if (others.length) {
      out.push(pc.dim(`    Other matches:`));
      for (const m of others) {
        out.push(pc.dim(`      ${m.similarity.score.toFixed(2)}  #${m.number} (${m.state})  ${m.title.length > 70 ? `${m.title.slice(0, 69)}…` : m.title}`));
      }
    }
  });
  return out.join('\n');
}

export function formatNetStats(stats: NetClient['stats']): string {
  if (!stats) return pc.dim('\nnet: replaying recorded fixtures (no cache, no live quota)');
  const lines = [''];
  if (stats.cache) {
    lines.push(pc.dim(`cache: ${stats.cache.hits} hit(s), ${stats.cache.misses} miss(es), ${stats.cache.writes} written — ${stats.cacheDir}`));
  } else {
    lines.push(pc.dim('cache: disabled'));
  }
  if (stats.quotas.size === 0) lines.push(pc.dim('quota: no GitHub requests went to the network'));
  for (const q of [...stats.quotas.values()].sort((a, b) => a.resource.localeCompare(b.resource))) {
    const low = q.remaining / Math.max(q.limit, 1) < 0.1;
    const text = `quota: GitHub ${q.resource} ${q.remaining}/${q.limit} left, resets ${new Date(q.resetAt).toLocaleTimeString()}`;
    lines.push(low ? pc.yellow(text) : pc.dim(text));
  }
  return lines.join('\n');
}
