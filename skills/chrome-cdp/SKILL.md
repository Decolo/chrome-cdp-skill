---
name: chrome-cdp
description: Interact with local Chrome browser session (only on explicit user approval after being asked to inspect, debug, or interact with a page open in Chrome)
---

# Chrome CDP

Lightweight Chrome DevTools Protocol CLI. Connects directly via WebSocket — no Puppeteer, works with 100+ tabs, instant connection.

## Prerequisites

- Chrome (or Chromium, Brave, Edge, Vivaldi) with remote debugging enabled: open `chrome://inspect/#remote-debugging` and toggle the switch
- Node.js 22+ (uses a hand-rolled RFC 6455 WebSocket client — zero deps; the
  built-in WebSocket can't set request headers, and a fixed Origin header gets
  403 from Chrome without --remote-allow-origins)
- If your browser's `DevToolsActivePort` is in a non-standard location, set `CDP_PORT_FILE` to its full path
- Set `CDP_HOST` if Chrome's debugging socket is not reachable on `127.0.0.1`

## Commands

All commands use `scripts/cdp.mjs`. The `<target>` is a **unique** targetId prefix from `list`; copy the full prefix shown in the `list` output (for example `6BE827FA`). The CLI rejects ambiguous prefixes.

### List open pages

```bash
scripts/cdp.mjs list
```

### Take a screenshot

```bash
scripts/cdp.mjs shot <target> [file] [--selector ".card"]   # element-scoped capture
scripts/cdp.mjs shot <target> [file] [--clip 0 120 800 500]  # clipped CSS-pixel region
```

By default, captures the **full viewport**. For a cheaper path, use `--selector` to capture one visible element or `--clip` to capture a specific CSS-pixel region inside the current viewport. Scroll first with `eval` if you need content below the fold. Output includes the page's DPR and coordinate conversion hint (see **Coordinates** below).

### Accessibility tree snapshot

```bash
scripts/cdp.mjs snap <target>
```

### Lightweight page inspection

```bash
scripts/cdp.mjs inspect <target> [selector] [--limit 5] [--sections headings,buttons,text] [--no-text]
```

Use `inspect` first for page state: title, URL, ready state, focus, visible controls, links, inputs, forms, headings, and a bounded text sample. When you only need part of that, reduce the payload with `--sections`, `--limit`, or `--no-text`. Prefer scoped `html`, `html --text`, or one combined `eval` before escalating to `snap` for full accessibility structure or `shot` for visual evidence.

### Daemon stats

```bash
scripts/cdp.mjs stats
```

Shows browser daemon uptime, session/page counts, and recent command timings. Use this when local Chrome automation feels slow or resource-heavy.

`stats` also shows short-TTL metadata cache behavior and separates recent command cost into setup, attach, page-enumeration, and command-body timing where relevant.

### Evaluate JavaScript

```bash
scripts/cdp.mjs eval <target> <expr>
```

> **Watch out:** avoid index-based selection (`querySelectorAll(...)[i]`) across multiple `eval` calls when the DOM can change between them (e.g. after clicking Ignore, card indices shift). Collect all data in one `eval` or use stable selectors.

### Other commands

