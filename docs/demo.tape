# Records docs/demo.gif — run with `npm run demo:gif` (needs vhs: `brew install vhs`).
# https://github.com/charmbracelet/vhs
#
# The run replays the recorded GitHub + npm responses from tests/fixtures/http
# (the real axios/axios#5011 case), so the GIF is identical on every recording
# and needs no network, token or API quota.

Output docs/demo.gif

Require node

Set Shell "bash"
Set FontSize 16
Set Width 1240
Set Height 680
Set Padding 24
Set Theme "Dracula"
Set WindowBar Colorful
Set TypingSpeed 45ms

# --- setup (not recorded) ------------------------------------------------------
# A throwaway "feed-reader" project with axios 1.1.3 in its lockfile and the
# real stack trace from axios/axios#5011 saved as crash.log.
Hide
Type `REPO="$PWD"; DEMO="$(mktemp -d)/feed-reader"; mkdir -p "$DEMO"`
Enter
Type `cp tests/fixtures/projects/axios-1.1.3/package.json tests/fixtures/projects/axios-1.1.3/package-lock.json "$DEMO"/`
Enter
Type `cp tests/fixtures/stacks/axios-default-create.txt "$DEMO/crash.log" && cd "$DEMO"`
Enter
Type `export FIXEDIN_REPLAY="$REPO/tests/fixtures/http" GITHUB_TOKEN=replay-only FORCE_COLOR=1`
Enter
Type `fixedin() { node "$REPO/dist/cli.js" "$@"; }; PS1='\[\e[36m\]feed-reader\[\e[0m\] $ '; clear`
Enter
Sleep 500ms
Show

# --- recorded ------------------------------------------------------------------
Sleep 600ms
Type "cat crash.log"
Sleep 400ms
Enter
Sleep 2.5s

Type "fixedin --repo axios/axios < crash.log"
Sleep 600ms
Enter
Sleep 7s

# --- cleanup (not recorded) ----------------------------------------------------
Hide
Type `cd "$REPO" && rm -rf "$(dirname "$DEMO")"`
Enter
