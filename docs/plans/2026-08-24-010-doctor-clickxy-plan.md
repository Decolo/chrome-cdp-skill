---
title: "plan: clickxy button/clicks + cdp doctor (browser-harness gap closure)"
type: plan
status: done
date: 2026-08-24
---

# 第十批:clickxy 右键/中键/双击 + cdp doctor 环境诊断

Closing the two P0 gaps from the full capability-map comparison (009 review):
browser-harness has `click_at_xy(button=, clicks=)` and `--doctor`; we have
neither. Both are small, additive, and testable.

## 1. `clickxy` gains --button / --clicks

Current: `clickxy <target> <x> <y>` — hardcoded left-click (clickXyStr, button
'left', clickCount 1). Alignment target: `click_at_xy(x, y, button, clicks)`.

New signature:
  clickxy <target> <x> <y> [--button left|right|middle] [--clicks 1|2]

Implementation:
- Parse args in the CLI dispatch (like --clip/--selector patterns).
- Event sequence (pure helper `clickXyEvents(x, y, button, clicks)` returning
  the Input.dispatchMouseEvent list; testable without CDP):
  - clicks=1: mouseMoved → mousePressed(clickCount 1) → mouseReleased(1)
  - clicks=2: pressed(1) → released(1) → pressed(2) → released(2) (dblclick)
- button passthrough: left/right/middle map to CDP button strings
  ('middle' stays 'middle'; no 'back'/'forward' — not exposed by upstream).
- Return message includes the actual button/clicks, e.g. `Clicked right at CSS (x, y)`.
- USAGE + SKILL.md + docs updated.

Tests (tests/clickxy-events.test.mjs or extend existing):
- parse: --button right → {button:'right'}, --clicks 2, defaults, invalid
  values rejected (--button sideways / --clicks 3 → error).
- clickXyEvents: 1-click sequence has 3 events with clickCount 1; 2-click
  sequence has 5 events with clickCounts [1,1,2,2] and button preserved.
- Existing suite keeps passing.

Live verification (no Chrome restart needed; runs in the user's Chrome):
  cdp open about:blank → eval register contextmenu + dblclick listeners →
  cdp clickxy <t> 100 100 --button right → eval flag === 'contextmenu';
  then --clicks 2 → eval flag === 'dblclick'. Zero user interaction.

## 2. `cdp doctor` — environment diagnostics

Alignment target: browser-harness `--doctor` (admin.py run_doctor: checks
install/daemon/browser state, prints guidance). Our `stats` is daemon health +
timings only; doctor is a setup/troubleshooting entry point.

Report sections (each item `[ok] | [warn] | [fail]` + one-line guidance):
1. Platform / runtime dir / socket path / log path.
2. Daemon: pid file, socket file, ping probe (reuse 009 ping: connected to
   Chrome vs socket-only vs dead).
3. Chrome: process running (ps scan, reuse launchChrome's name list),
   DevToolsActivePort present, port live (reuse devToolsPortLive),
   Local State switch state (reuse localStateUserEnabled).
4. macOS: auto-approve availability note (Accessibility requirement, no probe).
5. Log tail (last ~8 lines of LOG_FILE).
6. Fix guidance per fail item: chrome://inspect toggle, restart Chrome,
   `cdp mac-approve`, CDP_CHROME_PATH env, `cdp stop` stale daemon, etc.

Exit code: 0 if all ok or only warn; 1 if any fail (scriptable).

Implementation: pure classifier `classifyDoctorItem(...)` for tests;
`doctorCmd()` assembles the report using existing helpers; new `readLogTail()`.
CLI dispatch + USAGE entry. No daemon changes (doctor is CLI-side read-only +
ping).

Tests:
- Isolated runtime (existing isolatedCdpModule pattern): empty RUNTIME_DIR →
  daemon fail + guidance, log missing, exit 1.
- classifier unit mappings (each item's {inputs} → status).
- Real env: doctor exits 0 (daemon connected, port live, switch on).

Live verification: `cdp doctor` on the real machine → all ok; temporarily
point CDP_PORT_FILE at a bogus path → that section shows fail + guidance
(then restore).

## Non-goals

- No recorder/video pipeline (user decision), no cloud auth, no telemetry,
  no profile management, no IPC token, no http_get/drain_events.
- No daemon-side changes at all in this batch.
- clickxy stays CSS-pixel based; no drag support (scroll covers wheel).

## Tests summary

- New unit tests for clickXyEvents + parseClickArgs + classifyDoctorItem.
- Live verification for both commands as described above.
- Existing 41 tests (38 pass / 3 pre-existing sandbox-DNS failures) unchanged.


## Addendum 1: 实现与验证记录 (2026-08-24)

实现要点:
- clickxy:纯函数 `clickXyEvents(x, y, button, clicks)`(双击 = clickCount [1,1,2,2],
  两轮完整 press/release,比上游单发 clickCount=clicks 更接近真人;`parseClickxyArgs`
  解析 `--button left|right|middle` / `--clicks 1|2`,非法值报错)。daemon 侧 case
  解析参数,CLI 协议不变。
- doctor:`doctorItems(facts)` 纯分类器(6 段报告、[ok]/[warn]/[FAIL]/[info] +
  一行修复指引);`doctorCmd()` 只读采集 + ping 探测(2s 短超时,僵死 daemon
  不拖慢诊断);退出码 0/1。daemon 零改动。

Live 验证(全部通过):
- clickxy:真实 Chrome 空白页注册监听 → `--button right` 触发 contextmenu;
  `--clicks 2` 触发 dblclick;`--button sideways` 报错。daemon 重启后生效
  (常驻进程需 stop 后重测——第一次测到旧代码,已注意)。
- doctor:真实环境全 ok exit 0;`CDP_PORT_FILE` 指向无效端口文件 → [FAIL] +
  restart 指引 exit 1;daemon 停止时 [info] 不 fail(按需启动)。

调试中抓到的两个 bug(均为漏 await):
1. `connectToSocket` 未 await → ping 永远失败,daemon 状态误报 warn。
2. `devToolsPortLive` 未 await → f.portLive 是 Promise(truthy),fail 路径
   被跳过,无效端口文件误报 ok。→ 教训:async 返回值赋给字段前必查 await,
   doctor 这类只读诊断尤其容易踩(异常被 try/catch 吞)。

测试:15 新(clickXyEvents 序列/button 透传、parseClickxyArgs 默认值+非法值、
doctorItems 全分支)+ 既有 41(3 个旧失败为沙箱 DNS 环境问题,与本次无关)。

## Open questions

1. doctor output language: English (current CLI is English) — assume yes.
2. doctor exit code 1 on any fail — ok? (browser-harness exits 0; we choose
   scriptable 1. Minor divergence, note it.)
3. Live clickxy verification clicks in your real Chrome (a blank tab we open
   and close afterwards) — ok?
