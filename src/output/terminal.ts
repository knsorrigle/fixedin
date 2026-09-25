import pc from 'picocolors';
import type { DetectResult } from '../detect.js';
import type { Diagnostic } from '../diagnostics.js';
import { relative } from 'node:path';

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
        lines.push(pc.dim(`      (tried ${d.tried.length} location${d.tried.length === 1 ? '' : 's'}; --verbose to list)`));
      }
      return lines.join('\n');
    })
    .join('\n');
}

function displayPath(p: string, cwd: string): string {
  if (!p.startsWith('/')) return p;
  const rel = relative(cwd, p);
  return rel.startsWith('..') && rel.split('/').length > 3 ? p : rel || p;
}
