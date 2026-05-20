# TDD workflow design discussion

## Context

We compared our task extension to CodeLeash’s TDD guard.

CodeLeash uses a log-derived micro-state machine:

- `initial`
- `writing_tests`
- `red`
- `making_tests_pass`

Their strongest idea is not just the states, but enforced workflow:

- declared Red/Green
- automatic test result logging
- edit gating based on current TDD phase
- append-only log as audit/state source

## Main design question

Whether to integrate TDD as:

1. auxiliary state/evidence under our existing task states, or
2. explicit states in our task workflow

## Initial conclusion

TDD should not replace the main task workflow.

- `.tasks/workflow.json` should remain the canonical macro-state snapshot
- append-only logs are useful for TDD evidence/audit, but not as the sole source of truth for the whole task machine

## Shift in design direction

The discussion shifted toward explicit TDD states as a better fit for our system, because they create:

- separate context windows
- separate prompts
- deterministic extension-owned test execution
- a dedicated review pass for tests before implementation

## Proposed TDD states

- `implement-test`
- `review-tests`
- `implement-test-review`

## Proposed flow for `tdd: true` subtasks

- `review-plan -> implement-test`
- `implement-test -> review-tests`
- `review-tests -> implement`
- `implement -> review`
- `review -> subtask-commit`

### Symmetric review-finding loops

- `review-tests` findings -> `implement-test-review`
- `implement-test-review` -> `review-tests`
- `review` findings -> `implement-review`
- `implement-review` -> `review`

## Important refinement: back-edge

Allow back-edge `implement -> implement-test`, but only for `tdd: true`.

This lets the agent request another explicit test-authoring pass if implementation reveals missing coverage.

For `tdd: false`, the state machine should reject that transition.

## Prompting implications

The back-edge can be prompted rather than fully encoded as a complex automatic policy.

`implement.md` for `tdd: true` should tell the agent:

- don’t casually rewrite tests inline
- if approved tests are insufficient, explicitly transition back to `implement-test`
- include a short reason describing the gap

## Deterministic execution idea

Tests should be run by the extension on transitions, not by the agent as the source of truth.

Example:

- `implement-test` emits structured test targets/selectors
- extension runs them and requires real failure before allowing `review-tests`
- after `implement`, extension reruns those tests and requires pass before `review`

## Issue model conclusion

Do not create a separate depth-1 sub-issue for the main test-writing pass.

Keep one subtask issue per actual deliverable.

TDD phases are workflow states on that same issue.

Do allow depth-2 review-finding issues for test-review findings, analogous to implementation-review findings.

So:

- depth 1 = planned deliverables
- depth 2 = review corrections

## Recommended artifact addition

If tests stay on the same subtask issue, add a durable section like:

- `## Test Plan`
- or `## Approved Tests`

This becomes the handoff contract from:

- `implement-test`
- to `review-tests`
- to `implement`

## Final position

- keep `.tasks/workflow.json` as the main source of truth
- likely add explicit TDD workflow states for `tdd: true` subtasks
- use deterministic extension-run test checks on transitions
- optionally keep a small append-only TDD/event log as supporting audit/debug evidence
- don’t duplicate planned subtasks into separate “test sub-issues”
- do treat test-review findings like normal review findings with child issues
