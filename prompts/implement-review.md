---
model: openai-codex/gpt-5.6-sol
thinking: medium
---

Resolve only the current implement-review finding. The root issue and approved
root plan remain the authoritative scope. The parent subtask describes its
assigned portion of that plan, and the active finding describes a specific
defect within that portion; neither child issue creates requirements
independently.

Implement the smallest correction needed to resolve the defect while satisfying
the assigned root-plan requirements. Do not implement requirements, hardening,
architectural changes, or behavior introduced by a child issue unless they are
necessary for the authoritative root scope. If the finding or parent subtask
conflicts with or expands that scope, stop and ask the user rather than
implementing the expansion.

## Success criteria

- The finding is fully addressed without unrelated changes.
- Required code-level tests and checks pass. If relevant validation cannot run,
  record why and the next-best check; do not report it as passing.
- The active issue has an accurate `## Summary of Changes`; deviations and
  unexpected constraints are recorded.
- Manual-test content changes are limited to explicit root requirements or the
  exact accepted finding.

## TDD and verification

TDD applies unless the issue or plan explicitly records `tdd: false`. Prefer
extending an existing behavioral test. TDD does not justify broadening
production APIs, adding generalized test hooks, constructing a new harness, or
implementing unrelated abstractions. If focused behavioral verification would
require substantial new infrastructure, ask whether to defer the finding or
approve a narrower verification approach.

When TDD applies: add and run a focused failing behavioral test, implement the
minimum fix, then rerun the focused test and relevant code-level regression
checks.

Tests must exercise observable behavior through an appropriate API, CLI,
parser/model/service boundary, generated artifact, or equivalent interface. Do
not create, keep, count, or report repository-content checks that inspect files
merely to prove text, imports, calls, prompts, config, docs, fixtures, snapshots,
or tests changed. File inspection for investigation is fine.

Do not run, drive, or rely on browser, GUI, desktop, simulator, or end-to-end
user flows before `manual-test`, including for debugging or smoke testing.
Requested integration-test assets may be authored, but defer execution.

## Issue updates

Use only targeted issue tools:

- `task_issue_insert_section` for a missing section;
- `task_issue_edit_section` with small, unique replacements for an existing
  section;
- `task_issue_edit_description` for stale description/design text.

Use `target: "active"`, `section: "summary_of_changes"` for the summary. Add or
change root manual-test steps only to verify an explicit root requirement or the
exact accepted finding. Keep the plan minimal; do not add exploratory scenarios,
adjacent edge cases, or internal invariants better covered by automated tests.
Prefer consolidating or replacing an existing step over appending another. Do
not include `##` headers in tool content, ask the user to edit issues, or perform
lifecycle transitions yourself.
