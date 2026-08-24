---
title: "plan: macOS auto-approve of Chrome's Allow remote debugging sheet"
type: plan
status: approved
date: 2026-08-24
---

# macOS 自动批准 Allow 弹窗 (align browser-harness `mac-approve`)

Borrow browser-harness's macOS approve helper (`src/browser_harness/macos.py` +
admin.py flow, reviewed 2026-08-24) and go one step further: instead of asking
the user to run `browser-harness mac-approve` in another shell, `cdp` invokes
the same AppleScript itself whenever Chrome's per-connection "Allow remote
debugging?" sheet is expected. Goal: on macOS the user never clicks Allow.

## Current behavior (cdp.mjs)

- Chrome 136+/151 shows a per-connection "Allow remote debugging?" sheet on
  macOS; each new CDP WebSocket connection prompts once.
- Daemon keeps one connection and retries with 10s→30s→60s backoff; CLI waits
  up to 30s for the daemon socket. If the sheet is not answered, the CLI
  prints "click Allow in Chrome, then rerun" (getOrStartBrowserDaemon,
  ~line 2752) — a manual step every Chrome session.
- We already read the chrome://inspect switch (`localStateUserEnabled`,
  Local State `devtools.remote_debugging.user-enabled`) — same gate
  browser-harness uses in `remote_debugging_toggle_profiles()`.

## Changes (all in `skills/chrome-cdp/scripts/cdp.mjs` + docs/tests)

### 1. Port the AppleScript (from browser-harness macos.py)

`MAC_APPROVE_SCRIPT` — walks `process "Google Chrome"` windows → sheets, finds
sheet named exactly `"Allow remote debugging?"`, recursively searches for an
AXButton whose description is `"Allow"`, performs `AXPress`. Does NOT activate
Chrome. Two additions over the original:

- second lenient pass: sheet name *contains* "remote debugging" (Chrome 151+
  wording drift) — same clickAllow recursion;
- process name parameterized from `CDP_CHROME_APP` when set (strip `.app`,
  e.g. Brave → "Brave Browser"), default "Google Chrome".

Requires Accessibility permission for the app that launched the terminal
(System Settings > Privacy & Security > Accessibility). This is a macOS TCC
limitation — no way around it in code; one-time grant by the user.

### 2. Node helpers (pure, unit-testable)

- `classifyMacApprove({platform, toggleEnabled, exitCode, stdout, stderr, socketUp})`
  → status mirroring browser-harness: `ready` (clicked, or socket already up) /
  `setup-required` (switch off) / `accessibility-required` (stderr
  "not authorized"/"assistive", or osascript timeout) / `not-found` / `error` /
  `unsupported` (non-darwin).
- `runMacApproveScript()` — `spawnSync('osascript', [], {input: script,
  timeout: 5000})` (script via stdin, like browser-harness).
- `macApproveOnce()` — orchestrates: socketUp → ready; toggle off →
  setup-required; else run script → classify.
- `CDP_NO_MAC_APPROVE=1` opt-out env (mirrors CDP_SKIP_INSPECT_HINT).

### 3. CLI-side auto-approve (primary path)

In `getOrStartBrowserDaemon()`'s existing socket poll loop: once ~2.5s have
elapsed without the socket, on darwin with the switch on, run `macApproveOnce()`
up to 4 times (~700ms apart) while the socket stays down. Terminal statuses
print once: `ready` → "macOS auto-approve: clicked Allow"; 
`accessibility-required` → one-time instruction (grant Accessibility to the
terminal app, then rerun / use `cdp mac-approve`); `setup-required` → existing
switch guidance. `not-found`/`error` → keep polling, fall through to the
existing failure message.

Timing fits: daemon's first CDP connect has an 8s handshake window; the click
lands inside it, so the first attempt succeeds.

### 4. ~~Daemon-side best-effort~~ — NOT DOING (user decision 2026-08-24)

Deferred. CLI-side + standalone `cdp mac-approve` only for now. Known gap:
if Chrome restarts while the daemon is alive, the resulting popup is not
auto-clicked (the user reruns the command or runs `cdp mac-approve`).

### 5. New CLI command `cdp mac-approve`

Manual helper mirroring `browser-harness mac-approve`: standalone status
print, exit 0 iff `ready`. USAGE entry + main() dispatch.

### 6. Message + docs updates

- Failure message at ~line 2752 gains "or run `cdp mac-approve`".
- SKILL.md Prerequisites: macOS auto-approve paragraph (Accessibility grant
  one-time, what to expect, CDP_NO_MAC_APPROVE).
- docs/README.md + interaction-skills/connection.md: macOS auto-approve
  section.

## Tests (`tests/macos-approve.test.mjs`, conventions of align-browser-harness.test.mjs)