```bash
scripts/cdp.mjs html    <target> [selector] [--text] [--max-chars 2000]  # scoped HTML or text-only output
scripts/cdp.mjs inspect <target> [selector] [--limit 5] [--sections headings,buttons,text] [--no-text]
scripts/cdp.mjs nav     <target> <url>         # navigate and wait for load
scripts/cdp.mjs net     <target> [--limit 10] [--type fetch] [--same-origin]  # narrower network view
scripts/cdp.mjs click   <target> <selector>    # click element by CSS selector
scripts/cdp.mjs clickxy <target> <x> <y>       # click at CSS pixel coords
scripts/cdp.mjs type    <target> <text>         # Input.insertText at current focus; works in cross-origin iframes unlike eval
scripts/cdp.mjs loadall <target> <selector> [ms]  # click "load more" until gone (default 1500ms between clicks)
scripts/cdp.mjs wait    <target> <selector> [--timeout ms] [--visible]  # wait for CSS selector to appear (default 10s); --visible also requires non-hidden + in-layout
scripts/cdp.mjs wait    <target> --load [--timeout ms]  # wait for document.readyState == 'complete'
scripts/cdp.mjs wait    <target> --network-idle [--timeout ms] [--idle ms]  # wait until network quiet (default idle 500ms)
scripts/cdp.mjs press   <target> <key> [--ctrl|--shift|--alt|--meta]  # dispatch key press (Enter/Tab/Arrows/char) with optional modifier combo
scripts/cdp.mjs fill    <target> <selector> <text...> [--no-clear] [--timeout ms]  # fill a framework-managed input: focus, clear, real key events, then input+change
scripts/cdp.mjs scroll  <target> <x> <y> [--dy px] [--dx px]  # wheel-scroll at viewport coords (default dy=-300)
scripts/cdp.mjs upload  <target> <selector> <path>  # set files on a file input (DOM.setFileInputFiles)
scripts/cdp.mjs ensure-real-tab <target>        # if tab is internal (chrome:// etc.), switch to the first real tab
scripts/cdp.mjs close   <target>                  # close the tab; without <target>: close the session's current tab
scripts/cdp.mjs switch  <target> [--session <id>] # activate tab + set it as this session's current tab
scripts/cdp.mjs current [--session <id>]          # this session's current tab {targetId,url,title}
scripts/cdp.mjs iframe  [url-substr]              # list cross-origin iframe targets, or resolve the first whose URL
                                                    contains the substring; the id works with every page command
scripts/cdp.mjs evalraw <target> <method> [json]  # raw CDP command passthrough
scripts/cdp.mjs open    [url] [--session <id>]    # open url in a blank tab if one exists (reused), else a new tab;
                                                    the opened tab becomes this session's current tab
scripts/cdp.mjs list    [--session <id>]          # tabs; * marks this session's current tab (reuses the single
                                                    browser daemon; auto-launches Chrome with remote debugging if not running)
scripts/cdp.mjs stats                          # daemon health and recent command timings
scripts/cdp.mjs stop                           # stop the browser daemon
```

## Coordinates

`shot` saves an image at native resolution: image pixels = CSS pixels × DPR. CDP Input events (`clickxy` etc.) take **CSS pixels**. `--clip` coordinates also use CSS pixels.

```
CSS px = screenshot image px / DPR
```

`shot` prints the DPR for the current page. Typical Retina (DPR=2): divide screenshot coords by 2.

## Tips

