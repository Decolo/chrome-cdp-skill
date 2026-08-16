#!/bin/bash
# Review-fix regression (7th batch): H1/H2/H3 + M3/M4 e2e
# Scenes:
#  1. H1: dialog detected on a tab that was NOT opened via `cdp open`
#     (created via CDP Target.createTarget -> level-2 auto-attach path,
#     which previously missed Page.enable)
#  2. H2: wait --network-idle tracks requests that START during the wait
#     (the old throwaway-tracker fallback returned idle instantly)
#  3. H3: nav waits only for ITS OWN session's load event (a concurrent
#     navigation in another tab must not complete it)
#  4. M3: loadall rejects a non-numeric interval instead of tight-looping
#  5. M4: a pure-hex ARGUMENT is not swallowed as a target prefix when the
#     session has a current tab
cd "$(dirname "$0")/../.."
source tests/e2e/lib.sh
export E2E_HEADLESS=1
e2e_isolated_setup
E2E_NAME="review fixes (H1-H3, M3, M4)"

FIXTURES=9123
python3 -m http.server "$FIXTURES" --bind 127.0.0.1 --directory tests/e2e/fixtures >/dev/null 2>&1 &
FSRV=$!
start_slow_server
trap 'kill $FSRV $E2E_SRV 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -sf "http://127.0.0.1:$FIXTURES/dialogs-test.html" >/dev/null && break; sleep 0.25; done

echo "=== 场景1：H1 — 非 open 创建的 tab 上 dialog 检测 ==="
OP=$($CDP open "http://127.0.0.1:$FIXTURES/dialogs-test.html" 2>/dev/null)
T=$(echo "$OP" | awk '{print $4}')
# 用 CDP Target.createTarget 另开一 tab（不走 cdp open → level-2 auto-attach）
B=$($CDP evalraw "$T" "Target.createTarget" '{"url":"http://127.0.0.1:9123/dialogs-test.html"}' 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['targetId'])")
[ -n "$B" ] && ok "createTarget 创建了 tab B ($(echo $B | head -c 8))" || bad "createTarget 失败"
sleep 0.5
$CDP eval "$B" "document.getElementById('alert-btn').click()" >/dev/null 2>&1
sleep 0.5
D=$($CDP dialog 2>&1)
case "$D" in
  *'"type":"alert"'*) ok "auto-attach tab 的 dialog 被检测到" ;;
  *) bad "got: $D" ;;
esac
E=$($CDP eval "$B" "1+1" 2>&1 | tail -1)
case "$E" in
  *"pending dialog"*) ok "auto-attach tab 弹窗挂起时命令被阻塞" ;;
  *) bad "got: $E" ;;
esac
$CDP dialog accept >/dev/null 2>&1

echo "=== 场景2：H2 — wait --network-idle 跟踪 wait 期间发起的请求 ==="
Z=$($CDP open "about:blank" 2>/dev/null | awk '{print $4}')
# fetch 请求在 eval 返回后发出；wait 开始时该 session 无 tracker
# 导航在 wait 开始后 50ms 发出（< idle 300ms 阈值）：wait 开始时 session
# 无 tracker（fallback 路径；about:blank 加载不产生网络事件）。修复前：
# throwaway tracker 冻结，导航请求被忽略，300ms 就返回 idle（错）。修复后：
# fallback 存入 map，导航被跟踪，等到 slowfetch 页的 3s fetch 完成才返回。
# （用 location.href 顶层导航而非 fetch：about:blank 的 opaque origin 会让
# fetch 被浏览器直接拦截，根本不发网络请求。）
$CDP eval "$Z" "setTimeout(()=>location.href='http://127.0.0.1:$E2E_PORT/slowfetch', 50)" >/dev/null 2>&1
S=$($CDP wait "$Z" --network-idle --timeout 10000 --idle 300 2>&1)
F=$(jget "$S" found); W=$(jget "$S" waitedMs)
[ "$F" = "true" ] && [ "$W" -ge 2500 ] && ok "wait 等到 wait 期间发起的导航 (waitedMs=$W)" || bad "got: $S"

