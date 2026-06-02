---
title: "plan: Tighter scope controls for read-heavy commands"
type: plan
status: active
date: 2026-06-02
---

# Tighter scope controls for read-heavy commands

## Goal

Add optional scope controls to the read-heavy commands where they materially reduce payload size without making the CLI awkward or pushing users into verbose raw-CDP workflows.

## Scope

This plan covers scope-discipline improvements for the existing human-facing commands:

- `inspect`
- `html`
- `net`

It does not cover screenshot capture, daemon observability internals, or metadata caching.

## Problem statement

The current command surface already has some good defaults, but read-heavy commands can still return more page state than the caller actually needs.

The risk is not just runtime cost. Large outputs also:

- waste agent context
- increase local Chrome/CDP work
- make it harder to spot the relevant detail in the response

The goal is to create smaller, clearer read paths without turning normal usage into flag soup.

## Design constraints

- Keep existing default behavior backward compatible unless the new default is clearly lower-risk and still human-readable.
- Prefer a small number of high-value scope controls over a large flag surface.
- Avoid adding controls that merely expose CDP internals without a meaningful resource win.
- Keep the command line readable enough that an agent or human can infer the cheapest path quickly.

## Planned work

### P1. Audit the current payload shape of `inspect`, `html`, and `net`

- Measure which parts of each command dominate output size
- Separate commands that are payload-heavy because of useful content from commands that are just overly broad
- Use the current implementation and manual runs as the source of truth instead of guessing

### P2. Tighten `inspect` only where the shape remains human-first

- Evaluate whether `inspect` should gain one narrow scope control such as:
  - a more explicit selector-focused mode
  - optional inclusion/exclusion of broad sections like links or forms
- Reject options that make `inspect` feel like a structured query language
- Preserve `inspect` as the cheapest first-pass read, not a mini-framework

### P3. Extend `html` with clearer low-payload paths

- Keep the current selector-scoped path
- Evaluate whether `html` needs one more output-discipline control such as:
  - a lower default cap override
  - text-only extraction for a scoped element
  - an explicit shallow mode if that creates a real reduction
- Keep the default output understandable in terminal use

### P4. Add narrower network views only if they reduce noise and bytes

- Evaluate whether `net` should support one or two scope controls such as:
  - entry count limit override
  - resource-type filter
  - same-origin-only or document-origin-only filtering
- Keep the default tuned for “what is obviously slow?” rather than exhaustive network inspection

### P5. Update docs and usage guidance around cheapest read paths

- Document the new scope controls in `README.md` and `skills/chrome-cdp/SKILL.md`
- Keep the docs opinionated: explain which path is cheapest and when to escalate

## Output expectations

The result of this plan should be:

- a smaller command surface than raw CDP
- cheaper page reads for common agent workflows
- clearer guidance on when to use `inspect`, `html`, or `net`

## Verification

- `node --check skills/chrome-cdp/scripts/cdp.mjs`
- Manual runs of `inspect`, `html`, and `net` against a live Chrome session
- Compare default output size versus scoped output size for at least one realistic page per command
- Confirm existing basic invocations still behave sensibly:
  - `inspect <target>`
  - `html <target>`
  - `net <target>`
