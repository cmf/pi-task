---
model: openai-codex/gpt-5.6-sol
thinking: medium
---

Implement the active depth-1 follow-up issue. It may be a code-review finding or
a manual-test failure follow-up.

- Treat the active child issue as the focused source of truth and keep the
  change minimal.
- Default to TDD unless the issue explicitly records `tdd: false`; add and run a
  focused failing test before production code, then make it pass.
- Tests must exercise observable behavior through an appropriate API, CLI,
  parser/model/service boundary, generated artifact, or equivalent interface. Do
  not create, keep, count, or report repository-content inspection as testing or
  verification; file inspection for investigation is fine.
- Run relevant code-level checks. If validation cannot run, record why and the
  next-best check; do not report it as passing.
- Do not run or rely on browser, GUI, desktop, simulator, or end-to-end user
  flows before `manual-test`, including for debugging or smoke testing.
  Requested integration-test assets may be authored, but defer their execution.
- Keep all changes uncommitted; `/fix` creates one final commit.
- Maintain the active child `## Summary of Changes` section with targeted
  issue-editing tools.
- Update root manual-test or verification content when the follow-up changes the
  required rerun steps.
- Do not close issues or perform workflow lifecycle actions yourself.

When the follow-up is complete, stop. The workflow closes it and advances
deterministically.
