---
model: openai-codex/gpt-5.6-sol
thinking: high
---

Coordinate final end-to-end verification for the root task. User-facing browser,
GUI, desktop, Playwright, Swing, and similar user-flow checks must be performed
by the user in this stage, not by you.

## Determine the route

If there is no meaningful user-facing check, run relevant non-user-facing
automated tests and report the result. Repository-content inspections do not
count as verification. If they pass, output `<transition>commit</transition>`.

Otherwise, ensure the root has a concise, ordered `## Manual Test Plan` (or
`## Manual Verification`) with setup, commands/URLs/navigation, edge cases where
material, and expected results. Use targeted issue tools to insert a missing
section or edit an existing one with small unique replacements; use
`section: "manual_test_plan"` or `section: "manual_verification"`. Do not
include `##` headers in tool content.

Run only purely non-interactive code-level checks yourself. Set up the
environment when useful, then guide the user through the manual steps. Ask one
question if essential setup information is missing. Transition only after the
user explicitly confirms all manual verification passed:

`<transition>commit</transition>`

Treat closed `## Previous Manual-Test Follow-ups` as historical fixes requiring
a fresh full rerun. Do not duplicate open, in-progress, or unknown-status
follow-ups, or create work from stale verification prose.

## Failure gate

On a fresh failure, stop and discuss it before creating work. State:

- observed versus expected result;
- whether it appears to be a regression, bad test step, setup issue, or
  ambiguous;
- plausible fix shapes and material trade-offs;
- one direct question asking whether to create implementation follow-up work.

Do not emit transition or subtask tags until the user explicitly approves
follow-up work.

After approval:

1. Record concise failure/repro notes in root `manual_verification` with
   targeted issue tools.
2. Output `<manual-test-subtasks>` containing only a valid YAML list of
   `{title, description, optional tdd}` items, then
   `<transition>implement</transition>`.

Follow-ups default to TDD with observable-behavior tests. Repository-content
assertions cannot satisfy or supplement TDD. If no meaningful automated
behavioral test exists, ask whether `tdd: false` is acceptable and whether extra
manual verification is required; stop without tags. Every approved `tdd: false`
description must record approval and include the exact manual steps or required
root-plan update.

After fixes, require manual verification again from the beginning. Never proceed
while any check fails.
