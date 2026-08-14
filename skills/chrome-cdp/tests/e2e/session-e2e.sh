#!/bin/bash
# F1-F5 e2e: session 维度当前 tab（current / switch 持久 / 无 target 命令）
# Scenes:
#  1. no current tab -> omitted-target commands fail with a clear hint
#  2. open/switch set the session's current tab; omitted-target eval hits it
#  3. session isolation (--session A vs default) + env CDP_SESSION + --session=X
#  4. list marks the session's current tab
#  5. close current tab -> session invalid -> re-switch recovers
#  6. targetDestroyed: closing a tab invalidates every session pointing at it
#  7. explicit-target commands unchanged (incl. bad prefix still errors)
#  8. wait --load / ensure-real-tab without target act on the current tab
#  9. --session without a value errors
cd "$(dirname "$0")/../.."
source tests/e2e/lib.sh
e2e_isolated_setup
E2E_NAME="session current-tab (F1-F5)"

FIXTURES=9123
python3 -m http.server "$FIXTURES" --bind 127.0.0.1 --directory tests/e2e/fixtures >/dev/null 2>&1 &
FSRV=$!
trap 'kill $FSRV $E2E_SRV 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -sf "http://127.0.0.1:$FIXTURES/press-test.html" >/dev/null && break; sleep 0.25; done

echo "=== 场景1：无当前 tab 时省略 target 报错 ==="
E=$($CDP eval "1+1" 2>&1 | tail -1)
case "$E" in
  *"no current tab"*) ok "eval 省略 target 无当前 tab 报错提示" ;;
  *) bad "got: $E" ;;
esac
E=$($CDP current 2>&1 | tail -1)
case "$E" in
  *"no current tab"*) ok "current 无当前 tab 报错提示" ;;
  *) bad "got: $E" ;;
esac

echo "=== 场景2：open 设置当前 tab，省略 target 命令生效 ==="
OPA=$($CDP open "http://127.0.0.1:$FIXTURES/press-test.html" 2>/dev/null)
TA=$(echo "$OPA" | awk '{print $4}')
C=$($CDP current 2>&1)
case "$(echo "$C" | node -e "const d=JSON.parse(require('fs').readFileSync(0));console.log(d.targetId)")" in
  "$TA"*) ok "open 后 default 当前 tab = TA" ;;
  *) bad "got: $C" ;;
esac
T=$($CDP eval "document.title" 2>/dev/null)
[ "$T" = "press-test" ] && ok "eval 省略 target 作用于当前 tab" || bad "got: $T"
R=$($CDP wait --load 2>&1)
[ "$(jget "$R" found)" = "true" ] && ok "wait --load 省略 target 作用于当前 tab" || bad "got: $R"
R=$($CDP ensure-real-tab 2>&1)
[ "$(jget "$R" switched)" = "false" ] && ok "ensure-real-tab 省略 target 作用于当前 tab" || bad "got: $R"

echo "=== 场景3：多 session 隔离 ==="
OPB=$($CDP open "http://127.0.0.1:$FIXTURES/batch2-test.html" --session A 2>/dev/null)
TB=$(echo "$OPB" | awk '{print $4}')
C=$($CDP current --session A 2>&1)
case "$(echo "$C" | node -e "const d=JSON.parse(require('fs').readFileSync(0));console.log(d.targetId)")" in
  "$TB"*) ok "session A 当前 tab = TB" ;;
  *) bad "got: $C" ;;
esac
C=$($CDP current 2>&1)
case "$(echo "$C" | node -e "const d=JSON.parse(require('fs').readFileSync(0));console.log(d.targetId)")" in
  "$TA"*) ok "default 仍 = TA（隔离互不干扰）" ;;
  *) bad "got: $C" ;;
esac
C=$(CDP_SESSION=A $CDP current 2>&1)
case "$(echo "$C" | node -e "const d=JSON.parse(require('fs').readFileSync(0));console.log(d.targetId)")" in
  "$TB"*) ok "env CDP_SESSION=A 生效" ;;
  *) bad "got: $C" ;;
esac
C=$($CDP current --session=A 2>&1)
case "$(echo "$C" | node -e "const d=JSON.parse(require('fs').readFileSync(0));console.log(d.targetId)")" in
  "$TB"*) ok "--session=X 语法生效" ;;
  *) bad "got: $C" ;;
esac
U=$($CDP eval "location.pathname" --session A 2>/dev/null)
case "$U" in *batch2-test.html*) ok "eval 省略 target 作用于 session A 的 tab" ;; *) bad "got: $U" ;; esac

echo "=== 场景4：list 标记当前 tab ==="
L=$($CDP list --session A 2>&1)
case "$L" in
  *"$TB"*"*"*) ok "list 用 * 标出 session A 当前 tab" ;;
  *) bad "got: $L" ;;
esac

echo "=== 场景5：close 当前 tab -> 失效 -> 重新 switch 恢复 ==="
R=$($CDP close --session A 2>&1)
[ "$(jget "$R" closed)" = "true" ] && ok "close 省略 target 关闭当前 tab" || bad "got: $R"
sleep 0.5
E=$($CDP current --session A 2>&1 | tail -1)
case "$E" in
  *"no current tab"*|*"gone"*) ok "close 后 session A 失效" ;;
  *) bad "got: $E" ;;
esac
$CDP switch "$TA" --session A >/dev/null 2>&1
C=$($CDP current --session A 2>&1)
case "$(echo "$C" | node -e "const d=JSON.parse(require('fs').readFileSync(0));console.log(d.targetId)")" in
  "$TA"*) ok "重新 switch 恢复 session A" ;;
  *) bad "got: $C" ;;
esac

echo "=== 场景6：targetDestroyed 跨 session 清理 ==="
OPC=$($CDP open "http://127.0.0.1:$FIXTURES/press-test.html" --session B 2>/dev/null)
TC=$(echo "$OPC" | awk '{print $4}')
$CDP close "$TC" >/dev/null 2>&1
sleep 0.5
E=$($CDP current --session B 2>&1 | tail -1)
case "$E" in
  *"no current tab"*|*"gone"*) ok "B 的当前 tab 被显式 close 后失效（清理）" ;;
  *) bad "got: $E" ;;
esac

echo "=== 场景7：显式 target 兼容 ==="
T=$($CDP eval "$TA" "1+1" 2>/dev/null)
[ "$T" = "2" ] && ok "设了 session 后显式 target 照常" || bad "got: $T"
E=$($CDP eval DEADBEEF "1+1" 2>&1 | tail -1)
case "$E" in
  *"No target"*|*"not found"*) ok "打错 target 前缀（2 参数）仍报错" ;;
  *) bad "got: $E" ;;
esac

echo "=== 场景8：--session 缺值报错 ==="
E=$($CDP eval "1+1" --session 2>&1 | tail -1)
case "$E" in
  *"requires a value"*) ok "--session 缺值报错" ;;
  *) bad "got: $E" ;;
esac

summary
