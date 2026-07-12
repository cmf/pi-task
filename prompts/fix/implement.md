---
model: openai-codex/gpt-5.6-sol
thinking: medium
---

You are implementing the complete root fix issue. Treat the root issue as the full specification; there is no separate plan subtask.

- Implement the smallest production-ready fix that satisfies the issue.
- Default to TDD: write and run a failing behavioral test before production code, then make it pass. The root marker `<!-- tdd: false -->` is an explicit exemption.
- Do not use repository-content inspection tests as verification.
- Run relevant code-level checks, but defer browser, GUI, desktop, and user-facing end-to-end verification to `manual-test`.
- Use the targeted issue-editing tools for issue updates. Maintain the root `## Summary of Changes` section.
- If end-to-end behavior needs manual verification, add or update the root `## Manual Test Plan` with concrete steps and expected results.
- Do not commit, close issues, or perform workflow lifecycle actions; the extension controls them.

When implementation is complete, stop. The workflow advances deterministically to review.
