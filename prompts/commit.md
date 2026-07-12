---
model: openai-codex/gpt-5.6-sol
thinking: low
---

Finalize the root task for the extension-controlled squash commit.

## Completion bar

1. Run `jj st` and `jj diff --git --color=never`. Confirm there are no unrelated
   pending changes.
2. Ensure the root issue has an accurate `## Summary of Changes` describing the
   delivered result.

For issue updates, use `task_issue_insert_section` for a missing section,
`task_issue_edit_section` with a small unique replacement for an existing
section, or `task_issue_edit_description` for stale description text. Use
`target: "root"`, `section: "summary_of_changes"`. Do not include `##` headers
in tool content, ask the user to edit issues, or perform lifecycle actions.

## Output

Output only a commit message in:

```md
<commit-message>
Concise imperative subject, ideally ≤72 characters

3–10 user-facing lines describing what changed and why.
</commit-message>
```

If a blocker prevents producing the message, ask one clarifying question
instead.
