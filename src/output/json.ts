/**
 * The stable --json output. The zod schema is the contract: every report is
 * validated against it before printing, and `FixedinReport` is exported for
 * consumers. Additive changes keep schemaVersion; breaking ones bump it.
 */
import { z } from 'zod';
import type { Dependent, InstalledPackage } from '../lockfile/index.js';
import type { Relation } from '../relation.js';
import type { RunResult } from '../pipeline.js';

export const SCHEMA_VERSION = 1;

const Repo = z.object({
  owner: z.string(),
  repo: z.string(),
  /** Monorepo sub-directory of the package, when declared. */
  directory: z.string().nullable(),
});

const Installed = z.object({
  version: z.string(),
  /** e.g. "node_modules/axios" or "node_modules/wait-on/node_modules/axios" */
  location: z.string(),
  /** File the version was read from (or the stack-trace path, when that's the only evidence). */
  source: z.string(),
  /** Hoisted to the top-level node_modules. */
  topLevel: z.boolean(),
  /** How a stack frame chose this copy; null = the top-level copy by default. */
  selectedBy: z.enum(['frame-version', 'frame-install-path']).nullable(),
  /** When this isn't the top-level copy: the top-level version. */
  topLevelVersion: z.string().nullable(),
});

const Similarity = z.object({
  score: z.number().min(0).max(1),
  title: z.number().min(0).max(1),
  body: z.number().min(0).max(1),
  verbatim: z.boolean(),
  /**
   * The identifier the error is about and where the issue mentions it in the
   * same role ("adapter" in "adapter is not a function"). "none" caps the score
   * below the match threshold. Null when the message has no recognised shape.
   */
  anchor: z.object({ term: z.string(), found: z.enum(['title', 'body', 'none']) }).nullable(),
});

const Match = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.url(),
  state: z.enum(['open', 'closed']),
  stateReason: z.string().nullable(),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
  comments: z.number().int(),
  reactions: z.number().int(),
  labels: z.array(z.string()),
  githubRank: z.number().int(),
  similarity: Similarity,
});

const Fix = z.object({
  kind: z.enum(['pull_request', 'commit']),
  number: z.number().int().nullable(),
  title: z.string().nullable(),
  url: z.url(),
  sha: z.string(),
  mergedAt: z.string().nullable(),
  baseRef: z.string().nullable(),
  evidence: z.enum(['closed-by-pr', 'closed-by-commit', 'linked-pr', 'referenced-pr-near-close']),
});

const Workaround = z.object({
  url: z.url(),
  author: z.string(),
  reactions: z.number().int(),
  hasCode: z.boolean(),
  excerpt: z.string(),
});

export const VerdictKindSchema = z.enum([
  'FIXED_UPSTREAM_UPGRADE',
  'ALREADY_HAVE_FIX',
  'FIX_UNRELEASED',
  'OPEN_ISSUE',
  'CLOSED_NO_FIX_FOUND',
  'NO_MATCH',
]);

const SearchAttempt = z.object({
  requested: z.enum(['hybrid', 'semantic', 'lexical']),
  q: z.string(),
  used: z.enum(['hybrid', 'semantic', 'lexical']).nullable(),
  fallbackReasons: z.array(z.string()),
  totalCount: z.number().int().nullable(),
  error: z.string().nullable(),
  skipped: z.string().nullable(),
});

const DependentSchema = z.object({ name: z.string(), version: z.string(), range: z.string().nullable() });

const Dependency = z.object({
  /** direct: the project lists it; transitive: another package pulled it in; unknown: couldn't tell. */
  kind: z.enum(['direct', 'transitive', 'unknown']),
  /** Packages whose copy is the one that threw (transitive only). */
  via: z.array(DependentSchema),
  /** From the first parent up to a package the project lists itself. */
  chain: z.array(DependentSchema),
  reason: z.string().nullable(),
});

const Remedy = z.object({
  kind: z.enum(['refresh', 'upgrade-parent', 'override']),
  parent: z.object({ name: z.string(), version: z.string(), range: z.string() }),
  command: z.string().nullable(),
  note: z.string().nullable(),
  upgradeParentTo: z.object({ version: z.string(), range: z.string().nullable(), majorBump: z.boolean() }).nullable(),
  override: z.object({ snippet: z.string(), note: z.string() }).nullable(),
  summary: z.string(),
});

const Result = z.object({
  repo: Repo,
  package: z.string().nullable(),
  installed: Installed.nullable(),
  /** How the package got into the project; null when no package is linked. */
  dependency: Dependency.nullable(),
  verdict: z.object({
    kind: VerdictKindSchema,
    advice: z.string(),
    reasons: z.array(z.string()),
    match: Match.nullable(),
    fix: Fix.nullable(),
    /** Earliest stable release containing the fix. */
    fixedIn: z.string().nullable(),
    latest: z.string().nullable(),
    /** Direct check of the installed version's source. */
    installedHasFix: z.enum(['contains', 'missing', 'unknown']).nullable(),
    workaround: Workaround.nullable(),
    /** For a transitive copy: what actually gets the fix in (refresh / upgrade the parent / override). */
    remedy: Remedy.nullable(),
    /** The release-note / changelog lines that mention the fix. */
    releaseNote: z
      .object({
        source: z.enum(['github-release', 'changelog']),
        url: z.url(),
        lines: z.array(z.string()),
        matchedBy: z.enum(['pull-request', 'issue', 'commit']),
      })
      .nullable(),
    /** Upgrading a direct dependency to fixedIn crosses a major version. */
    majorUpgrade: z.object({ from: z.string(), to: z.string() }).nullable(),
  }),
  search: z.object({
    /** Mode GitHub reports it actually ran. */
    mode: z.enum(['hybrid', 'semantic', 'lexical', 'none']),
    totalCount: z.number().int(),
    attempts: z.array(SearchAttempt),
  }),
  /** Top matches after local re-ranking (length ≤ --limit). */
  matches: z.array(Match),
});

