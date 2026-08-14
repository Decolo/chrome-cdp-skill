#!/bin/bash
# H1-H4 e2e: dialogs / cookies / pdf (L2 command layer)
# Scenes:
#  1. alert: click -> cdp dialog shows pending {type,message}; page commands
#     are blocked with a hint; accept -> page unblocks
#  2. confirm: dismiss
#  3. prompt: accept with --prompt-text; page sees the returned value
#  4. cookies: list (eval-set), set, read back via eval, delete
#  5. cookies: save to file -> mutate -> load restores
#  6. pdf: printToPDF produces a real PDF file
cd "$(dirname "$0")/../.."
source tests/e2e/lib.sh
export E2E_HEADLESS=1
e2e_isolated_setup
E2E_NAME="dialogs/cookies/pdf (H1-H3)"

FIXTURES=9123
python3 -m http.server "$FIXTURES" --bind 127.0.0.1 --directory tests/e2e/fixtures >/dev/null 2>&1 &
FSRV=$!
trap 'kill $FSRV $E2E_SRV 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -sf "http://127.0.0.1:$FIXTURES/dialogs-test.html" >/dev/null && break; sleep 0.25; done

echo "=== 场景1：alert 检测 + accept ==="
OP=$($CDP open "http://127.0.0.1:$FIXTURES/dialogs-test.html" 2>/dev/null)
T=$(echo "$OP" | awk '{print $4}')
# headless: no window, no dialog suppression — alert really opens and
# freezes the page JS.
$CDP click "$T" "#alert-btn" >/dev/null 2>&1
sleep 0.5
D=$($CDP dialog 2>&1)
case "$D" in
  *'"type":"alert"'*'"message":"hello alert"'*) ok "dialog 检测到 alert + message" ;;
  *) bad "got: $D" ;;
esac
E=$($CDP eval "$T" "1+1" 2>&1 | tail -1)
case "$E" in
  *"pending dialog"*) ok "弹窗挂起时页面命令被阻塞并提示" ;;
  *) bad "got: $E" ;;
esac
R=$($CDP dialog accept 2>&1)
[ "$(jget "$R" handled)" = "true" ] && ok "dialog accept 返回 handled=true" || bad "got: $R"
sleep 0.3
V=$($CDP eval "$T" "1+1" 2>/dev/null)
[ "$V" = "2" ] && ok "accept 后页面命令恢复" || bad "got: $V"

echo "=== 场景2：confirm dismiss ==="
$CDP click "$T" "#confirm-btn" >/dev/null 2>&1
sleep 0.5
D=$($CDP dialog 2>&1)
case "$D" in
  *'"type":"confirm"'*) ok "dialog 检测到 confirm" ;;
  *) bad "got: $D" ;;
esac
$CDP dialog dismiss >/dev/null 2>&1
sleep 0.3
S=$($CDP eval "$T" "document.getElementById('status').textContent" 2>/dev/null)
[ "$S" = "confirm:false" ] && ok "dismiss 后 confirm 返回 false" || bad "got: $S"

echo "=== 场景3：prompt accept 带文本 ==="
$CDP click "$T" "#prompt-btn" >/dev/null 2>&1
sleep 0.5
$CDP dialog accept --prompt-text "Bob" >/dev/null 2>&1
sleep 0.3
S=$($CDP eval "$T" "document.getElementById('status').textContent" 2>/dev/null)
[ "$S" = "prompt:Bob" ] && ok "prompt 返回 Bob" || bad "got: $S"
D=$($CDP dialog 2>&1)
[ "$(jget "$D" dialog)" = "null" ] && ok "处理后 dialog 状态为空" || bad "got: $D"

echo "=== 场景4：cookies 列出 / set / 读回 / delete ==="
$CDP eval "$T" "document.cookie='a=1; path=/'" >/dev/null 2>&1
sleep 0.3
C=$($CDP cookies 2>&1)
case "$C" in
  *'"name":"a"'*) ok "cookies 列出 eval 设置的 a" ;;
  *) bad "got: ${C:0:120}" ;;
esac
$CDP cookie set b 2 --domain 127.0.0.1 >/dev/null 2>&1
sleep 0.3
V=$($CDP eval "$T" "document.cookie" 2>/dev/null)
case "$V" in
  *"b=2"*) ok "cookie set 后页面读到 b=2" ;;
  *) bad "got: $V" ;;
esac
$CDP cookie delete a --domain 127.0.0.1 >/dev/null 2>&1
sleep 0.3
V=$($CDP eval "$T" "document.cookie" 2>/dev/null)
case "$V" in
  *"a=1"*) bad "delete 后 a 仍在: $V" ;;
  *) ok "cookie delete 后 a 消失" ;;
esac

echo "=== 场景5：cookies save / load ==="
CF=$(mktemp /tmp/cdp-cookies.XXXXXX.json)
$CDP cookies --save "$CF" >/dev/null 2>&1
$CDP cookie delete b --domain 127.0.0.1 >/dev/null 2>&1
sleep 0.3
V=$($CDP eval "$T" "document.cookie" 2>/dev/null)
case "$V" in
  *"b=2"*) bad "删除 b 后仍在: $V" ;;
  *) ok "删除 b 后消失" ;;
esac
$CDP cookies --load "$CF" >/dev/null 2>&1
sleep 0.3
V=$($CDP eval "$T" "document.cookie" 2>/dev/null)
case "$V" in
  *"b=2"*) ok "--load 恢复 b=2" ;;
  *) bad "got: $V" ;;
esac
rm -f "$CF"

echo "=== 场景6：pdf 生成 ==="
P=$(mktemp /tmp/cdp-pdf.XXXXXX.pdf)
R=$($CDP pdf "$T" "$P" 2>&1)
[ "$(jget "$R" file)" = "$P" ] && ok "pdf 返回 file 路径" || bad "got: $R"
head -c 5 "$P" | grep -q "%PDF" && ok "PDF 文件头正确" || bad "not a PDF: $(head -c 20 "$P")"
SZ=$(stat -f%z "$P")
[ "$SZ" -gt 1000 ] && ok "PDF 大小合理 ($SZ B)" || bad "PDF 太小: $SZ B"
rm -f "$P"

echo "=== 场景7：参数校验 ==="
E=$($CDP dialog frobnicate 2>&1 | tail -1)
case "$E" in
  *"accept|dismiss"*) ok "dialog 未知动作报错" ;;
  *) bad "got: $E" ;;
esac
E=$($CDP cookie set x 1 2>&1 | tail -1)
case "$E" in
  *"--domain"*) ok "cookie set 缺 domain 报错" ;;
  *) bad "got: $E" ;;
esac

summary
