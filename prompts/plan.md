---
model: openai-codex/gpt-5.6-sol
thinking: high
---

Create the smallest executable implementation plan for the root issue. Treat
the root issue as the authoritative scope and inspect relevant project state
before planning. Split work only where changes are independently deliverable and
reviewable; avoid investigation-only tasks, copied requirements, repeated
boilerplate, speculative architecture, and tiny internal-step subtasks. Include
dependencies, state or data flow, failure behavior, and migration or security
constraints only when explicitly required by the issue or necessarily affected
by the change. Do not add generic production-readiness work. If an unresolved
decision affects implementation, ask one question and stop.

## Subtask contract

Each YAML item must contain:

- `title`: single-line string
- `description: |`: concise behavioral change, exact paths, focused test and
  command with expected result, and only essential implementation notes
- optional `tdd`: defaults to `true`; use `false` only after explicit user
  approval

For TDD subtasks, specify a small red-green loop using observable behavior
through an API, CLI, parser/model/service boundary, generated artifact, or
equivalent interface. Repository-content checks that grep or inspect files
merely to prove text, imports, calls, prompts, config, docs, fixtures,
snapshots, or tests changed cannot satisfy TDD. If no meaningful behavioral test
exists, ask whether to use `tdd: false` and whether extra manual verification is
needed; stop without editing or transitioning.

User-facing browser, GUI, desktop, or end-to-end automation belongs in the root
manual test plan, not implementation verification. Prefer lower-level tests. If
only a user-flow test is meaningful, request `tdd: false`. A `tdd: false`
subtask must record user approval, require the minimum implementation, and add
concrete manual verification. Requested integration-test assets may be authored
during implementation but must not be run before `manual-test`.

## Required issue content

Prepare:

```md
<subtasks>
- title: "..."
  description: |
    - Add a failing behavioral test in `exact/path`.
    - Run: `exact command` — expected to fail for the missing behavior.
    - Implement the minimum change in `exact/path`.
    - Run: `exact command` — expected to pass.
</subtasks>
```

Also prepare a concise root `## Manual Test Plan` body with ordered user-visible
steps, commands/URLs/navigation where relevant, and expected results. Cover
explicit user-visible requirements and critical paths, not exploratory
scenarios, internal invariants, adversarial conditions better covered by
automated tests, or every permutation. If no meaningful user-facing check
exists, state that briefly and name the automated verification instead.

Persist both root sections with targeted tools:

- missing section: `task_issue_insert_section`;
- existing section: `task_issue_edit_section` with small, unique replacements.

Use `section: "plan"` for the body containing `<subtasks>...</subtasks>` and
`section: "manual_test_plan"` for manual steps. Do not include `##` headers in
tool content, replace more text than needed, or ask the user to edit the issue.

After both sections are persisted, output
`<transition>review-plan</transition>`.
