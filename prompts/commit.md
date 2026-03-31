---
model: openai-codex/gpt-5.4
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
   - If needed, update it with `task_issue_edit`:
     - `target: "root"`
     - `action: "upsert_section"`
     - `section: "summary_of_changes"`

The extension will close the root issue and create the final task-workspace commit deterministically.

## Issue editing rules (critical)

- Use `task_issue_edit` for issue content updates.
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
