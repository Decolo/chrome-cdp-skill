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