- classifyMacApprove: every status mapping (unsupported / ready-socket /
  setup-required / accessibility-required via "not authorized" stderr and via
  timeout path / not-found / error on crash / ready via stdout "ready").
- macApprove gate: darwin + switch + no opt-out → true; each negative → false.
- Script sanity: MAC_APPROVE_SCRIPT contains `"Allow remote debugging?"` +
  `AXPress` + recursive clickAllow (regression guard); CDP_CHROME_APP
  parameterization of the process name.
- runMacApproveScript smoke: returns {exitCode, stdout, stderr} with string
  fields (no assertion on outcome — machine-dependent).
- Existing 31 tests keep passing (`npm test`).

## Live verification (needs user consent, one Chrome restart)

1. Ensure Accessibility granted to the terminal app (user does this once in
   System Settings; verify via `cdp mac-approve` → not-found instead of
   accessibility-required).
2. `cdp stop` → `cdp list`: expect auto-approve line in log + daemon connects
   with NO human click (watch cdp.log for `mac-approve: ready` / "connected to
   Chrome" on attempt 1).
3. `cdp mac-approve` standalone: ready when socket up / not-found when no
   sheet / accessibility-required before the iTerm grant (first run).

## Non-goals

- No TCC database edits / SIP disabling (unsafe, unnecessary).
- No Linux/Windows equivalent (Chrome prompts only on macOS for local CDP).
- No change to the per-connection security model itself (one popup per
  connection remains — it just gets clicked automatically).

## Addendum 5: 中文 Chrome 本地化 + 真正的等待点 (2026-08-24)

Live 测试发现两个实现问题,均已修复:

1. **等待点错误**:daemon 的 IPC socket 在启动时立即绑定(Chrome 连接之前),
   CLI 轮询 socket 的自动批准是死代码。真正的等待点是 CLI 等 daemon 响应
   (daemon 在 ensureChrome 里等 Chrome,最长 60s)——自动批准移到
   `sendCommandWithMacApprove`(sendCommand 的并发循环,2.5s 后开始,最多 4 次,
   700ms 间隔)。
2. **Chrome 本地化**:用户的 Chrome 是中文界面,sheet 名是「要允许远程调试吗?」
   而非 "Allow remote debugging?"——browser-harness 的英文匹配直接失败
   (403 持续、脚本报 not-found)。脚本增加中英文 sheet 名精确匹配 +
   中英文包含匹配(远程调试/remote debugging)+ 按钮 description
   「允许」/ "Allow"。
3. **standalone `cdp mac-approve` 的 ready 语义**:daemon socket 在 ≠ Chrome
   已批准(socket 先于连接绑定)。新增 daemon 轻量 `ping` 命令(不走
   ensureChrome,立即返回 chromeConnected),standalone 命令先 ping:
   已连接 → ready;未连接 → 跑 AppleScript 点弹窗。
4. **CDP_NO_MAC_APPROVE 补上**(初版漏实现),仅关闭自动路径,手动命令不受影响。

Live 验证(Chrome 重启一次,已获用户同意):
- 连续 3 轮 `cdp stop` → `cdp list`:每轮弹窗出现后 ~2.5-3.4s 自动点击,
  日志 `cli mac-approve: clicked Allow`,连接在点击后 ~300ms 内成功,无人点击。
- `CDP_NO_MAC_APPROVE=1` + 后台 list:不自动点击;手动 `cdp mac-approve` → ready,
  后台 list 随后完成。
- standalone:daemon 已连接 → `ready`(ping);弹窗悬挂 → 点击后 `ready`。
- 全量测试:`npm test` 31 旧 + 10 新(3 个旧失败为沙箱 DNS 环境问题,
  与本次改动无关,干净树上同样失败)。

## Addendum 6: 点击延迟收紧 (2026-08-24)

用户要求缩短点击延迟。时间构成:初始延迟(保守等弹窗画完)+ osascript
运行(进程启动 + AX 树遍历,实测 ~0.9s)。

- 2500ms/700ms/4次 → 400ms/300ms/6次(弹窗实测 ~0.26s 画完;6 次尝试
  覆盖到 ~2s,慢机器不丢)。
- Live 实测:点击时间 3.4s → 1.9s → **~1.3s**(两轮均首次探测即命中)。
- 物理下限 ~1s:弹窗绘制 ~0.3s + osascript 启动 ~0.4-0.9s(AX 首次访问
  开销)。再快需常驻辅助进程或改 TCC 数据库,不值当,不做。

## Decisions (approved 2026-08-24)

1. Live verification with one Chrome restart: OK.
2. Terminal: iTerm (Accessibility grant target). If TCC attribution lands on
   `node` (agent host), the grant goes to node and CLI-side approve still
   works.
3. Daemon-side best-effort approve: NOT in this batch (user decision).
