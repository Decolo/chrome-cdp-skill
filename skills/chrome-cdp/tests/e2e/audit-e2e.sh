#!/bin/bash
# I3 e2e: audit log (knowledge-layer observability)
# Scenes:
#  1. commands land in the audit file with full fields
#  2. argument VALUES are scrubbed (eval JS never appears)
#  3. failing commands are recorded with ok=false + error
#  4. `cdp stats` reports the audit path and entry count
cd "$(dirname "$0")/../.."
source tests/e2e/lib.sh
export E2E_HEADLESS=1
# Audit dir must be set BEFORE the daemon starts (CLI spawns it with our env).
AUD=$(mktemp -d /tmp/cdp-audit-e2e.XXXXXX)
export CDP_AUDIT_DIR="$AUD"
export CDP_AUDIT_FILE="$AUD/audit.jsonl"
e2e_isolated_setup
E2E_NAME="audit log (I1-I2)"

T=$($CDP open "about:blank" 2>/dev/null | awk '{print $4}')
$CDP eval "$T" "1+1" >/dev/null 2>&1
$CDP eval "$T" "2+2" >/dev/null 2>&1
$CDP eval "$T" "SUPER_SECRET_TOKEN_XYZ(" >/dev/null 2>&1 || true   # failing eval

echo "=== 场景1：命令落盘 + 字段齐全 ==="
sleep 0.3
N=$(wc -l < "$AUD/audit.jsonl")
[ "$N" -ge 4 ] && ok "audit 文件有 $N 行 (>=4)" || bad "audit 行数不足: $N"
python3 - <<'PY' "$AUD/audit.jsonl"
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1])]
need = {"ts","cmd","args","argChars","target","session","ok","error","ms"}
ok_all = all(need <= set(r) for r in rows)
cmds = {r["cmd"] for r in rows}
print("FIELDS_OK" if ok_all else "MISSING_FIELDS", sorted(cmds))
PY
case "$(python3 -c "import json,sys; rows=[json.loads(l) for l in open('$AUD/audit.jsonl')]; print('OK' if all({'ts','cmd','args','argChars','target','session','ok','error','ms'}<=set(r) for r in rows) else 'BAD')")" in
  OK) ok "每行字段齐全 (ts/cmd/args/argChars/target/session/ok/error/ms)" ;;
  *) bad "字段缺失" ;;
esac

echo "=== 场景2：脱敏（eval JS 不出现在 audit）==="
if grep -q "SUPER_SECRET_TOKEN_XYZ" "$AUD/audit.jsonl"; then
  bad "审计泄露了 eval JS 内容"
else
  ok "eval 参数值已脱敏"
fi

echo "=== 场景3：失败命令记录 ==="
E=$(python3 -c "
import json
rows=[json.loads(l) for l in open('$AUD/audit.jsonl')]
bad=[r for r in rows if not r['ok']]
print(bad[0]['cmd'] if bad else 'NONE')
")
[ "$E" = "eval" ] && ok "失败命令有 ok=false 记录" || bad "got: $E"

echo "=== 场景4：stats 联动 ==="
S=$($CDP stats 2>&1)
case "$S" in
  *"Audit log: $AUD/audit.jsonl"*) ok "stats 显示 audit 路径" ;;
  *) bad "stats 缺 audit 路径" ;;
esac
case "$S" in
  *"entries"*) ok "stats 显示条数" ;;
  *) bad "stats 缺条数" ;;
esac

echo "=== 场景5：audit.mjs 可读 ==="
OUT=$(node scripts/audit.mjs 2>&1)
case "$OUT" in
  *"per-command"*"eval"*) ok "audit.mjs 输出摘要" ;;
  *) bad "got: $(echo "$OUT" | head -3)" ;;
esac

rm -rf "$AUD"
summary
