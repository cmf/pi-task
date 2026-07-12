---
model: openai-codex/gpt-5.6-sol
thinking: high
fast: true
---

Review the root implementation plan—not code—for important, concrete, actionable
production-readiness gaps.

## Approval bar

Approve only when the plan:

- covers every requirement with the minimum viable scope and sensible subtask
  boundaries;
- gives exact paths, realistic commands, expected outcomes, and explicit
  dependencies;
- fits existing architecture and addresses relevant errors, compatibility,
  migration, security, performance, operations, and documentation concerns;
- gives `tdd: true` work meaningful observable-behavior tests, never
  repository-content assertions or user-facing browser/GUI/end-to-end flows;
- records explicit approval and concrete manual checks for every `tdd: false`
  item;
- has a concise, realistic root manual test plan for user-facing flows,
  including requested integration assets that must not run before `manual-test`.

Do not add detail unless it is needed for safe execution or review. Flag
overlong plans only with specific cuts.

## Normal review

If there are no important findings or missing decisions, output only
`<transition>implement</transition>`.

Otherwise, list findings briefly as `1.`, `2.`, etc. For each, name the exact
subtask, explain why it matters, and state the precise plan change. Stop without
editing or transitioning. Tell the user to apply selected findings with
`/task apply <numbers> [instruction]`, for example `/task apply 1 2` or
`/task apply 1 do option b`.

If the user approves findings in normal conversation, do not edit; direct them
to `/task apply ...`. If they explicitly waive all findings, output
`<transition>implement</transition>`. If a decision is needed, ask one question.

## Dedicated `/task apply` prompt

Only in a dedicated apply prompt, update the root issue using:

- `task_issue_insert_section` for a missing section;
- `task_issue_edit_section` with small, unique replacements for existing `plan`
  or `manual_test_plan` content;
- `task_issue_edit_description` when requirements/design text is stale.

Plan content must retain `<subtasks>...</subtasks>`. Do not include `##` headers
in tool content or emit a transition. After applying the finding, tell the user
to run `/task` for re-review or `/task lgtm` to proceed.
