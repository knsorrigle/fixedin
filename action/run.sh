#!/usr/bin/env bash
# The fixedin GitHub Action (see action.yml). Inputs arrive as INPUT_* env vars.
set -uo pipefail

fail() { echo "::error title=fixedin::$1"; exit 2; }

[ -f "$INPUT_LOG" ] || fail "log file not found: $INPUT_LOG (write the failing output to a file first, e.g. \`npm test 2>&1 | tee test.log\`)"

# Which fixedin to run: an explicit version; else this repo's own build (the
# action's self-test); else the npm release matching this action's ref, so a
# newer fixedin never changes what an older action tag does.
out="${RUNNER_TEMP:-/tmp}/fixedin"
mkdir -p "$out"

# Install into a private prefix rather than `npx fixedin@x`: inside a project
# whose own package is named "fixedin" (this repo), npx runs that project's
# bin instead of the published package.
#
# Retries: for a minute or two after a release, npm can list the new version
# yet refuse to install it ("No matching version"), so a workflow using a
# just-released tag would fail. --prefer-online stops npm reusing its cached
# "no such version" answer between attempts.
install_fixedin() {
  local attempts=5 delay="${FIXEDIN_INSTALL_RETRY_DELAY:-10}" i
  for ((i = 1; i <= attempts; i++)); do
    if npm install --prefix "$out/pkg" --no-save --no-audit --no-fund --prefer-online --loglevel=error "fixedin@$1" >&2; then
      cmd=(node "$out/pkg/node_modules/fixedin/dist/cli.js")
      return 0
    fi
    if ((i < attempts)); then
      echo "::notice title=fixedin::Couldn't install fixedin@$1 (attempt $i of $attempts); retrying in $((delay * i))s — a just-released version can take a minute or two to become installable."
      sleep $((delay * i))
    fi
  done
  fail "couldn't install fixedin@$1 from npm after $attempts attempts (does that version exist? https://www.npmjs.com/package/fixedin?activeTab=versions)"
}
if [ -n "$INPUT_VERSION" ]; then
  install_fixedin "$INPUT_VERSION"
elif [ -f "$ACTION_PATH/dist/cli.js" ]; then
  cmd=(node "$ACTION_PATH/dist/cli.js")
else
  version=$(node -p "require(process.env.ACTION_PATH + '/package.json').version") || fail "can't read this action's version"
  install_fixedin "$version"
fi
# An older fixedin exits 1 on the unknown --exit-code flag — which would read as
# "a fix is available". Refuse versions without what this action needs.
"${cmd[@]}" --help 2>/dev/null | grep -q -- '--markdown' \
  || fail "fixedin $("${cmd[@]}" --version 2>/dev/null || echo '?') is too old for this action (needs >= 0.6.0 for --exit-code and --markdown)"
echo "Running fixedin $("${cmd[@]}" --version) (${cmd[*]})"

args=(--cwd "$INPUT_WORKING_DIRECTORY")
[ -n "$INPUT_REPO" ] && args+=(--repo "$INPUT_REPO")

report="$out/report.json"
markdown="$out/report.md"

# Diagnostics go to stderr, i.e. the job log.
"${cmd[@]}" "${args[@]}" --json --exit-code < "$INPUT_LOG" > "$report"
code=$?
# --exit-code only ever returns 0, 1 or 2; anything else means fixedin didn't
# run at all (not installed, crashed). Never let that pass as success.
if [ "$code" != 0 ] && [ "$code" != 1 ] && [ "$code" != 2 ]; then
  echo "exit-code=2" >> "$GITHUB_OUTPUT"
  echo "fix-available=false" >> "$GITHUB_OUTPUT"
  fail "fixedin didn't run (exit $code) — see the log above."
fi
# Second pass for markdown; GitHub responses come from fixedin's disk cache.
"${cmd[@]}" "${args[@]}" --markdown < "$INPUT_LOG" > "$markdown" 2>/dev/null || true

fix=false
[ "$code" = 1 ] && fix=true
{
  echo "exit-code=$code"
  echo "fix-available=$fix"
  echo "report=$report"
  echo "markdown=$markdown"
} >> "$GITHUB_OUTPUT"

[ -s "$markdown" ] && cat "$markdown" >> "$GITHUB_STEP_SUMMARY"

case "$code" in
  1) echo "::warning title=fixedin::A released upstream fix exists for this failure — see the job summary." ;;
  2) echo "::warning title=fixedin::fixedin couldn't tell whether this failure is fixed upstream — see the log above." ;;
esac

# Comment on the pull request: update fixedin's earlier comment rather than adding another.
pr=""
if [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "$GITHUB_EVENT_PATH" ]; then
  pr=$(jq -r '.pull_request.number // empty' "$GITHUB_EVENT_PATH")
fi
if [ "$INPUT_COMMENT" = "true" ] && [ -n "$pr" ] && [ ! -s "$markdown" ]; then
  echo "::warning title=fixedin::No report to comment on #$pr — the markdown pass produced nothing (see the log above)."
fi
if [ "$INPUT_COMMENT" = "true" ] && [ -n "$pr" ] && [ -s "$markdown" ]; then
  existing=$(gh api "repos/$GITHUB_REPOSITORY/issues/$pr/comments" --paginate \
    --jq '.[] | select(.user.type == "Bot" and (.body | startswith("<!-- fixedin -->"))) | .id' 2>/dev/null | head -n 1)
  if [ -n "$existing" ]; then
    gh api -X PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$existing" -F "body=@$markdown" > /dev/null \
      && echo "Updated fixedin comment on #$pr" \
      || echo "::warning title=fixedin::Couldn't update the PR comment (does the job have 'pull-requests: write'? Fork PRs get a read-only token)."
  else
    gh api "repos/$GITHUB_REPOSITORY/issues/$pr/comments" -F "body=@$markdown" > /dev/null \
      && echo "Commented on #$pr" \
      || echo "::warning title=fixedin::Couldn't comment on the PR (does the job have 'pull-requests: write'? Fork PRs get a read-only token)."
  fi
fi

if [ "$INPUT_FAIL_ON_FIX" = "true" ] && [ "$code" = 1 ]; then
  echo "::error title=fixedin::Failing because a released upstream fix exists (fail-on-fix: true)."
  exit 1
fi
exit 0
