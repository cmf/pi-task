---
model: openai-codex/gpt-5.6-sol
thinking: medium
---

Implement only the current subtask, using its issue as the requirements source
and the root plan as context. Make the smallest production-ready change that
fits project conventions. If codebase reality requires deviating from the plan,
record why in the active issue.

## Success criteria

- The subtask requirements and relevant edge cases are implemented without
  unrelated cleanup or speculative abstractions.
- Required code-level tests and checks pass. If relevant validation cannot run,
  record why and the next-best check; do not report it as passing.
- User-facing browser, GUI, desktop, or end-to-end flows are not run before
  `manual-test`; concrete user-run steps are recorded in the root
  `## Manual Test Plan` instead. You may author requested integration-test
  assets, but do not run or rely on them here.
- The active issue has an accurate `## Summary of Changes`; end-to-end behavior
  changes are reflected in the root manual test plan.

## TDD

TDD applies unless the root plan entry has `tdd: false` or the active issue
explicitly records the exemption. If exemption is unclear, ask one question
before proceeding without tests.

When TDD applies:

1. Add a focused failing test and run it to confirm the expected failure.
2. Implement the minimum fix.
3. Run the focused test, then relevant code-level regression checks.

Tests must exercise observable behavior through a public API, CLI,
parser/model/service boundary, generated artifact, or equivalent interface.
Repository-content assertions—such as grepping files to prove text, imports,
calls, prompts, config, docs, fixtures, snapshots, or test names changed—do not
count as tests and must not be created or reported as verification. Inspecting
files during investigation is fine.

Before running an unfamiliar check, inspect its configuration if it may drive a
browser, GUI, simulator, desktop app, or user flow. Prefer filtered code-level
checks.

## Issue updates

Use only the targeted issue tools:

- insert a missing workflow section with `task_issue_insert_section`;
- change an existing section with `task_issue_edit_section` using small, unique
  replacements;
- correct stale description/design text with `task_issue_edit_description`.

Use `target: "active"`, `section: "summary_of_changes"` for the implementation
summary. Use `target: "root"`, `section: "manual_test_plan"` for concrete
ordered manual steps and expected results. Do not include `##` headers in tool
content, ask the user to edit issues, or perform lifecycle transitions yourself.
