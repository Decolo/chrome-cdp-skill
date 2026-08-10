---
title: "plan: Align browser-harness capabilities — auto-launch Chrome + tab reuse"
type: plan
status: done
date: 2026-08-10
---

# Align browser-harness capabilities

Borrow the two highest-value capabilities from browser-use/browser-harness
(reviewed 2026-08-10, v0.1.8): Chrome lifecycle management and safe tab reuse.
Goal: `cdp` commands work even when Chrome is not running, and never open
needless duplicate tabs.

## Current behavior (cdp.mjs)

- daemon requires a running Chrome with remote debugging already enabled;
  otherwise: `Browser daemon: cannot connect to Chrome` (or the CLI-level
  "did you click Allow in Chrome?").
- `open [url]` always calls `Target.createTarget` — a fresh tab every time,
  even when a blank tab is already sitting there.

## Changes

### 1. Auto-launch Chrome when it is not running (CLI side, before daemon spawn)

New `launchChrome()` inside the spawn-lock section of `getOrStartBrowserDaemon()`:

1. Detect a running Chromium via `ps`/`tasklist` (same names as browser-harness:
   Google Chrome, Chromium, Brave, Edge, Vivaldi).
2. If running → check DevToolsActivePort is actually live (port probe). If
   missing/stale → P2 fallback (see below).
