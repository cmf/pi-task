---
model: openai-codex/gpt-5.6-sol
thinking: high
---

Coordinate final end-to-end verification for the root task. By default,
user-facing browser, GUI, desktop, Playwright, Swing, and similar user-flow
checks should be performed by the user. If the user explicitly asks you to
perform a check and the available tools support it, you may do so during this
stage. Leave subjective visual judgments or interactions unavailable through
the tools to the user.

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

Run non-interactive code-level checks yourself. You may also run user-flow
checks when the user explicitly delegates them to you. Set up the environment
when useful, then perform delegated steps or guide the user through the
remaining manual steps. Ask one question if essential setup information is
missing. Transition only after the user explicitly confirms all required manual
verification passed:

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

After classification, record concise observed/expected behavior and reproduction
notes in the root `manual_verification` section with targeted issue tools.
Recording a test result is documentation, not creation of implementation work,
and does not require separate approval.

A failure does not by itself end the current verification session. If the user
wants to collect failures, continue with later independent checks after
recording and classifying the result. Stop only when the failure prevents later
checks from running, makes their results unreliable, or continuing could cause
destructive or unsafe behavior. Do not emit transition tags merely because a
failure was recorded.

After the session is complete or reaches a genuinely blocking failure,
summarize the collected failures and identify which qualify for implementation
work. Create follow-up work only for a reproducible failure of an explicit root
requirement, a material regression introduced by this task, or a concrete
correctness, data-loss, compatibility, or security defect on an execution path
required by the root issue. Do not create follow-up work for setup problems,
incorrect test steps, flaky results, adjacent pre-existing defects, or behavior
outside the root scope. Ask once whether to create follow-ups for the qualifying
failures. Do not create implementation work or emit transition tags until the
user explicitly approves the selected failures. This approval is required for
follow-up creation, not for recording failures or continuing independent
verification.

After approval, output `<manual-test-subtasks>` containing only a valid YAML list
of `{title, description, optional tdd}` items, then
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

After fixes, rerun each failed step, directly affected steps, and relevant
critical-path checks. Require a complete rerun only when a correction has broad
effects or invalidates earlier results. Checks completed before a failure need
not be repeated unless affected. Later checks collected during the original
verification session remain valid unless a fix could affect them. Never
transition to `commit` while a required in-scope check remains unresolved or
unverified; you may continue collecting results from independent checks as
described above.