export const ReportSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  tool: z.object({ name: z.literal('fixedin'), version: z.string() }),
  input: z.object({
    messageLine: z.string(),
    query: z.string(),
    errorCodes: z.array(z.string()),
  }),
  lockfile: z.object({ kind: z.enum(['package-lock', 'pnpm', 'yarn', 'bun', 'deno']), path: z.string() }).nullable(),
  auth: z.object({ source: z.enum(['GITHUB_TOKEN', 'GH_TOKEN', 'gh auth token', 'none']) }),
  packages: z.array(
    z.object({
      name: z.string(),
      hits: z.number().int(),
      source: z.enum(['stack-frame', 'vite-deps', 'deno-npm-cache', 'module-not-found']),
      lowSignal: z.boolean(),
      installed: Installed.nullable(),
      repo: Repo.nullable(),
    }),
  ),
  /** One per searched repo. */
  results: z.array(Result),
  diagnostics: z.array(
    z.object({
      level: z.enum(['info', 'warn', 'error']),
      stage: z.string(),
      message: z.string(),
      tried: z.array(z.string()),
    }),
  ),
});

export type FixedinReport = z.infer<typeof ReportSchema>;
export type ReportResult = z.infer<typeof Result>;
export type VerdictKind = z.infer<typeof VerdictKindSchema>;

const repo = (r: { owner: string; repo: string; directory?: string }) => ({ owner: r.owner, repo: r.repo, directory: r.directory ?? null });
const installed = (i?: InstalledPackage) =>
  i
    ? {
        version: i.version,
        location: i.location,
        source: i.source,
        topLevel: i.topLevel,
        selectedBy: i.selectedBy ?? null,
        topLevelVersion: i.topLevelVersion ?? null,
      }
    : null;
const dep = (d: Dependent) => ({ name: d.name, version: d.version, range: d.range ?? null });
const dependency = (r: Relation) =>
  r.kind === 'transitive'
    ? { kind: r.kind, via: r.via.map(dep), chain: r.chain.map(dep), reason: null }
    : { kind: r.kind, via: [], chain: [], reason: r.kind === 'unknown' ? r.reason : null };
const match = (m: RunResult['searches'][number]['matches'][number]) => ({
  ...m,
  similarity: { ...m.similarity, anchor: m.similarity.anchor ?? null },
});

/** Convert an internal RunResult into the stable report, validated by the schema. */
export function toReport(r: RunResult, version: string): FixedinReport {
  const report = {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: 'fixedin' as const, version },
    input: { messageLine: r.detect.parsed.messageLine, query: r.detect.parsed.query, errorCodes: r.detect.parsed.errorCodes },
    lockfile: r.detect.lockfile ? { kind: r.detect.lockfile.kind, path: r.detect.lockfile.file } : null,
    auth: { source: r.auth.source },
    packages: r.detect.packages.map((p) => ({
      name: p.candidate.name,
      hits: p.candidate.hits,
      source: p.candidate.source,
      lowSignal: p.candidate.lowSignal,
      installed: installed(p.installed),
      repo: p.repo ? repo(p.repo) : null,
    })),
    results: r.verdicts.map((v, i) => {
      const s = r.searches[i]!;
      return {
        repo: repo(v.repo),
        package: v.packageName ?? null,
        installed: installed(v.installed),
        dependency: v.relation ? dependency(v.relation) : null,
        verdict: {
          kind: v.kind,
          advice: v.advice,
          reasons: v.reasons,
          match: v.match ? match(v.match) : null,
          fix: v.fix
            ? {
                kind: v.fix.kind,
                number: v.fix.number ?? null,
                title: v.fix.title ?? null,
                url: v.fix.url,
                sha: v.fix.sha,
                mergedAt: v.fix.mergedAt ?? null,
                baseRef: v.fix.baseRef ?? null,
                evidence: v.fix.evidence,
              }
            : null,
          fixedIn: v.fixedIn ?? null,
          latest: v.latest ?? null,
          installedHasFix: v.installedHasFix ?? null,
          workaround: v.workaround ?? null,
          remedy: v.remedy
            ? {
                kind: v.remedy.kind,
                parent: v.remedy.parent,
                command: v.remedy.command ?? null,
                note: v.remedy.note ?? null,
                upgradeParentTo: v.remedy.upgradeParentTo ?? null,
                override: v.remedy.override ?? null,
                summary: v.remedy.summary,
              }
            : null,
          releaseNote: v.releaseNote ?? null,
          majorUpgrade: v.majorUpgrade ?? null,
        },
        search: {
          mode: s.modeUsed,
          totalCount: s.totalCount,
          attempts: s.attempts.map((a) => ({
            requested: a.requested,
            q: a.q,
            used: a.used ?? null,
            fallbackReasons: a.fallbackReasons ?? [],
            totalCount: a.totalCount ?? null,
            error: a.error ?? null,
            skipped: a.skipped ?? null,
          })),
        },
        matches: s.matches.map(match),
      };
    }),
    diagnostics: r.detect.diagnostics.items.map((d) => ({ level: d.level, stage: d.stage, message: d.message, tried: d.tried ?? [] })),
  };
  // Throws if the implementation drifts from the published contract.
  return ReportSchema.parse(report);
}
