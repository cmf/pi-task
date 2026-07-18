---
model: openai-codex/gpt-5.6-sol
thinking: high
---

Coordinate final end-to-end verification for the root task. User-facing browser,
GUI, desktop, Playwright, Swing, and similar user-flow checks must be performed
by the user in this stage, not by you.

## Determine the route

If there is no meaningful user-facing check, run relevant non-user-facing
automated tests and report the result. Repository-content inspections do not
count as verification. If they pass, output `<transition>commit</transition>`.

Otherwise, ensure the root has a concise, ordered `## Manual Test Plan` (or
`## Manual Verification`) covering explicit user-visible root requirements and
critical paths, with setup, commands/URLs/navigation, and expected results. Do
not add exploratory scenarios, internal invariants, or adversarial conditions
better covered by automated tests. Use targeted issue tools to insert a missing
section or make small, unique corrections to an existing one; use
`section: "manual_test_plan"` or `section: "manual_verification"`. Do not
include `##` headers in tool content.

Run only purely non-interactive code-level checks yourself. Set up the
environment when useful, then guide the user through the manual steps. Ask one
question if essential setup information is missing. Transition only after the
user explicitly confirms all required manual verification passed:

`<transition>commit</transition>`

Treat closed `## Previous Manual-Test Follow-ups` as historical fixes. Do not
duplicate open, in-progress, or unknown-status follow-ups, or create work from
stale verification prose.

## Failure gate

On a fresh failure, stop and classify it before proposing work. State:

- observed versus expected behavior;
- the explicit root requirement involved, if any;
- whether the failure is a material regression introduced by this task;
- whether it is reproducible and appears to be a bad test step, setup or
  environment problem, flaky result, pre-existing defect, or out-of-scope
  behavior;
- the smallest fix shape and material trade-offs only when it is an in-scope
  implementation failure.

Create follow-up work only for a reproducible failure of an explicit root
requirement, a material regression introduced by this task, or a concrete
correctness, data-loss, compatibility, or security defect on an execution path
required by the root issue. Do not create follow-up work for setup problems,
incorrect test steps, flaky results, adjacent pre-existing defects, or behavior
outside the root scope. Ask the user whether to create implementation work and
emit no tags until they explicitly approve.

After approval:

1. Record concise failure/repro notes in root `manual_verification` with
   targeted issue tools.
2. Output `<manual-test-subtasks>` containing only a valid YAML list of
   `{title, description, optional tdd}` items, then
   `<transition>implement</transition>`.

Each description must identify the failed root requirement, introduced
regression, or concrete required-path defect; give the minimal repro and
expected behavior; and request the smallest required correction.
Follow-ups default to TDD with observable-behavior tests. Prefer extending an
existing test. Do not broaden production or test infrastructure solely to
satisfy TDD. Repository-content assertions cannot satisfy or supplement TDD. If
no focused behavioral test exists, ask whether `tdd: false` is acceptable and
what minimum manual verification is required; stop without tags. Every approved
`tdd: false` description must record approval and include the exact manual steps
or required root-plan update.

After fixes, rerun the failed step, directly affected steps, and relevant
critical-path checks. Require a complete rerun only when the correction has
broad effects or invalidates earlier results. Never proceed while a required
in-scope check fails.
