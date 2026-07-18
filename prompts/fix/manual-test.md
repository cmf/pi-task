---
model: openai-codex/gpt-5.6-sol
thinking: high
---

Coordinate manual verification for the root fix.

If no meaningful user-facing check exists, run relevant non-interactive
automated checks. Repository-content inspections do not count as verification.
If the checks pass, output `<transition>commit</transition>`.

Otherwise:

- Ensure the root has concrete ordered manual-test steps for explicit
  user-visible root requirements and critical paths. Do not add exploratory
  scenarios, internal invariants, or adversarial conditions better covered by
  automated tests.
- Run only non-interactive code-level checks yourself. The user must perform
  browser, GUI, desktop, and end-to-end user flows.
- Present the checklist and ask the user to confirm the result.
- On confirmed success, output `<transition>commit</transition>`.

If verification fails, stop and classify the fresh failure before proposing
work. State:

- observed versus expected behavior;
- the explicit root requirement involved, if any;
- whether the failure is a material regression introduced by this fix;
- whether it is reproducible and appears to be a bad test step, setup or
  environment problem, flaky result, pre-existing defect, or out-of-scope
  behavior;
- the smallest fix shape and material trade-offs only when it is an in-scope
  implementation failure.

Create follow-up work only for a reproducible failure of an explicit root
requirement, a material regression introduced by this fix, or a concrete
correctness, data-loss, compatibility, or security defect on an execution path
required by the root issue. Do not create follow-up work for setup problems,
incorrect test steps, flaky results, adjacent pre-existing defects, or behavior
outside the root scope. Ask the user whether to create implementation work and
emit no tags until they explicitly approve.

Only after approval:

1. Update root `## Manual Verification` with concise failure/repro notes.
2. Output a non-empty YAML list:

<manual-test-subtasks>
- title: "Fix observed manual-test failure"
  description: |
    Identify the failed root requirement, introduced regression, or concrete
    required-path defect; give the minimal repro and expected behavior; and
    request the smallest required correction.
  tdd: true
</manual-test-subtasks>
<transition>implement-review</transition>

Follow-ups default to TDD with observable-behavior tests. Prefer extending an
existing test. Do not broaden production or test infrastructure solely to
satisfy TDD. Repository-content assertions cannot satisfy or supplement TDD. If
no focused behavioral test exists, ask whether `tdd: false` is acceptable and
what minimum manual verification is required; stop without tags. Every approved
`tdd: false` description must record the approval and include the exact manual
steps or required root-plan update.

Manual testing remains pending after follow-ups. After implementation and
review, rerun the failed step, directly affected steps, and relevant
critical-path checks, as well as any remaining tests subsequent to the failing 
case. Require a complete rerun only when the correction has
broad effects or invalidates earlier results. Do not create duplicate follow-ups
listed in the injected previous-follow-up context.
