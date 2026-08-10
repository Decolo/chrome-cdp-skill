---
title: "plan: High-ROI fixes — timer leak, fast-fail target resolution, single-connection CLI"
type: plan
status: done
date: 2026-08-10
---

# High-ROI fixes

## Summary

Three deterministic inefficiencies found in a performance review of `cdp.mjs` (measured
baseline: daemon round trips are sub-millisecond; CLI overhead is dominated by Node
startup, so every wasted daemon interaction and stray file write is pure loss).

## Changes

### 1. CDP.send timeout timer leak
Every CDP command scheduled a 15s `setTimeout` that was never cleared on response,
accumulating zombie timers under high-frequency usage (`loadall` loops, `nav` polling).
The timer is now stored with the pending entry and cleared when the response settles.

### 2. Unknown target ids failed after 500ms
`getSession` waited 10×50ms for attach events that would never come for stale/closed
target ids, then failed with a bare error. Extracted `resolveSession()`: it checks the
page list first and fails fast (~1ms) with `No target with given id found — run "cdp list"`.
Known-but-unattached ids (fresh tabs) still wait for the async two-level attach events.

### 3. CLI made two socket round trips per command and wrote a dead pages.json
Every page command connected once for `resolve_target` and again for the command, and
`PAGES_CACHE` (`pages.json`) was written on list/resolve/open but never read anywhere.
`sendCommand` now multiplexes request/response pairs on one connection (matched by id,
order-independent — the daemon handles requests concurrently) and closes only after all
in-flight requests settle and a request asked for close. `PAGES_CACHE` and its three
write sites are gone.

## Quality

- First test suite for this repo: `tests/cdp-core.test.mjs` (node:test, zero deps),
  10 tests covering the timer lifecycle (response + timeout paths), all four
  `resolveSession` branches, and connection multiplexing (out-of-order responses,
  close-after semantics, connection death, daemon errors).
- The multiplexing test caught a real bug in the first close implementation: a
  close:true response arriving before a close:false one killed the still-pending
  request. Close now waits for all pending requests to settle.
- Verified live: eval through the merged path, unknown-id failure 507ms → 1.3ms,
  `pages.json` no longer recreated.

## Run

```
npm test        # node --test tests/
```

## Addendum: single-daemon guarantee (2026-08-10)

Multiple daemon processes can race to own the socket file (observed in the wild:
4 residual daemons fighting over one socket, causing hung commands). Additions:

- **Daemon pid lock** (`cdp-browser.pid`, O_EXCL): a second daemon process exits
  immediately with `already running (pid N); exiting`.
- **CLI spawn lock** (`cdp-spawn.lock`, atomic mkdir): exactly one concurrent CLI
  spawns the daemon; the others wait for its socket.
- **Orphan self-check**: the daemon records its socket inode at listen time,
  verifies it per command and on a 5s idle timer, and shuts itself down (with
  pid-file cleanup) if the file was unlinked/replaced.
- CLI: stale pid/socket files are cleaned before spawning; a live daemon with a
  missing socket is waited on rather than replaced.

Verified live: 5 concurrent `cdp list` → exactly 1 daemon, consistent pid file,
no lock residue; second daemon startup exits immediately; unlink of the socket
file kills the daemon within 5s; the next CLI command cleanly respawns one.