3. If NOT running → launch:
   - binary override: `CDP_CHROME_PATH` / `CHROME_PATH` env
   - macOS: `open -a "<App>" --args --remote-debugging-port=0 --profile-directory=<last-used>`
   - Linux: `which google-chrome|chromium|...` + same args
   - Windows: `cmd /c start chrome ...`
   - `--remote-debugging-port=0` → Chrome picks a port and writes
     DevToolsActivePort (which `getWsUrl()` already reads — zero new discovery code).
   - `--profile-directory=<last-used>` read from `Local State` (skips the
     profile picker; keeps the user's login state — same trick as browser-harness).
4. Poll for DevToolsActivePort up to ~20s (cold start), then proceed to spawn
   the daemon as today.

### 2. Reuse blank tabs in `open` instead of always creating one

New pure helper `findReusableTab(pages)`:

- reusable: `about:blank`, `about:blank#*`, `chrome://newtab`, `edge://newtab`
- never touched: any real page (`http(s)://`, `file://`, other chrome://)

`open` flow: resolve prefix → if reusable tab exists, `Target.activateTarget`
+ `Page.navigate(url)` on it; else `Target.createTarget` as today. Returns the
same `{ targetId, pages }` shape — CLI protocol unchanged.

### 3. Guidance when Chrome runs but remote debugging is off (P2, minimal)

If a browser is running but no live DevToolsActivePort is found:
print a clear hint and open `chrome://inspect/#remote-debugging` once via
`open` (macOS) / `xdg-open` (Linux) — then keep waiting briefly for the user
to tick the checkbox. No marker-file machinery (that's browser-harness's
complexity; our minimal version just guides).

## Non-goals

- No cloud browsers, no recordings/video pipeline, no 97-site skill library.
- No `chrome://inspect` marker tracking or profile-permission memory (P2 is a
  one-shot hint only).
- Daemon-side protocol unchanged; no new commands.

## Tests

- `findReusableTab(pages)` — unit: blank/newtab reused, real pages untouched,
  priority order (first reusable wins).
- `resolveLastUsedProfile(baseDir)` — unit: Local State parse, missing file,
  non-dir fallback to `Default`.
- Existing 17 tests keep passing (`npm test`).
- Live verification (needs one Chrome quit/restart, ask user first):
  `pkill Chrome` → `cdp list` auto-launches Chrome with debugging on →
  `cdp open <url>` reuses the blank tab (verify via `cdp list` tab count).

## Open questions

1. OK to verify live by quitting Chrome once? (Login state survives — profile
   dir untouched — but the browser window restarts.)
2. P2 guidance: auto-open chrome://inspect, or just print the hint?

## Verification (2026-08-10)

- `npm test`: 26/26 (17 prior + 9 new: findReusableTab classification,
  resolveLastUsedProfile parsing, chromeLaunchArgs, devToolsPortLive,
  CDP_PORT_FILE override).
- Live: `open about:blank` creates a tab (13→14); `open https://example.com`
  reuses it ("Reused blank tab", count stays 14); `eval document.title` on the
  reused tab returns "Example Domain".
- Live: `launchChrome()` with `CDP_CHROME_PATH` + `CDP_USER_DATA_DIR` starts an
  isolated Chrome (`--remote-debugging-port=0 --user-data-dir=...`),
  DevToolsActivePort appears, port live; test instance closed afterwards.
- Note: real auto-launch on the user's Chrome requires Chrome to be fully
  closed (the launch branch only runs when no browser process is detected);
  covered by unit tests + the isolated live test above.
- One transient hang during live testing traced to Chrome's per-session
  "Allow debugging" prompt on a fresh daemon connection — expected behavior,
  resolved by approving once.

## Addendum: full browser-harness alignment (2026-08-10)

Live testing found Chrome 151 ignores `--remote-debugging-port` on the
default profile (136+ security change); our initial launch-with-flag approach
also broke Chrome's own switch path. Aligned with browser-harness:

- **No debug flag on the default profile.** Debugging now comes from
  Chrome's "Allow remote debugging" switch, read from Local State
  (`devtools.remote_debugging.user-enabled`, same key as browser-harness's
  `remote_debugging_toggle_profiles`). With the switch on, a plain launch
  opens the port automatically (~1s).
- **Patient daemon connect** (mirrors `_PatientCDPClient`): 3 attempts x 8s
  timeout, 2s apart; CLI poll window raised to 21s to cover it.
- **CDP.connect timeout** (8s) so a permission prompt or warming Chrome can
  never hang the daemon forever.
- **AppleScript fallback for `open`** on macOS when CDP is unavailable (not
  in browser-harness; keeps "open a tab" working before the switch is set).
- **No long waits**: Chrome-running-without-debugging guides immediately and
  exits (0.3s); cold-launch wait capped at 15s.

Verified end-to-end with Chrome fully closed: `cdp open <url>` -> Chrome
auto-launches (no debug flag) -> switch opens the port in ~1s -> daemon
connects (attempt 1) -> tab opens via CDP. Total 4.3s. `eval` works on the
opened tab. Tests: 28/28.

## Addendum 2: post-review fixes (2026-08-10)

Subagent review (Standards + Spec axes) findings fixed in one commit:

- CDP.connect timeout timer now cleared on error/close too — a fast-fail
  attempt previously left a stale timer that aborted the next retry's socket
  (real bug).
- Removed the nonexistent `cdp --doctor` reference from the failure message.
- CLI daemon-poll window raised 21s -> 30s so it covers the patient connect's
  worst case (3x8s attempts + 2x2s gaps = 28s).
- `findReusableTab` no longer matches `about:newtab` (Firefox-only scheme,
  unreachable in Chrome; the original plan listed only about:blank /
  chrome://newtab / edge://newtab).
- AppleScript fallback now honors `CDP_CHROME_APP`; SKILL.md documents it.
- SKILL.md wording fixed (no waiting for the switch — immediate exit);
  USAGE line for `open` updated; daemon-command log tag corrected.
- launchChrome parses launch args once instead of per-branch.
- Tests: 29/29. Daemon response gained additive `reusedTab`/`text` fields
  (CLI protocol backward-compatible).

## Addendum 3: inspect-tab lifecycle — fully borrowed from browser-harness (2026-08-10)

Borrowed their whole permission-tab lifecycle to reduce Allow-popup friction:

- `~/.cache/cdp/inspect-opened` marker (their `inspect_marker()`): written when
  the guide opens `chrome://inspect`, with a 180s reopen TTL
  (`_open_chrome_inspect_once` equivalent) so repeated commands don't spawn
  tab after tab.
- Daemon `closeInspectTabs()` after a successful connect (their
  `_close_inspect_tabs`): closes only marker-owned chrome://inspect tabs and
  clears the marker. Tabs the user opened themselves are never touched.
- Guidance message is now switch-aware (their 3-way guidance): switch already
  ticked -> "untick and re-tick" advice; not ticked -> tick advice; both add
  the expectation note "Chrome shows ONE Allow popup per connection — it is
  expected, not a re-ask" (their per-connection approval wording).

Verified live: marker + inspect tab present -> daemon reconnect -> tab closed,
marker cleared, log line `closed 1 leftover chrome://inspect tab(s)`.
Tests: 31/31.
