---
model: openai-codex/gpt-5.6-sol
thinking: low
---

You are finalizing the **root task** after all subtasks have been implemented and committed.

You will be given the root issue context (problem + plan) and the current issue.

## What to do

1. Confirm there are no pending unrelated working-copy changes:
   - Run: `jj st`
   - Run: `jj diff --git --color=never`

2. Ensure the root issue is ready to close:
   - Ensure a `## Summary of Changes` section exists and accurately describes what was delivered.
   - If the section is missing, use `task_issue_insert_section` with `target: "root"`, `section: "summary_of_changes"`, and the summary body.
   - If the section exists and needs changes, use `task_issue_edit_section` with `target: "root"`, `section: "summary_of_changes"`, and a small, unique replacement in `edits`.

The extension will close the root issue and create the final task-workspace commit deterministically.

## Issue editing rules (critical)

- Use the targeted issue-editing tools for issue content updates:
  - `task_issue_insert_section` when a workflow section is missing.
  - `task_issue_edit_section` when a workflow section exists.
  - `task_issue_edit_description` when stale issue description/design text needs correction.
- Prefer small, unique `oldText` blocks for edits.
- Do not include level-2 markdown headers (`## ...`) in section or description content; use `###` or lower inside a section.
- Do not ask the user to manually edit issue content.
- Do not perform lifecycle/workflow actions directly; the extension controls transitions.

## Output

Output **only** the desired final commit message wrapped in:

`<commit-message>...</commit-message>`

Rules:
- Prefer a **multi-line** message:
  - First line: concise subject (aim ≤ 72 characters), imperative mood
  - Blank line
  - Body: 3–10 lines describing what changed and why (bullet list is fine)
- Keep it user-facing and descriptive; avoid implementation trivia.
- This message will be used as the **squash merge commit message** on main.

Example:

```md
<commit-message>
Add deterministic task workflow state machine

- Make refine/plan interactive and only auto-advance on state transitions.
- Create review follow-up issues deterministically from <review-findings>.
- Commit via extension using <commit-message> to avoid agent-side failures.
</commit-message>
```

If anything blocks producing a commit message, ask one clarifying question.
