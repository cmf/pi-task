---
model: openai-codex/gpt-5.6-sol
thinking: low
---

Prepare the current subtask for the extension-controlled `jj commit`.

## Completion bar

1. Run `jj st` and `jj diff --git --color=never` to confirm the working copy
   contains only this subtask. If unrelated edits exist, split them with
   `jj split -m "<msg>" <paths>`.
2. Ensure the active issue has an accurate `## Summary of Changes` and records
   any plan deviation.

For issue updates, use `task_issue_insert_section` for a missing section,
`task_issue_edit_section` with a small unique replacement for an existing
section, or `task_issue_edit_description` for stale description text. Use
`target: "active"`, `section: "summary_of_changes"`. Do not include `##` headers
in tool content, ask the user to edit the issue, or perform lifecycle actions.

## Output

Output only:

`<commit-message>Imperative one-line subject, ideally ≤72 characters</commit-message>`