- Prefer `inspect` for first-pass page state; use scoped `html` or one combined `eval` before reaching for `snap` or `shot`.
- Use `inspect --sections ...` or `html --text` when a full read would waste output budget.
- Use `type` (not eval) to enter text in cross-origin iframes — `click`/`clickxy` to focus first, then `type`.
- Prefer one combined `eval` over many small `eval` calls when collecting structured page data.
- Use `net --same-origin` or `--type` before broad resource listings when you only need one slice.
- Use `stats` to spot commands that are setup-heavy or return unusually large payloads, not just slow ones.
- `nav` only waits for `readyState=complete` — SPAs render after that. Use `wait <target> <selector>` after actions that trigger async rendering (route changes, data fetches); add `--visible` when the element may exist hidden in the DOM.
- `wait --load` reports the current document's readyState. After `open`, navigation is async: the new tab briefly stays on `about:blank` whose readyState is already `complete`, so `wait --load` right after `open` can false-positive on the pre-navigation document. Reliable patterns: use `nav` (which gates on the load event) or poll `location.href` first (as the e2e scripts do).
- **Cross-origin iframes**: an OOPIF is its own CDP target (`type=iframe`), so `cdp iframe` (list) or `cdp iframe <url-substr>` (BH `iframe_target`) gives you an id that works with every page command — `eval` runs inside the iframe's own JS context, `click`/`fill`/`inspect` target it directly. This is the only way to read or operate cross-origin iframe content: a host-page `eval` returns `null` for `iframe.contentDocument` (OOPIF isolation).
- **Sessions (current tab)**: each agent session remembers the tab it works on — `open`/`switch` set it, and page commands may then omit `<target>` and act on that tab (`cdp eval "js"`, `cdp wait --load`, `cdp close`, `cdp ensure-real-tab`). The session id comes from `--session <id>` (any position) or the `CDP_SESSION` env var; without either, `default`. Give each subagent a distinct `CDP_SESSION` so several agents can operate different tabs concurrently. An explicit hex target still wins; a target-less command with no current tab errors with a hint to run `switch` first. Mirrors browser-harness's `current_tab` model, but scoped per session.
- `press` follows browser-harness `press_key` semantics: keyDown → char (printable only, and only when no Alt/Ctrl/Meta modifier) → keyUp, with BH's virtual-key table (Enter=13/\r, Tab=9/\t, Backspace, Escape, Delete, Space, Arrows, Home/End, PageUp/PageDown). Modifiers are the BH bitfield (1=Alt 2=Ctrl 4=Meta 8=Shift); Alt/Ctrl/Meta turn a single key into a shortcut (no char event). Enter carries text `\r` so form submissions fire; Tab carries `\t` so focus moves. e.keyCode comes from the BH ord() mapping (single chars pass their ASCII code, e.g. 'a'→97).
- `fill` follows browser-harness `fill_input`: focus → clear (JS `select()` + Backspace) → per-char real key events → synthetic `input`+`change` events. Use it where `type` (Input.insertText) is ignored — React controlled inputs, Vue v-model, Ember tracked fields: insertText bypasses framework listeners, so submit buttons stay disabled. Note BH's select-all-via-Cmd/Ctrl+A shortcut does not work through CDP at all (synthetic key events never trigger Chrome's select-all edit command, and background tabs receive no edit commands); `select()` is deterministic in both.
- `wait --network-idle` is the SPA-safe counterpart of `--load`: readyState becomes `complete` before framework XHR/fetch settle. It tracks in-flight requests per tab (Network domain enabled at attach, events never replayed — attach happens before navigation, so tracking is complete from navigation start). Long-lived connections (SSE/keepalive/streaming) keep the page busy forever — the wait then times out with `inflight: n`; this matches browser-harness semantics.
- Chrome shows an "Allow debugging" modal once per Chrome session. A background browser daemon keeps the CDP connection alive so subsequent commands need no further approval until Chrome disconnects or you run `stop`. Each daemon start makes exactly ONE connection attempt (20s window) — one popup, click it, done; cdp never reconnects inside a daemon lifetime, so popups can't pile up.
- If Chrome is not running at all, `cdp` launches it automatically with the
  last-used profile — no manual start needed. Chrome 136+ ignores
  `--remote-debugging-port` on the default profile, so debugging comes from
  Chrome's own "Allow remote debugging" switch (chrome://inspect, remembered
  in Local State): tick it once, restart Chrome, and every future launch opens
  the DevTools port automatically. Override the binary with
  `CDP_CHROME_PATH`/`CHROME_PATH`; on macOS `CDP_CHROME_APP` overrides the
  app name used to launch and to open tabs via AppleScript; a custom
  `CDP_USER_DATA_DIR` restores the command-line debug flag (Chrome for
  Testing, isolated instances).
- If Chrome runs without remote debugging, `cdp open <url>` still opens the
  tab via the system (macOS AppleScript) and prints a guide to the switch.
- If Chrome is running but remote debugging is off, `cdp` opens
  `chrome://inspect/#remote-debugging` once (at most once per 3 minutes,
  tracked via `~/.cache/cdp/inspect-opened`), prints a guide, and exits
  immediately (0.3s) — it never waits on you; rerun after ticking the switch
  (disable the hint with `CDP_SKIP_INSPECT_HINT=1`).
- The `chrome://inspect` tab `cdp` opened is closed automatically on the next
  successful connection (the daemon tracks it via the marker file) — only
  tabs the tool itself opened are closed, never tabs you opened manually.
