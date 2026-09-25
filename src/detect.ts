/**
 * M1 pipeline: parse → lockfile → resolve.
 * Produces the list of packages implicated by the error, with installed
 * versions and GitHub repos.
 */
import { basename, dirname } from 'node:path';
import { Diagnostics } from './diagnostics.js';
import {
  findInNodeModules,
  locateLockfile,
  LockfileError,
  openLockfile,
  type InstalledPackage,
  type LockfileReader,
} from './lockfile/index.js';
import type { NetClient } from './net/client.js';
import { parseError, type PackageCandidate, type ParsedError } from './parse/index.js';
import { parseGitHubUrl, ResolveError, resolveRepo, type RepoRef, type ResolvedRepo } from './resolve/index.js';

export interface DetectedPackage {
  candidate: PackageCandidate;
  /** The copy the app most likely loaded (top-level first). */
  installed?: InstalledPackage;
  /** Other copies at different versions (nested node_modules). */
  otherCopies: InstalledPackage[];
  repo?: ResolvedRepo;
}

export interface DetectResult {
  parsed: ParsedError;
  lockfile?: { kind: LockfileReader['kind']; file: string };
  packages: DetectedPackage[];
  /** Set when --repo was given. */
  explicitRepo?: RepoRef;
  diagnostics: Diagnostics;
  /** Look up another package's installed version (used to link --repo to a package). */
  lookupInstalled: (name: string) => { installed?: InstalledPackage; otherCopies: InstalledPackage[] };
}

/** Lockfile first, then node_modules (capped at the lockfile's directory). Warns when not found. */
export function lookupInstalled(
  cwd: string,
  reader: LockfileReader | undefined,
  name: string,
  diagnostics: Diagnostics,
): { installed?: InstalledPackage; otherCopies: InstalledPackage[] } {
  const copies = reader?.find(name) ?? [];
  if (copies.length) {
    return { installed: copies[0]!, otherCopies: copies.slice(1).filter((c) => c.version !== copies[0]!.version) };
  }
  const nm = findInNodeModules(cwd, name, reader ? dirname(reader.file) : undefined);
  if (nm.found) {
    if (reader) diagnostics.info('lockfile', `${name} is not in ${reader.file}; using ${nm.found.source}.`);
    return { installed: nm.found, otherCopies: [] };
  }
  const where = reader ? [`${reader.file} (no entry)`, ...nm.tried] : nm.tried;
  diagnostics.warn(
    'lockfile',
    `${name} is not installed in this project${reader ? ` (not in ${basename(reader.file)} or node_modules)` : ''}; its version can't be compared. Wrong --cwd?`,
    where,
  );
  return { otherCopies: [] };
}

export interface DetectOptions {
  cwd: string;
  client: NetClient;
  /** owner/name — skips package→repo detection. */
  repo?: string;
  /** Max packages to resolve against the registry. */
  maxPackages?: number;
}

export async function detect(input: string, opts: DetectOptions): Promise<DetectResult> {
  const diagnostics = new Diagnostics();
  const parsed = parseError(input);
  if (!parsed.query) diagnostics.warn('parse', 'Could not find an error message line in the input.');

  let explicitRepo: RepoRef | undefined;
  if (opts.repo) {
    explicitRepo = parseGitHubUrl(opts.repo);
    if (!explicitRepo) throw new Error(`--repo must look like owner/name, got "${opts.repo}"`);
  }

  if (parsed.packages.length === 0 && !explicitRepo) {
    diagnostics.warn(
      'parse',
      'No npm packages found in the error. fixedin looks for node_modules/<pkg>/ paths in stack frames and "Cannot find module" messages. Paste the full stack trace, or pass --repo owner/name.',
    );
  }

  // Lockfile
  let reader: LockfileReader | undefined;
  const { found, tried } = locateLockfile(opts.cwd);
  if (!found) {
    diagnostics.warn('lockfile', `No lockfile found from ${opts.cwd} upward; will read node_modules/*/package.json instead.`, tried);
  } else {
    try {
      reader = openLockfile(found, opts.cwd);
    } catch (err) {
      if (!(err instanceof LockfileError)) throw err;
      diagnostics.warn('lockfile', err.message, err.tried);
    }
  }

  const max = opts.maxPackages ?? 8;
  const selected = parsed.packages.slice(0, max);
  if (parsed.packages.length > max) {
    diagnostics.info(
      'parse',
      `Found ${parsed.packages.length} packages in the trace; only the top ${max} are resolved: skipped ${parsed.packages
        .slice(max)
        .map((p) => p.name)
        .join(', ')}.`,
    );
  }

  const packages = await Promise.all(
    selected.map(async (candidate): Promise<DetectedPackage> => {
      const det: DetectedPackage = { candidate, otherCopies: [] };

      const found = lookupInstalled(opts.cwd, reader, candidate.name, diagnostics);
      if (found.installed) det.installed = found.installed;
      det.otherCopies = found.otherCopies;

      if (!explicitRepo) {
        try {
          det.repo = await resolveRepo(opts.client, candidate.name);
        } catch (err) {
          if (!(err instanceof ResolveError)) throw err;
          diagnostics.warn('resolve', err.message, err.tried);
        }
      }
      return det;
    }),
  );

  for (const w of new Set(reader?.warnings ?? [])) diagnostics.warn('lockfile', w);

  return {
    parsed,
    ...(reader ? { lockfile: { kind: reader.kind, file: reader.file } } : {}),
    lookupInstalled: (name: string) => lookupInstalled(opts.cwd, reader, name, diagnostics),
    packages,
    ...(explicitRepo ? { explicitRepo } : {}),
    diagnostics,
  };
}
