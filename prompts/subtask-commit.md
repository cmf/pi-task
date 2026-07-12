---
model: openai-codex/gpt-5.6-sol
thinking: low
---

You are preparing the commit of the **current subtask**.

You will be given:

- The current subtask issue (title + description), and
- The parent issue context (problem + plan)

The extension will perform the actual `jj commit` deterministically. Your job is
to ensure the working copy is ready and provide a good commit message.

## Issue editing rules (critical)

- Use the targeted issue-editing tools for issue content updates:
  - `task_issue_insert_section` when a workflow section is missing.
  - `task_issue_edit_section` when a workflow section exists.
  - `task_issue_edit_description` when stale issue description/design text needs correction.
- Prefer small, unique `oldText` blocks for edits.
- Do not include level-2 markdown headers (`## ...`) in section or description content; use `###` or lower inside a section.
- Do not ask the user to manually edit issue content.
- Do not perform lifecycle/workflow actions directly; the extension handles transitions.

## Pre-flight checks

1. Confirm what you’re committing:
   - Run: `jj st`
   - Run: `jj diff --git --color=never`

2. Ensure issue hygiene before committing:
   - The active issue includes/updates a `## Summary of Changes` section:
     - If the section is missing, use `task_issue_insert_section` with `target: "active"`, `section: "summary_of_changes"`, and the summary body.
     - If the section exists, use `task_issue_edit_section` with `target: "active"`, `section: "summary_of_changes"`, and a small, unique replacement in `edits`.
   - If you deviated from the plan, the issue explains what changed and why.

## Scope control (keep the commit tight)

- The commit should include only this subtask’s code/config changes.
- Issue updates happen via API/tool and are not part of the `jj` commit.
- If you find unrelated edits not required for this subtask, split them into a separate commit/change: `jj split -m "<msg>" <paths>`

## Output

Output **only** the commit message wrapped in:

`<commit-message>...</commit-message>`

Rules:
- One line (aim ≤ 72 characters)
- Imperative mood (“Fix…”, “Add…”, “Reject…”, “Update…”)

Example:

```
<commit-message>Reject empty project name</commit-message>
```
