#!/bin/bash
# G1-G5 e2e: 跨域 iframe 支持（iframe / BH iframe_target 对齐）
# Scenes:
#  1. cdp iframe lists every iframe target
#  2. cdp iframe <url-substr> resolves the matching iframe target
#  3. eval on an iframe target runs in the iframe's own context (title/hostname)
#  4. click inside the iframe target works (button sets a marker)
#  5. host-page eval cannot reach the cross-origin iframe (OOPIF isolation proof)
#  6. no matching substring -> clear error
cd "$(dirname "$0")/../.."
source tests/e2e/lib.sh
e2e_isolated_setup
E2E_NAME="cross-origin iframe (G1-G5)"

FIXTURES=9123
python3 -m http.server "$FIXTURES" --bind 127.0.0.1 --directory tests/e2e/fixtures >/dev/null 2>&1 &
FSRV=$!
python3 -m http.server 9124 --bind 127.0.0.1 --directory tests/e2e/fixtures >/dev/null 2>&1 &
FSRV2=$!
trap 'kill $FSRV $FSRV2 $E2E_SRV 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -sf "http://127.0.0.1:$FIXTURES/iframe-host.html" >/dev/null && curl -sf "http://127.0.0.1:9124/iframe-child.html" >/dev/null && break; sleep 0.25; done

echo "=== 场景1：列出 iframe ==="
OP=$($CDP open "http://127.0.0.1:$FIXTURES/iframe-host.html" 2>/dev/null)
TH=$(echo "$OP" | awk '{print $4}')
for i in $(seq 1 25); do
  L=$($CDP iframe 2>&1)
  case "$L" in *iframe-child.html*) break;; esac
  sleep 0.3
done
case "$L" in
  *iframe-child.html*) ok "iframe 列表包含 child" ;;
  *) bad "got: $L" ;;
esac

echo "=== 场景2：url-substr 解析 ==="
R=$($CDP iframe child 2>&1)
TI=$(echo "$R" | awk '{print $2}')
case "$TI" in
  [0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]) ok "解析出 iframe targetId: $TI" ;;
  *) bad "got: $R" ;;
esac

echo "=== 场景3：iframe 内 eval（独立上下文）==="
T=$($CDP eval "$TI" "document.title" 2>/dev/null)
[ "$T" = "iframe-child" ] && ok "iframe 内 title = iframe-child" || bad "got: $T"
H=$($CDP eval "$TI" "location.hostname" 2>/dev/null)
[ "$H" = "localhost" ] && ok "iframe 内 hostname = localhost（跨域上下文）" || bad "got: $H"

echo "=== 场景4：iframe 内 click ==="
$CDP click "$TI" "#btn" >/dev/null 2>&1
sleep 0.3
C=$($CDP eval "$TI" "window.__clicked" 2>/dev/null)
[ "$C" = "1" ] && ok "iframe 内按钮点击生效" || bad "got: $C"
H=$($CDP eval "$TI" "document.getElementById('heading').textContent" 2>/dev/null)
[ "$H" = "clicked:1" ] && ok "iframe 内 DOM 变更可见" || bad "got: $H"

echo "=== 场景5：OOPIF 隔离证明（host 页摸不到 iframe 内容）==="
D=$($CDP eval "$TH" "document.querySelector('iframe').contentDocument" 2>/dev/null)
[ "$D" = "null" ] && ok "host 页 eval 跨域 iframe 为 null（真实 OOPIF）" || bad "got: $D"

echo "=== 场景6：无匹配报错 ==="
E=$($CDP iframe nonexistent 2>&1 | tail -1)
case "$E" in
  *"no iframe"*) ok "无匹配子串报错" ;;
  *) bad "got: $E" ;;
esac

summary
