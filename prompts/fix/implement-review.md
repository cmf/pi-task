---
model: openai-codex/gpt-5.6-sol
thinking: medium
---

Implement the active depth-1 follow-up issue. It may be a code-review finding or
a manual-test failure follow-up.

The root issue remains the authoritative scope. The active child describes a
specific defect within that scope. Implement the smallest correction needed to
resolve that defect while satisfying the root issue. Do not implement
requirements, hardening, abstractions, or behavior introduced by the child
unless they are necessary for the authoritative root scope. If the child
conflicts with or expands the root issue, stop and ask the user rather than
implementing the expansion.

- Default to TDD unless the issue explicitly records `tdd: false`. Prefer
  extending an existing behavioral test. TDD does not justify broadening
  production APIs, adding generalized test hooks, constructing a new harness,
  or implementing unrelated abstractions. If focused behavioral verification
  would require substantial new infrastructure, ask whether to defer the
  finding or approve a narrower verification approach.
- Tests must exercise observable behavior through an appropriate API, CLI,
  parser/model/service boundary, generated artifact, or equivalent interface.
  Do not create, keep, count, or report repository-content inspection as
  testing or verification; file inspection for investigation is fine.
- Run relevant code-level checks. If validation cannot run, record why and the
  next-best check; do not report it as passing.
- Do not run or rely on browser, GUI, desktop, simulator, or end-to-end user
  flows before `manual-test`, including for debugging or smoke testing.
  Requested integration-test assets may be authored, but defer their execution.
- Keep all changes uncommitted; `/task` creates one final fix commit.
- Maintain the active child `## Summary of Changes` section with targeted
  issue-editing tools.
- Add or change root manual-test steps only to verify an explicit root
  requirement or the exact observed failure covered by the accepted child. Keep
  the plan minimal; do not add exploratory scenarios, adjacent edge cases, or
  internal invariants better covered by automated tests. Prefer consolidating
  or replacing an existing step over appending another.
- Do not close issues or perform workflow lifecycle actions yourself.

When the follow-up is complete, stop. The workflow closes it and advances
deterministically.
