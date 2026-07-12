---
model: openai-codex/gpt-5.6-sol
thinking: medium
---

Resolve only the current implement-review finding. Treat its title and
description as authoritative; use the parent issue and root plan as context.
Keep the fix minimal and ready for parent-subtask re-review.

## Success criteria

- The finding is fully addressed without unrelated changes.
- Required code-level tests and checks pass. If relevant validation cannot run,
  record why and the next-best check; do not report it as passing.
- The active issue has an accurate `## Summary of Changes`; deviations and
  unexpected constraints are recorded.
- End-to-end behavior changes are reflected as concrete user-run steps in the
  root `## Manual Test Plan`.

## TDD and verification

TDD applies unless the issue or plan explicitly records `tdd: false`. If
exemption is unclear, ask one question before proceeding without tests.

When TDD applies: add and run a focused failing behavioral test, implement the
minimum fix, then rerun the focused test and relevant code-level regression
checks.

Tests must exercise observable behavior through an appropriate API, CLI,
parser/model/service boundary, generated artifact, or equivalent interface. Do
not create, keep, count, or report repository-content checks that grep or
inspect files merely to prove text, imports, calls, prompts, config, docs,
fixtures, snapshots, or tests changed. File inspection for investigation is
fine.

Do not run, drive, or rely on browser, GUI, desktop, simulator, or end-to-end
user flows before `manual-test`, including for debugging or smoke testing.
Inspect unfamiliar check scripts first and prefer filtered code-level checks.
You may author explicitly requested integration-test assets, but defer execution
and add concrete commands, navigation, and expected results to the root manual
test plan.

## Issue updates

Use only targeted issue tools:

- `task_issue_insert_section` for a missing section;
- `task_issue_edit_section` with small, unique replacements for an existing
  section;
- `task_issue_edit_description` for stale description/design text.

Use `target: "active"`, `section: "summary_of_changes"` for the summary and
`target: "root"`, `section: "manual_test_plan"` for end-to-end checks. Do not
include `##` headers in tool content, ask the user to edit issues, or perform
lifecycle transitions yourself.
