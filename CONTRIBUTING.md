# Contributing to fixedin

Thanks for helping! The most valuable contributions are **real errors where fixedin gives the wrong answer** — every one becomes a test case.

## Setup

```bash
git clone https://github.com/knsorrigle/fixedin.git && cd fixedin
npm install
npm test            # vitest, no network access
npm run typecheck
npm run build       # tsup → dist/
node dist/cli.js --verbose "your error here"
```

Node.js 20+ is required.

## Layout

Each pipeline stage is its own module with a pure core that's tested without I/O:

| Module | Job | Pure parts to test |
|---|---|---|
| `src/parse/` | error text → query, error codes, candidate packages | everything |
| `src/lockfile/` | installed versions (package-lock v2/v3; pnpm/yarn stubbed) | `parsePackageLock` |
| `src/resolve/` | npm package → GitHub repo | `parseRepository`, `parseGitHubUrl` |
| `src/search/` | GitHub hybrid issue search + local similarity | `buildQueryText`, `similarity` |
| `src/trace/` | issue → fixing PR/commit via GraphQL timeline | `pickFix` |
| `src/release/` | fix commit → earliest npm release containing it | `candidateVersions`, binary search with a stub fetch |
| `src/verdict/` | final decision + workaround picking | `decideFixed`, `pickWorkaround` |
| `src/output/` | terminal output and the `--json` zod schema | `toReport` |
| `src/net/` | the single HTTP client: cache, rate limits, fixture record/replay | `ttlFor`, `rateLimitedFetch` with a fake clock |
| `src/pipeline.ts` | wires the stages together | via recorded end-to-end tests |

Rules of the road:

- **All network traffic goes through `NetClient`** (`src/net/client.ts`). Octokit is handed `client.fetch`, so GitHub calls are cached, rate-limited and recordable like everything else. Don't call `fetch` directly.
- **Never swallow errors.** A failure becomes a `Diagnostic` saying what was tried and why it failed (`src/diagnostics.ts`). If a fallback kicks in, say so.
- **Keep dependencies minimal.** The runtime deps are commander, @octokit/rest, semver, picocolors and zod. A PR adding one should say why the standard library or existing deps can't do the job.
- No embeddings, vector DBs, LLMs or web UI — that's a deliberate scope choice.

## Tests and fixtures

Tests must never hit the network. End-to-end tests replay real API responses recorded in `tests/fixtures/http/` — any request without a recording fails the test with the exact URL it wanted.

To record fixtures for a new case:

```bash
npm run build
FIXEDIN_RECORD=tests/fixtures/http node dist/cli.js --cwd tests/fixtures/projects/<project> < tests/fixtures/stacks/<trace>.txt
```

- Recording bypasses the cache, writes one JSON file per request, never stores `Authorization` headers, and keeps only the fields fixedin reads from compare responses and packuments. Check `git diff` before committing anyway — no tokens should appear (`grep -rE "gh[pousr]_|github_pat_" tests/fixtures` should print nothing).
- GitHub's hybrid search is limited to 10 requests/minute; space out recordings.
- To replay a case through the CLI exactly as the tests do: `FIXEDIN_REPLAY=tests/fixtures/http node dist/cli.js …`.
- Need a project with a specific installed version? `npm install --package-lock-only --ignore-scripts <pkg>@<version>` in a new `tests/fixtures/projects/<name>/` directory creates a real lockfile without a `node_modules`.

For failure paths you can't record on demand (rate limits, 5xx), use a stub fetch — see `tests/search.test.ts` and `tests/net.test.ts`.

## Changing the JSON output

`--json` is a public contract defined by `ReportSchema` in `src/output/json.ts`.

- Adding a field: add it to the schema, then run `npm run schema` to regenerate `docs/report.schema.json` (a test fails if you forget).
- Renaming/removing a field or changing its type: bump `SCHEMA_VERSION` and note it in the PR.

## Good first contributions

- `pnpm-lock.yaml` and `yarn.lock` readers (`src/lockfile/index.ts` — the interface is already defined; keep them dependency-free if possible).
- More real-world stack traces in `tests/fixtures/stacks/` with parser expectations in `tests/parse.test.ts`.
- New tag patterns in `TAG_PATTERNS` (`src/release/index.ts`) for repos whose release tags we don't recognise yet.

## Pull requests

- One logical change per PR, with tests.
- `npm test && npm run typecheck` must pass.
- Describe *why*, especially for heuristics (similarity weights, thresholds, trace rules): include the real issue that motivated it.
