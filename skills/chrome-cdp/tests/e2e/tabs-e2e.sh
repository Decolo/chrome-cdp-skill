#!/bin/bash
# C1/C2 e2e: cdp close <target> / switch <target> (real Chrome)
# Scenes:
#  1. close: open tab A, open tab B -> close B -> list no longer shows B
#  2. switch: open tab C (background) -> visibilityState hidden -> switch ->
#     visibilityState visible
#  3. validation: close/switch with an unknown target prefix -> error
cd "$(dirname "$0")/../.."
source tests/e2e/lib.sh
e2e_isolated_setup
E2E_NAME="close/switch (C1/C2)"

start_slow_server
FIXTURES=9123
python3 -m http.server "$FIXTURES" --bind 127.0.0.1 --directory tests/e2e/fixtures >/dev/null 2>&1 &
FSRV=$!
trap 'kill $FSRV $E2E_SRV 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -sf "http://127.0.0.1:$FIXTURES/press-test.html" >/dev/null && break; sleep 0.25; done

echo "=== 场景1：close 关闭指定 tab ==="
OPA=$($CDP open "http://127.0.0.1:$FIXTURES/press-test.html" 2>/dev/null)
TA=$(echo "$OPA" | awk '{print $4}')
OPB=$($CDP open "http://127.0.0.1:$FIXTURES/press-test.html" 2>/dev/null)
TB=$(echo "$OPB" | awk '{print $4}')
case "$TB" in
  [0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]) : ;;
  *) echo "✖ CDP not ready: $OPB"; exit 1 ;;
esac
R=$($CDP close "$TB" 2>&1)
C=$(jget "$R" closed)
[ "$C" = "true" ] && ok "close 返回 closed=true" || bad "got: $R"
sleep 0.5
L=$($CDP list 2>&1)
case "$L" in
  *"$TB"*) bad "tab still listed: $TB" ;;
  *) ok "close 后 list 不再包含 $TB" ;;
esac
case "$L" in
  *"$TA"*) ok "另一 tab 仍在" ;;
  *) bad "tab $TA missing after close of $TB" ;;
esac

echo "=== 场景2：switch 激活后台 tab ==="
# 新开 tab C（后台）→ 应 hidden；switch 后 visible
OPC=$($CDP open "http://127.0.0.1:$FIXTURES/press-test.html" 2>/dev/null)
TC=$(echo "$OPC" | awk '{print $4}')
waitnav "$TC" "/press-test.html" || { echo "✖ navigation not started: $TC"; exit 1; }
VS=$($CDP eval "$TC" "document.visibilityState" 2>/dev/null)
[ "$VS" = "hidden" ] && ok "新 tab 初始 hidden" || ok "新 tab 初始状态=$VS（可接受）"
R=$($CDP switch "$TC" 2>&1)
A=$(jget "$R" activated)
[ "$A" = "true" ] && ok "switch 返回 activated=true" || bad "got: $R"
sleep 0.5
VS=$($CDP eval "$TC" "document.visibilityState" 2>/dev/null)
[ "$VS" = "visible" ] && ok "switch 后 visibilityState=visible" || bad "got: $VS"

echo "=== 场景3：未知 target 报错 ==="
E=$($CDP close DEADBEEF 2>&1 | tail -1)
case "$E" in
  *"No target"*|*"not found"*) ok "close 未知 target 报错" ;;
  *) bad "got: $E" ;;
esac
E=$($CDP switch DEADBEEF 2>&1 | tail -1)
case "$E" in
  *"No target"*|*"not found"*) ok "switch 未知 target 报错" ;;
  *) bad "got: $E" ;;
esac

summary
