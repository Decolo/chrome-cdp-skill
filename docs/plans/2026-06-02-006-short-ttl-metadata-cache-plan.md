---
title: "plan: Short TTL metadata caching"
type: plan
status: active
date: 2026-06-02
---

# Short TTL metadata caching

## Goal

Reduce repeated cheap-but-frequent setup work by adding conservative short-lived caching for metadata such as page lists and target resolution, while avoiding stale caches for DOM-heavy or interaction-sensitive state.

## Scope

This plan covers metadata caching only:

- page list caching
- target resolution support data
- short-lived daemon-side cache entries
- conservative invalidation rules

It does not cover caching DOM snapshots, HTML output, eval results, or interaction results.

## Problem statement

The current implementation already uses a local pages cache file, but it is still fairly coarse and mostly oriented around correctness rather than short-window reuse strategy.

There is likely a cheaper path for repeated command bursts where:

- the open-tab set has not changed
- the same target is being resolved repeatedly
- the agent is issuing several commands in quick succession

The challenge is that stale metadata is worse than a small amount of extra work if it causes commands to point at the wrong tab or hide recent tab changes.

## Design constraints

- Cache only metadata that is cheap to validate and cheap to evict.
- Prefer very short TTLs over aggressive invalidation heuristics.
- Keep correctness biased toward refresh when in doubt.
- Avoid hidden behavior that makes the CLI feel nondeterministic.

## Planned work

### P1. Audit what is already cached and where refreshes still happen

- Trace the current `pages.json` flow and target-resolution path
- Identify repeated work that still occurs during short command bursts
- Separate daemon-side opportunities from CLI-side file-cache behavior

### P2. Define the cacheable metadata set

- Likely candidates:
  - page list snapshots
  - resolved target-id lookups derived from a recent page list
  - recent attach metadata only if it is cheap and safe
- Explicit non-goals:
  - DOM trees
  - HTML payloads
  - `eval` results
  - network timing results

### P3. Add short TTL daemon-side caching with conservative invalidation

- Use a short window tuned for bursty agent usage, not long-lived background reuse
- Refresh on clear invalidation signals such as:
  - explicit open/close flows
  - target resolution miss
  - attach/session errors that imply stale metadata
- Keep the rules easy to reason about from the code

### P4. Make cache behavior observable enough to trust

- Surface cache hit/miss or refresh behavior in `stats` or daemon history if the added signal is low-noise
- Ensure follow-up debugging can tell whether the cache helped or masked a stale lookup

### P5. Re-check correctness boundaries and fallback behavior

- Confirm ambiguous or missing target prefixes still refresh and fail clearly
- Confirm cache staleness falls back to a refresh rather than returning misleading results
- Confirm the design still behaves well with many open tabs

## Output expectations

The result of this plan should:

- reduce repeated metadata work during short command bursts
- preserve predictable target resolution
- make stale-cache failures unlikely and understandable

## Verification

- `node --check skills/chrome-cdp/scripts/cdp.mjs`
- Manual repeated-command runs against a live Chrome session
- Manual target-resolution checks after:
  - opening a new tab
  - closing or changing tabs if reproducible
  - forcing a stale target resolution path
- Confirm correctness-first fallback behavior on cache miss or stale data
