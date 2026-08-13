#!/bin/bash
# A2 e2e: cdp wait <target> --load [--timeout ms]
# Scenes (real Chrome):
#  1. page with 3s-delayed <img> (readyState stays interactive) -> found=true,
#     waitedMs >= 2500, readyState=complete
#  2. already-loaded page -> found=true instantly
#  3. 8s-delayed <img> + 800ms timeout -> found=false, readyState != complete
#  4. argument validation: selector+--load, --load+--visible, no args
cd "$(dirname "$0")/../.."
source tests/e2e/lib.sh
E2E_NAME="wait --load (A2)"

start_slow_server

echo "=== 场景1：页面等待 img（3s 延迟）→ --load 等待 ==="
OP=$($CDP open "http://127.0.0.1:$E2E_PORT/slowimg" 2>/dev/null)
T=$(echo "$OP" | awk '{print $4}')
case "$T" in
  [0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]) : ;;
  *) echo "✖ CDP not ready: $OP"; exit 1 ;;
esac
waitnav "$T" "/slowimg" || { echo "✖ navigation not started: $T"; exit 1; }
S=$($CDP wait "$T" --load --timeout 6000 2>&1)
F=$(jget "$S" found); W=$(jget "$S" waitedMs); RS=$(jget "$S" readyState)
[ "$F" = "true" ] && [ "$W" -ge 2500 ] && [ "$RS" = "complete" ] && ok "found=true waitedMs=$W readyState=$RS" || bad "got: $S"

echo "=== 场景2：已加载页面 --load ==="
S=$($CDP wait "$T" --load --timeout 3000 2>&1)
F=$(jget "$S" found); W=$(jget "$S" waitedMs)
[ "$F" = "true" ] && [ "$W" -lt 500 ] && ok "found=true waitedMs=$W" || bad "got: $S"

echo "=== 场景3：img 8s 延迟 + 800ms 超时 ==="
OP=$($CDP open "http://127.0.0.1:$E2E_PORT/neverimg" 2>/dev/null)
T=$(echo "$OP" | awk '{print $4}')
case "$T" in
  [0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]) : ;;
  *) echo "✖ CDP not ready: $OP"; exit 1 ;;
esac
waitnav "$T" "/neverimg" || { echo "✖ navigation not started: $T"; exit 1; }
S=$($CDP wait "$T" --load --timeout 800 2>&1)
F=$(jget "$S" found); W=$(jget "$S" waitedMs); RS=$(jget "$S" readyState)
[ "$F" = "false" ] && [ "$W" -ge 700 ] && [ "$RS" != "complete" ] && ok "found=false waitedMs=$W readyState=$RS" || bad "got: $S"

echo "=== 场景4：参数互斥校验 ==="
E=$($CDP wait "$T" '#x' --load 2>&1 | tail -1)
case "$E" in
  *"cannot be combined"*) ok "selector+--load 报错" ;;
  *) bad "got: $E" ;;
esac
E=$($CDP wait "$T" --load --visible 2>&1 | tail -1)
case "$E" in
  *"--visible is only for element waits"*) ok "--load+--visible 报错" ;;
  *) bad "got: $E" ;;
esac
E=$($CDP wait "$T" 2>&1 | tail -1)
case "$E" in
  *"selector required"*) ok "无参数报错" ;;
  *) bad "got: $E" ;;
esac

summary
