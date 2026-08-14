#!/bin/bash
# Shared helpers for chrome-cdp e2e scripts. Run from the repo root
# (scripts `cd` there via their own dirname).
# Env noise: NO_COLOR/FORCE_COLOR warnings pollute captured output and break
# JSON parsing; NODE_OPTIONS silences them at the source.
export NO_COLOR=1
unset FORCE_COLOR 2>/dev/null
export NODE_OPTIONS=--no-warnings
CDP="node scripts/cdp.mjs"
E2E_PORT="${E2E_PORT:-9124}"
PASS=0; FAIL=0
ok()  { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad() { echo "  ✖ $1"; FAIL=$((FAIL+1)); }
jget() { node -e "const d=JSON.parse(process.argv[1]);console.log(d[process.argv[2]])" "$1" "$2"; }

# Wait until navigation commits. createTarget navigations are async (the tab
# briefly stays on about:blank reporting the OLD document's state), so poll
# location.href before asserting on the new page.
waitnav() {
  for i in $(seq 1 25); do
    L=$($CDP eval "$1" "location.href" 2>/dev/null)
    case "$L" in *"$2"*) return 0;; esac
    sleep 0.2
  done
  return 1
}

# Start the slow-resource server with a readiness retry loop (a fixed sleep
# 1 is flaky on a busy machine); kill it on script exit.
start_slow_server() {
  python3 "$(dirname "$0")/slow-server.py" "$E2E_PORT" >/dev/null 2>&1 &
  E2E_SRV=$!
  trap 'kill $E2E_SRV 2>/dev/null' EXIT
  for i in $(seq 1 10); do
    curl -s -m 2 "http://127.0.0.1:$E2E_PORT/slowimg" >/dev/null 2>&1 && return 0
    sleep 0.3
  done
  echo "✖ slow server unreachable on port $E2E_PORT"
  exit 1
}

summary() {
  echo ""
  echo "=== $E2E_NAME e2e: PASS=$PASS FAIL=$FAIL ==="
  [ $FAIL -eq 0 ]
}

# --- Isolated mode (default) -----------------------------------------------
# e2e NEVER touches the user's Chrome. It launches a throwaway Chrome with a
# temp profile + --remote-allow-origins=* (zero Allow prompts) and a throwaway
# daemon runtime dir (own socket/pid/log). Set E2E_LIVE=1 to run against the
# user's real Chrome instead (acceptance only; will prompt once per session).
e2e_isolated_setup() {
  [ -n "$E2E_LIVE" ] && return
  export XDG_RUNTIME_DIR="$(mktemp -d /tmp/cdp-e2e-runtime.XXXXXX)"
  export CDP_USER_DATA_DIR="$(mktemp -d /tmp/cdp-e2e-profile.XXXXXX)"
  local bin="${CDP_CHROME_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
  # E2E_HEADLESS=1: headless=new (no window). Needed for JS-dialog tests —
  # a windowed Chrome whose window never gets OS focus auto-suppresses
  # alert/confirm/prompt (auto-dismiss without freezing JS), so
  # Page.javascriptDialogOpening never fires.
  local headless=""
  [ -n "$E2E_HEADLESS" ] && headless="--headless=new"
  "$bin" $headless --remote-debugging-port=0 --user-data-dir="$CDP_USER_DATA_DIR"     --remote-allow-origins='*' --no-first-run --no-default-browser-check     --disable-background-networking about:blank >/dev/null 2>&1 &
  E2E_CHROME_PID=$!
  local f="$CDP_USER_DATA_DIR/DevToolsActivePort"
  for i in $(seq 1 60); do [ -f "$f" ] && break; sleep 0.25; done
  if [ ! -f "$f" ]; then echo "✖ isolated Chrome did not open a debug port"; exit 1; fi
  export CDP_PORT_FILE="$f"
  trap 'e2e_isolated_teardown' EXIT
}
e2e_isolated_teardown() {
  "$CDP" stop 2>/dev/null
  kill "$E2E_CHROME_PID" 2>/dev/null
  sleep 0.5
  rm -rf "$XDG_RUNTIME_DIR" "$CDP_USER_DATA_DIR" 2>/dev/null
}
