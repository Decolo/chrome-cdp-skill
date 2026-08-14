#!/bin/bash
# Batch-2 e2e: cdp fill / scroll / upload / ensure-real-tab
# Scenes:
#  1. fill: pre-filled input -> cleared + real key events + value set + input/change fired
#  2. fill --no-clear: existing value kept, text appended
#  3. fill --timeout: late-rendered input (1.5s) still fillable
#  4. scroll: --dy scrolls down (scrollTop>0); default dy=-300 scrolls back up
#  5. upload: file input receives the file (files[0].name)
#  6. ensure-real-tab: about:blank (internal) -> switches to first real tab;
#     real tab -> unchanged
#  7. validation: missing args error out
cd "$(dirname "$0")/../.."
source tests/e2e/lib.sh
e2e_isolated_setup
E2E_NAME="batch2 fill/scroll/upload/ensure-real-tab (E1-E4)"

FIXTURES=9123
python3 -m http.server "$FIXTURES" --bind 127.0.0.1 --directory tests/e2e/fixtures >/dev/null 2>&1 &
FSRV=$!
trap 'kill $FSRV 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -sf "http://127.0.0.1:$FIXTURES/batch2-test.html" >/dev/null && break; sleep 0.25; done
curl -sf "http://127.0.0.1:$FIXTURES/batch2-test.html" >/dev/null || { echo "✖ fixture server not ready"; exit 1; }

OP=$($CDP open "http://127.0.0.1:$FIXTURES/batch2-test.html" 2>/dev/null)
T=$(echo "$OP" | awk '{print $4}')
case "$T" in
  [0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]) : ;;
  *) echo "✖ CDP not ready: $OP"; exit 1 ;;
esac
waitnav "$T" "/batch2-test.html" || { echo "✖ navigation not started: $T"; exit 1; }

echo "=== 场景1：fill 清空 + 输入 + 事件 ==="
$CDP eval "$T" "window.__events.length=0; window.__keylog.length=0" >/dev/null 2>&1
R=$($CDP fill "$T" "#fill" "hello world" 2>&1)
C=$(jget "$R" chars)
[ "$C" = "11" ] && ok "fill 返回 chars=11" || bad "got: $R"
sleep 0.3
V=$($CDP eval "$T" "document.getElementById('fill').value" 2>/dev/null)
[ "$V" = "hello world" ] && ok "value = \"hello world\"（旧值已清）" || bad "got: $V"
E=$($CDP eval "$T" "JSON.stringify(window.__events)" 2>/dev/null)
case "$E" in
  *'"input"'*'"change"'*) ok "input+change 事件已触发 ($E)" ;;
  *) bad "events: $E" ;;
esac
K=$($CDP eval "$T" "JSON.stringify(window.__keylog.join(''))" 2>/dev/null)
case "$K" in
  *"hello world"*) ok "真实键事件逐字符到达 (…$K…)" ;;
  *) bad "keylog: $K" ;;
esac

echo "=== 场景2：--no-clear 保留旧值 ==="
$CDP eval "$T" "document.getElementById('fill').value='OLD'" >/dev/null 2>&1
R=$($CDP fill "$T" "#fill" "z" --no-clear 2>&1)
sleep 0.3
V=$($CDP eval "$T" "document.getElementById('fill').value" 2>/dev/null)
case "$V" in
  OLD*z) ok "no-clear: 旧值保留且追加 ($V)" ;;
  *) bad "got: $V" ;;
esac

echo "=== 场景3：--timeout 等待晚渲染元素 ==="
R=$($CDP fill "$T" "#late-input" "hi" --timeout 5000 2>&1)
sleep 0.3
V=$($CDP eval "$T" "document.getElementById('late-input').value" 2>/dev/null)
[ "$V" = "hi" ] && ok "晚渲染 input 填充成功 ($V)" || bad "got: $V"

echo "=== 场景4：scroll 滚动 ==="
$CDP eval "$T" "document.getElementById('scroller').scrollTop=0" >/dev/null 2>&1
R=$($CDP scroll "$T" 100 100 --dy 200 2>&1)
D=$(jget "$R" deltaY)
[ "$D" = "200" ] && ok "scroll 返回 deltaY=200" || bad "got: $R"
sleep 0.3
ST=$($CDP eval "$T" "document.getElementById('scroller').scrollTop" 2>/dev/null)
[ "$ST" -gt 0 ] 2>/dev/null && ok "滚动后 scrollTop>0 ($ST)" || bad "scrollTop: $ST"
R=$($CDP scroll "$T" 100 100 2>&1)   # default dy=-300
sleep 0.3
ST2=$($CDP eval "$T" "document.getElementById('scroller').scrollTop" 2>/dev/null)
[ "$ST2" -lt "$ST" ] 2>/dev/null && ok "默认 dy=-300 回滚 (${ST}->${ST2})" || bad "got: $ST2 (was $ST)"

echo "=== 场景5：upload 设置文件 ==="
TMPF=$(mktemp /tmp/cdp-upload.XXXXXX.txt)
echo "file content" > "$TMPF"
R=$($CDP upload "$T" "#file" "$TMPF" 2>&1)
sleep 0.3
N=$($CDP eval "$T" "document.getElementById('file').files.length" 2>/dev/null)
FN=$($CDP eval "$T" "document.getElementById('file').files[0].name" 2>/dev/null)
[ "$N" = "1" ] && [ "$FN" = "$(basename "$TMPF")" ] && ok "files[0].name = $(basename "$TMPF")" || bad "got files=$N name=$FN"
rm -f "$TMPF"

echo "=== 场景6：ensure-real-tab ==="
OB=$($CDP open 2>/dev/null)   # about:blank（内部页）
TB=$(echo "$OB" | awk '{print $4}')
R=$($CDP ensure-real-tab "$TB" 2>&1)
SW=$(jget "$R" switched)
NID=$(jget "$R" targetId)
case "$R" in
  *"127.0.0.1"*) ok "内部页 -> 切到真实 tab (switched=$SW)" ;;
  *) bad "got: $R" ;;
esac
case "$NID" in
  "$T"*) ok "切到的就是第一个真实 tab ($NID)" ;;
  *) bad "targetId: $NID (want prefix $T)" ;;
esac
R=$($CDP ensure-real-tab "$T" 2>&1)
SW=$(jget "$R" switched)
[ "$SW" = "false" ] && ok "真实 tab 原样返回 (switched=false)" || bad "got: $R"

echo "=== 场景7：参数校验 ==="
E=$($CDP fill "$T" 2>&1 | tail -1)
case "$E" in
  *selector*|*required*) ok "fill 缺 selector 报错" ;;
  *) bad "got: $E" ;;
esac
E=$($CDP scroll "$T" 100 2>&1 | tail -1)
case "$E" in
  *[Yy]*|*required*) ok "scroll 缺 y 报错" ;;
  *) bad "got: $E" ;;
esac
E=$($CDP upload "$T" "#file" 2>&1 | tail -1)
case "$E" in
  *[Pp]ath*|*required*) ok "upload 缺 path 报错" ;;
  *) bad "got: $E" ;;
esac

summary
