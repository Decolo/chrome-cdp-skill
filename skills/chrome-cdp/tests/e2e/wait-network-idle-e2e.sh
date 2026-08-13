#!/bin/bash
# A3 e2e: cdp wait <target> --network-idle [--timeout ms] [--idle ms]
# Scenes (real Chrome):
#  1. /slowfetch (fetch 3s in flight, readyState already complete):
#     wait --load -> instant true; wait --network-idle -> waits ~3s
#     (the semantic difference between the two wait modes)
#  2. already-idle page -> instant true
#  3. /stream (never-ending request) + 800ms timeout -> found=false, inflight>0
#  4. argument validation: --network-idle+--load / +selector / +--visible
cd "$(dirname "$0")/../.."
source tests/e2e/lib.sh
E2E_NAME="wait --network-idle (A3)"

start_slow_server

echo "=== 场景1：fetch 在途（3s）→ --load 立即 true，--network-idle 等待 ==="
OP=$($CDP open "http://127.0.0.1:$E2E_PORT/slowfetch" 2>/dev/null)
T=$(echo "$OP" | awk '{print $4}')
case "$T" in
  [0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]) : ;;
  *) echo "✖ CDP not ready: $OP"; exit 1 ;;
esac
waitnav "$T" "/slowfetch" || { echo "✖ navigation not started: $T"; exit 1; }
S=$($CDP wait "$T" --load --timeout 3000 2>&1)
F=$(jget "$S" found); W=$(jget "$S" waitedMs)
[ "$F" = "true" ] && [ "$W" -lt 500 ] && ok "--load 立即 true (waitedMs=$W)" || bad "got: $S"
S=$($CDP wait "$T" --network-idle --timeout 6000 2>&1)
F=$(jget "$S" found); W=$(jget "$S" waitedMs); I=$(jget "$S" inflight)
[ "$F" = "true" ] && [ "$W" -ge 2500 ] && [ "$I" = "0" ] && ok "--network-idle 等待后 true (waitedMs=$W inflight=$I)" || bad "got: $S"

echo "=== 场景2：已 idle 页面 ==="
S=$($CDP wait "$T" --network-idle --timeout 3000 2>&1)
F=$(jget "$S" found); W=$(jget "$S" waitedMs)
[ "$F" = "true" ] && [ "$W" -lt 1000 ] && ok "立即 true (waitedMs=$W)" || bad "got: $S"

echo "=== 场景3：/streamfetch 长连接请求在飞 + 800ms 超时 ==="
OP=$($CDP open "http://127.0.0.1:$E2E_PORT/streamfetch" 2>/dev/null)
T=$(echo "$OP" | awk '{print $4}')
case "$T" in
  [0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]) : ;;
  *) echo "✖ CDP not ready: $OP"; exit 1 ;;
esac
waitnav "$T" "/streamfetch" || { echo "✖ navigation not started: $T"; exit 1; }
S=$($CDP wait "$T" --network-idle --timeout 800 2>&1)
F=$(jget "$S" found); W=$(jget "$S" waitedMs); I=$(jget "$S" inflight)
[ "$F" = "false" ] && [ "$W" -ge 700 ] && [ "$I" -ge 1 ] && ok "found=false waitedMs=$W inflight=$I" || bad "got: $S"

echo "=== 场景4：参数互斥校验 ==="
E=$($CDP wait "$T" --network-idle --load 2>&1 | tail -1)
case "$E" in
  *"mutually exclusive"*) ok "--network-idle+--load 报错" ;;
  *) bad "got: $E" ;;
esac
E=$($CDP wait "$T" '#x' --network-idle 2>&1 | tail -1)
case "$E" in
  *"cannot be combined"*) ok "--network-idle+selector 报错" ;;
  *) bad "got: $E" ;;
esac
E=$($CDP wait "$T" --network-idle --visible 2>&1 | tail -1)
case "$E" in
  *"--visible is only for element waits"*) ok "--network-idle+--visible 报错" ;;
  *) bad "got: $E" ;;
esac
E=$($CDP wait "$T" 2>&1 | tail -1)
case "$E" in
  *"selector required"*) ok "无参数报错" ;;
  *) bad "got: $E" ;;
esac

summary
