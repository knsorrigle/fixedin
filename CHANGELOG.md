# Changelog

All notable changes to fixedin. Versions follow [semver](https://semver.org); the `--json` report has its own `schemaVersion`.

## 1.0.0 — 2026-09-27

First stable release: from here on the command-line flags, exit codes and the `--json` report (`schemaVersion: 1`) change incompatibly only in a new major version.

- **Monorepos: each error's versions come from its own package.** In a Turborepo, pnpm, Docker Compose or concurrently log, the label on each line names the workspace package it came from, and that package's installed versions are used (npm, pnpm, yarn, Bun and Deno workspaces). The same error in two packages is checked once for each. npm workspaces now also honour `--cwd`.
- **Bun's binary `bun.lockb` is read** by having Bun print it as a yarn v1 lockfile (`bun bun.lockb`, same output in Bun 1.1 and 1.4). Without Bun installed, fixedin still says how to convert it and falls back to `node_modules`.
- **JSR packages.** Deno stack frames on `https://jsr.io/@scope/name/<version>/…` are reported as `jsr:@scope/name`; the GitHub repo comes from jsr.io, the installed version from `deno.lock` or the frame URL, and each release is mapped to its commit through its Sigstore provenance statement (git tags otherwise). `@jsr/scope__name` (JSR through npm) resolves the same way.
- **Better matching:** an issue that pastes the exact error message and the same throw site is a match even when its title describes the symptom differently (honojs/hono#3235, colinhacks/zod#6070).

## 0.9.0 — 2026-09-27

- Untangle monorepo logs (Turborepo, `pnpm -r`, Docker Compose, concurrently, GitHub Actions timestamps) before splitting them into errors; every output says which task an error came from.

## 0.8.0 — 2026-09-27

- Trace fixes without a GitHub token, from the public REST timeline.

## 0.7.0 — 2026-09-27

- Check each distinct error in a log with several separately; repeats are merged, and failures that can't be checked are listed. New `--max-errors`.

## 0.6.x — 2026-09-26

- GitHub Action that comments the verdict on pull requests, and `--markdown` output (0.6.0).
- Action fixes found by a real test PR (0.6.1); retry the install while npm catches up after a release (0.6.2).

## 0.5.0 — 2026-09-26

- `--exit-code` for scripts and CI: 1 when a released fix exists that you don't have, 2 when fixedin couldn't tell.

## 0.4.0 — 2026-09-25

- Match errors without an identifier by their stack frames; find fixes merged into maintenance branches.

## 0.3.0 — 2026-09-25

- Quote the release-note line for a fix.

## 0.2.0 — 2026-09-25

- Advise how to get a fix into a transitive dependency (refresh, upgrade the parent, or override).

## 0.1.x — 2026-09-25

- First release: parse an error, read the lockfile (npm, pnpm, yarn, Bun, Deno), find the repo, search its issues, trace the fixing PR, find the first release containing it, and compare with what's installed. JSON output, disk cache and rate limiting. Demo GIF (0.1.2).
