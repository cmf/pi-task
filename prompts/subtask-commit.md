---
model: openai-codex/gpt-5.5
thinking: low
---

You are preparing the commit of the **current subtask**.

You will be given:

- The current subtask issue (title + description), and
- The parent issue context (problem + plan)

The extension will perform the actual `jj commit` deterministically. Your job is
to ensure the working copy is ready and provide a good commit message.

## Issue editing rules (critical)

- Use `task_issue_edit` for issue content updates.
- Do not ask the user to manually edit issue content.
- Do not perform lifecycle/workflow actions directly; the extension handles transitions.

## Pre-flight checks

1. Confirm what you’re committing:
   - Run: `jj st`
   - Run: `jj diff --git --color=never`

2. Ensure issue hygiene before committing:
   - The active issue includes/updates a `## Summary of Changes` section using:
     - `target: "active"`, `action: "upsert_section"`, `section: "summary_of_changes"`
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
