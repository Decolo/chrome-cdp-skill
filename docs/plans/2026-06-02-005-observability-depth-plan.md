---
title: "plan: Deeper daemon observability"
type: plan
status: active
date: 2026-06-02
---

# Deeper daemon observability

## Goal

Make `stats` and the daemon’s internal timing data granular enough to show whether a slow command was expensive because of setup work, command body work, or unusually large output.

## Scope

This plan covers observability depth only:

- daemon command timing breakdowns
- attach/re-attach visibility
- target/page enumeration visibility
- clearer `stats` output

It does not cover broader performance tracing, browser CPU attribution, or daemon idle shutdown.

## Problem statement

The current `stats` output is useful, but it still compresses too much of the command lifecycle into a single duration.

That leaves an important ambiguity:

- was the command itself slow?
- was target resolution or page enumeration slow?
- was attach/re-attach slow?
- was the response large even if the command body was quick?

Without that breakdown, later optimization work stays guess-based.

## Design constraints

- Keep runtime overhead low enough that instrumentation itself does not become a noticeable cost.
- Prefer simple, stable field names over a deeply nested telemetry schema.
- Keep `stats` human-readable in a terminal.
- Avoid turning the daemon into a metrics system; this is debugging-oriented local observability.

## Planned work

### P1. Map the command lifecycle that matters for cost

- Define the sub-stages worth measuring, likely including:
  - target resolution
  - page cache refresh when needed
  - session attach or re-attach
  - command body execution
  - response serialization size
- Exclude sub-stages that add noise without actionable value

### P2. Record per-command timing breakdowns in daemon history

- Extend the in-memory command history model to capture the new sub-costs
- Keep the history bounded like the current implementation
- Preserve graceful handling for commands that do not exercise every stage

### P3. Surface attach and enumeration behavior explicitly

- Show when a command reused an existing session versus requiring attach/re-attach
- Show when page enumeration or cache refresh happened
- Make it easy to identify commands that are slow only because of setup churn

### P4. Improve `stats` presentation

- Add the new timing fields in a compact, scan-friendly format
- Keep the current top-level daemon health summary intact
- Make large-response commands and setup-heavy commands visibly distinct

### P5. Use the instrumentation to guide follow-up optimization

- Confirm whether metadata caching is still the next highest-value step
- Confirm whether any read-heavy commands still need tighter scope controls after the new visibility exists

## Output expectations

The result of this plan should make it easy to answer:

- “Which commands are slow because of Chrome work?”
- “Which commands are slow because of setup around Chrome?”
- “Which commands are mostly a payload-size problem?”

## Verification

- `node --check skills/chrome-cdp/scripts/cdp.mjs`
- Manual `stats` verification against a live Chrome session
- Manual runs that exercise both warm and cold-ish paths:
  - repeated commands on one target
  - a command after cache miss or page refresh
  - a command that forces attach or re-attach behavior if reproducible
- Confirm the new fields stay readable in normal terminal width
