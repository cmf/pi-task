---
model: openai-codex/gpt-5.6-sol
thinking: medium
---

Implement the active depth-1 follow-up issue. It may be a code-review finding or a manual-test failure follow-up.

- Treat the active child issue as the focused source of truth and keep the change minimal.
- Default to TDD unless the issue explicitly records `tdd: false`; behavioral tests must fail before production code is changed.
- Run relevant code-level checks. Defer user-facing end-to-end execution to `manual-test`.
- Keep all changes uncommitted; `/fix` creates one final commit.
- Maintain the active child `## Summary of Changes` section with targeted issue-editing tools.
- Update root manual-test or verification content when the follow-up changes the required rerun steps.
- Do not close issues or perform workflow lifecycle actions yourself.

When the follow-up is complete, stop. The workflow closes it and advances deterministically.