echo "=== 场景3：H3 — nav 只等自己的 load 事件 ==="
A=$($CDP open "http://127.0.0.1:$E2E_PORT/slowimg" 2>/dev/null | awk '{print $4}')
B2=$($CDP open "http://127.0.0.1:$FIXTURES/dialogs-test.html" 2>/dev/null | awk '{print $4}')
NAV_START=$(python3 -c "import time; print(int(time.time()*1000))")
$CDP nav "$A" "http://127.0.0.1:$E2E_PORT/slowimg" >/dev/null 2>&1 &
NAV_PID=$!
sleep 0.8
# B 快速导航（若 H3 未修，B 的 load 事件会提前完成 A 的 nav）
$CDP nav "$B2" "http://127.0.0.1:$FIXTURES/dialogs-test.html" >/dev/null 2>&1
wait $NAV_PID
NAV_MS=$(python3 -c "import time; print(int(time.time()*1000) - $NAV_START)")
[ "$NAV_MS" -ge 2000 ] && ok "A 的 nav 等待自己的 load (${NAV_MS}ms)" || bad "A 的 nav 被其他 tab 误完成 (${NAV_MS}ms)"

echo "=== 场景4：M3 — loadall 拒绝非法 interval ==="
E=$($CDP loadall "$T" "#nope" abc 2>&1 | tail -1)
case "$E" in
  *"invalid interval"*) ok "loadall 非法 interval 报错" ;;
  *) bad "got: $E" ;;
esac

echo "=== 场景5：M4 — 纯 hex 参数不被吞成 target ==="
$CDP switch "$T" >/dev/null 2>&1
V=$($CDP eval "1+1" 2>/dev/null)
[ "$V" = "2" ] && ok "省略 target 的 eval 正常" || bad "got: $V"
# hex 参数 + 有 current tab：应作为表达式求值而非 target
R=$($CDP eval "0x10+1" 2>&1 | tail -1)
case "$R" in
  *"No target"*) bad "hex 表达式被当 target: $R" ;;
  17) ok "hex 表达式求值成功 (17)" ;;
  *) ok "hex 参数被当参数处理: $R" ;;
esac

echo "=== 场景6：M9 — 双 tab 弹窗互不覆盖 ==="
# tab B 弹 alert（挂起）→ 另一 tab C 也弹 → 各自 tab 的命令仍被阻塞提示
C=$($CDP open "http://127.0.0.1:$FIXTURES/dialogs-test.html" 2>/dev/null | awk '{print $4}')
$CDP eval "$B" "document.getElementById('alert-btn').click()" >/dev/null 2>&1
sleep 0.5
$CDP eval "$C" "document.getElementById('confirm-btn').click()" >/dev/null 2>&1
sleep 0.5
EB=$($CDP eval "$B" "1+1" 2>&1 | tail -1)
EC=$($CDP eval "$C" "1+1" 2>&1 | tail -1)
case "$EB" in
  *"pending dialog"*) ok "tab B 命令被自己的弹窗阻塞" ;;
  *) bad "B 未阻塞: $EB" ;;
esac
case "$EC" in
  *"pending dialog"*) ok "tab C 命令被自己的弹窗阻塞" ;;
  *) bad "C 未阻塞: $EC" ;;
esac
# dialog accept 优先 session 当前 tab（C）→ C 恢复；B 的弹窗仍在
$CDP dialog accept >/dev/null 2>&1
sleep 0.3
VC=$($CDP eval "$C" "1+1" 2>/dev/null)
[ "$VC" = "2" ] && ok "current tab (C) 的弹窗被 accept 处理" || bad "C 未恢复: $VC"
EB2=$($CDP eval "$B" "1+1" 2>&1 | tail -1)
case "$EB2" in
  *"pending dialog"*) ok "B 的弹窗仍挂起（未被误处理）" ;;
  *) bad "B 弹窗被误处理: $EB2" ;;
esac
# 再处理 B 的 alert → 全部清空
$CDP dialog dismiss >/dev/null 2>&1
sleep 0.3
VB=$($CDP eval "$B" "1+1" 2>/dev/null)
[ "$VB" = "2" ] && ok "B 处理后恢复" || bad "B 未恢复: $VB"
D=$($CDP dialog 2>&1)
[ "$(jget "$D" dialog)" = "null" ] && ok "全部弹窗处理后状态为空" || bad "got: $D"

summary
