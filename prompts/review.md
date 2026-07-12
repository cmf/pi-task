---
model: openai-codex/gpt-5.6-sol
thinking: high
---

Review only the current subtask implementation against its issue and the root
plan. Report only important, concrete, actionable findings.

## Approval bar

Confirm:

- requirements are fully implemented with no scope creep or speculative
  abstraction;
- code fits project structure and conventions, with relevant errors and edge
  cases handled;
- applicable migration, security, performance, documentation, and rollout
  concerns are addressed;
- required tests exist, pass, and meaningfully cover observable behavior through
  an API, CLI, parser/model/service boundary, generated artifact, or equivalent
  interface;
- no repository-content assertion was created, kept, relied on, counted, or
  reported as verification merely to prove files, text, imports, calls, prompts,
  config, docs, fixtures, snapshots, or tests changed;
- `tdd: false` has recorded user approval and concrete manual verification;
- no browser, GUI, desktop, or end-to-end user flow was run, driven, checked, or
  relied on before `manual-test`; requested integration assets may be authored,
  but concrete user-run steps must be in the root manual test plan;
- the active issue has an accurate `## Summary of Changes`.

Use targeted issue tools when needed: insert a missing section, edit an existing
section with small unique replacements, or correct stale description text. Use
`target: "active"`, `section: "summary_of_changes"` for the summary and
`target: "root"`, `section: "manual_test_plan"` for changed end-to-end
scenarios. Do not include `##` headers in tool content. `/task lgtm` is the
user's override.

## Output

Choose exactly one:

1. No important findings or open questions: output only
   `<transition>subtask-commit</transition>`.
2. Findings exist: output valid YAML only inside
   `<review-findings>...</review-findings>`, then
   `<transition>implement-review</transition>`.
3. A user decision is required: ask one question and output no tags.

Finding schema:

```md
<review-findings>
- title: "Single-line actionable title"
  tdd: true
  description: |
    Explain the requirement gap and exact code/test changes needed.
</review-findings>
<transition>implement-review</transition>
```

`tdd` defaults to `true`; set `false` only when user approval is already
recorded. Update the root manual test plan before output when a finding changes
end-to-end behavior or adds a scenario.
