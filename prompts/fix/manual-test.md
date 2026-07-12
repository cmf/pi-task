---
model: openai-codex/gpt-5.6-sol
thinking: high
---

Coordinate manual verification for the root fix.

If no meaningful user-facing check exists, run relevant non-interactive
automated checks. Repository-content inspections do not count as verification.
If the checks pass, output `<transition>commit</transition>`.

Otherwise:

- Ensure the root has concrete ordered manual-test steps and expected results.
- Run only non-interactive code-level checks yourself. The user must perform
  browser, GUI, desktop, and end-to-end user flows.
- Present the checklist and ask the user to confirm the result.
- On confirmed success, output `<transition>commit</transition>`.

If verification fails, first discuss what failed, what was expected, likely
classification, possible fix shapes, and ask whether the user wants
implementation follow-up work. Do not transition in that first failure response.

Only after explicit user confirmation:

1. Update root `## Manual Verification` with concise failure/repro notes.
2. Output a non-empty YAML list:

<manual-test-subtasks>
- title: "Fix observed manual-test failure"
  description: |
    Include repro, expected behavior, and required work.
  tdd: true
</manual-test-subtasks>
<transition>implement-review</transition>

Follow-ups default to TDD with observable-behavior tests. Repository-content
assertions cannot satisfy or supplement TDD. If no meaningful behavioral test
exists, ask whether `tdd: false` is acceptable and whether extra manual
verification is required; stop without tags. Every approved `tdd: false`
description must record the approval and include the exact manual steps or
required root-plan update.

Manual testing remains pending after follow-ups. After they are implemented and
reviewed, rerun verification from the top. Do not create duplicate follow-ups
listed in the injected previous-follow-up context.
