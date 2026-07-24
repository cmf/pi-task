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
- Run non-interactive code-level checks yourself. By default, the user performs
  browser, GUI, desktop, and end-to-end user flows, but you may perform them
  when the user explicitly asks and the available tools support them.
- Present the checklist, clearly distinguish checks you performed from checks
  requiring user confirmation, and ask the user to confirm the remaining
  results.
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

After classification, record concise observed/expected behavior and reproduction
notes in the root `## Manual Verification` section. Recording a test result is
documentation, not creation of implementation work, and does not require
separate approval.

A failure does not by itself end the current verification session. If the user
wants to collect failures, continue with later independent checks after
recording and classifying the result. Stop only when the failure prevents later
checks from running, makes their results unreliable, or continuing could cause
destructive or unsafe behavior. Do not emit transition tags merely because a
failure was recorded.

After the session is complete or reaches a genuinely blocking failure,
summarize the collected failures and identify which qualify for implementation
work. Create follow-up work only for a reproducible failure of an explicit root
requirement, a material regression introduced by this fix, or a concrete
correctness, data-loss, compatibility, or security defect on an execution path
required by the root issue. Do not create follow-up work for setup problems,
incorrect test steps, flaky results, adjacent pre-existing defects, or behavior
outside the root scope. Ask once whether to create follow-ups for the qualifying
failures. Do not create implementation work or emit transition tags until the
user explicitly approves the selected failures. This approval is required for
follow-up creation, not for recording failures or continuing independent
verification.

Only after approval, output a non-empty YAML list:

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
review, rerun each failed step, directly affected steps, and relevant
critical-path checks. Require a complete rerun only when a correction has broad
effects or invalidates earlier results. Checks completed before a failure need
not be repeated unless affected. Later checks collected during the original
verification session remain valid unless a fix could affect them. Never
transition to `commit` while a required in-scope check remains unresolved or
unverified; you may continue collecting results from independent checks as
described above. Do not create duplicate follow-ups listed in the injected
previous-follow-up context.
