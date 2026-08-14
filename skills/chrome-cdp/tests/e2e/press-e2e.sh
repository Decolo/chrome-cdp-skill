#!/bin/bash
# B1 e2e: cdp press <target> <key> [--ctrl|--shift|--alt|--meta]
# Scenes (real Chrome, press-test.html):
#  1. char input: autofocus input#a -> press h, press i -> value "hi"
#  2. Enter submits the form (onsubmit sets document.title='submitted')
#  3. Tab moves focus: press Tab then "x" -> input#b got the char
#  4. modifier combo: press "a" --ctrl -> keydown record "a+ctrl"
#  5. validation: unknown key / missing key errors
cd "$(dirname "$0")/../.."
source tests/e2e/lib.sh
E2E_NAME="press (B1)"

start_slow_server
FIXTURES=9123

# fixture server (plain http.server on 9123)
python3 -m http.server "$FIXTURES" --bind 127.0.0.1 --directory tests/e2e/fixtures >/dev/null 2>&1 &
FSRV=$!
trap 'kill $FSRV $E2E_SRV 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -sf "http://127.0.0.1:$FIXTURES/press-test.html" >/dev/null && break; sleep 0.25; done
curl -sf "http://127.0.0.1:$FIXTURES/press-test.html" >/dev/null || { echo "✖ fixture server not ready"; exit 1; }

echo "=== 场景1：字符输入（autofocus 在 input#a）==="
OP=$($CDP open "http://127.0.0.1:$FIXTURES/press-test.html" 2>/dev/null)
T=$(echo "$OP" | awk '{print $4}')
case "$T" in
  [0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]) : ;;
  *) echo "✖ CDP not ready: $OP"; exit 1 ;;
esac
waitnav "$T" "/press-test.html" || { echo "✖ navigation not started: $T"; exit 1; }
# focus is the user's click in real usage; the tab is background so autofocus is skipped
$CDP eval "$T" "document.getElementById('a').focus()" >/dev/null 2>&1
$CDP press "$T" h >/dev/null 2>&1
$CDP press "$T" i >/dev/null 2>&1
sleep 0.3
V=$($CDP eval "$T" "document.getElementById('a').value" 2>/dev/null)
[ "$V" = "hi" ] && ok "input#a value = \"hi\"" || bad "got: $V"

echo "=== 场景2：Enter 提交表单 ==="
$CDP press "$T" Enter >/dev/null 2>&1
sleep 0.3
TT=$($CDP eval "$T" "document.title" 2>/dev/null)
[ "$TT" = "submitted" ] && ok "form submitted (title=submitted)" || bad "got title: $TT"

echo "=== 场景3：Tab 移动焦点到 input#b ==="
$CDP press "$T" x >/dev/null 2>&1   # before Tab: goes into #a
$CDP press "$T" Tab >/dev/null 2>&1
$CDP press "$T" y >/dev/null 2>&1   # after Tab: goes into #b
sleep 0.3
A=$($CDP eval "$T" "document.getElementById('a').value" 2>/dev/null)
B=$($CDP eval "$T" "document.getElementById('b').value" 2>/dev/null)
[ "$A" = "hix" ] && [ "$B" = "y" ] && ok "focus moved: a=\"$A\" b=\"$B\"" || bad "got a=$A b=$B"

echo "=== 场景4：修饰键组合（Ctrl+A）==="
$CDP press "$T" a --ctrl >/dev/null 2>&1
sleep 0.3
K=$($CDP eval "$T" "window.__keys[window.__keys.length-1]" 2>/dev/null)
[ "$K" = "a+ctrl" ] && ok "keydown record = \"a+ctrl\"" || bad "got: $K"

echo "=== 场景5：参数校验 ==="
E=$($CDP press "$T" 2>&1 | tail -1)
case "$E" in
  *"key required"*) ok "缺 key 报错" ;;
  *) bad "got: $E" ;;
esac
E=$($CDP press "$T" Frobnicate 2>&1 | tail -1)
case "$E" in
  *"unsupported key"*) ok "未知键报错" ;;
  *) bad "got: $E" ;;
esac

summary
