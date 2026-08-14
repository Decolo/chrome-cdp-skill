#!/bin/bash
# A1 e2e: cdp wait <target> <selector> [--timeout ms] [--visible]
# Scenes (real Chrome):
#  1. existing element -> found=true, instant
#  2. element created after 3s -> found=true, waitedMs ~ 3000 - lead time
#  3. missing element + 800ms timeout -> found=false
#  4. display:none element --visible -> false; after show -> true
cd "$(dirname "$0")/../.."
source tests/e2e/lib.sh
e2e_isolated_setup
E2E_NAME="wait (A1)"

FIXTURE_PORT=9123
# Preflight 1: fixture port must really serve the test page (a leftover
# process on the port returns some other response -> false failures).
if ! curl -s -m 2 "http://127.0.0.1:$FIXTURE_PORT/wait-test.html" | grep -q "already-here"; then
  python3 -m http.server "$FIXTURE_PORT" --bind 127.0.0.1 --directory tests/e2e/fixtures >/dev/null 2>&1 &
  FIX_SRV=$!
  trap 'kill $FIX_SRV 2>/dev/null' EXIT
  sleep 1
  curl -s -m 2 "http://127.0.0.1:$FIXTURE_PORT/wait-test.html" | grep -q "already-here" \
    || { echo "✖ fixture page unreachable"; exit 1; }
fi

# Preflight 2: CDP must be live (open falls back to AppleScript -> T=system)
OP=$($CDP open "http://127.0.0.1:$FIXTURE_PORT/wait-test.html" 2>/dev/null)
T=$(echo "$OP" | awk '{print $4}')
case "$T" in
  [0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]) : ;;
  *) echo "✖ CDP not ready: $OP"; exit 1 ;;
esac

echo "  target=$T"
echo "  --- page state probe ---"
$CDP eval "$T" "document.title + ' | late=' + (document.getElementById('late') ? 'YES' : 'no') + ' | hidden=' + (document.getElementById('hidden') ? 'YES' : 'no')" 2>&1 | tail -1

echo "=== 场景1：已存在元素 ==="
S=$($CDP wait "$T" '#already-here' 2>&1)
F=$(jget "$S" found); W=$(jget "$S" waitedMs)
[ "$F" = "true" ] && [ "$W" -lt 1000 ] && ok "found=true waitedMs=$W" || bad "got: $S"

echo "=== 场景2：延时渲染（3s 后出现）==="
S=$($CDP wait "$T" '#late' --timeout 6000 2>&1)
F=$(jget "$S" found); W=$(jget "$S" waitedMs)
[ "$F" = "true" ] && [ "$W" -ge 2000 ] && [ "$W" -lt 5000 ] && ok "found=true waitedMs=$W" || bad "got: $S"

echo "=== 场景3：不存在元素 + 800ms 超时 ==="
S=$($CDP wait "$T" '#nope' --timeout 800 2>&1)
F=$(jget "$S" found); W=$(jget "$S" waitedMs)
[ "$F" = "false" ] && ok "found=false waitedMs=$W" || bad "got: $S"

echo "=== 场景4：display:none + --visible ==="
S=$($CDP wait "$T" '#hidden' --visible --timeout 800 2>&1)
F=$(jget "$S" found)
[ "$F" = "false" ] && ok "hidden 元素 visible=false" || bad "got: $S"
$CDP eval "$T" "document.getElementById('hidden').style.display='block'" >/dev/null 2>&1
S=$($CDP wait "$T" '#hidden' --visible --timeout 3000 2>&1)
F=$(jget "$S" found)
[ "$F" = "true" ] && ok "可见后 visible=true" || bad "got: $S"

summary
