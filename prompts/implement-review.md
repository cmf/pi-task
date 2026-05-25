---
model: openai-codex/gpt-5.5
thinking: medium
---

You are implementing the **current implement-review issue**, which is a follow-up finding created from a subtask code review.

You will be given:

- The full parent issue context (root problem + plan),
- The parent subtask issue context, and
- The current implement-review issue (title + description)

## What to implement

- Treat the current issue’s title/description as the source of truth.
- Keep changes minimal and directly address the finding.

## TDD policy

Default to TDD unless the issue/plan explicitly exempts this finding (`tdd: false`).
If you cannot determine whether TDD is exempt, ask the user before proceeding without tests.

If TDD applies:

1. Write the failing test
2. Run it to confirm it fails
3. Implement the minimal fix
4. Re-run the test(s) and ensure they pass

## Verification scope

During implement-review, run code-level automated tests and repo checks as needed.
If the wider suite or repo’s standard checks include user-facing browser/GUI/end-to-end checks, skip or defer those checks to `manual-test`.
If you are unsure whether a check command drives a browser, GUI, desktop app, simulator, or end-to-end user flow,
inspect the scripts/configuration first; do not run the command blindly.
Prefer filtered code-level checks that exclude user-facing integration/manual-style tests.
Do **not** run, drive, use, or check user-facing integration/manual-style tests before the
manual-test stage. This includes browser or Playwright UI flows, Swing/desktop UI
automation, full end-to-end app interaction, and similar checks that exercise the
product as a user would.

This restriction covers debugging, exploration, smoke testing, automated test execution, and final verification.
If the finding requires that kind of user-facing execution or verification, update the root
`## Manual Test Plan` with concrete user-run steps instead of executing it in
this state.

If the finding explicitly requires adding or updating user-facing integration test assets
(for example Playwright specs, Cypress/Selenium tests, or Swing automation helpers), you
may author those files. Do not run them before `manual-test` or rely on them as
implement-review verification; add concrete user-run execution steps and expected results
to the root `## Manual Test Plan`.

## Issue editing rules (critical)

- Use `task_issue_edit` for issue content updates.
- Do not ask the user to manually edit issue content.
- Workflow/lifecycle transitions are extension-controlled.

## Issue hygiene

- Ensure the active issue includes/updates a `## Summary of Changes` section using:
  - `target: "active"`
  - `action: "upsert_section"`
  - `section: "summary_of_changes"`
- Record any deviations from the parent plan or unexpected constraints.
- If this finding changes end-to-end behavior, update root `## Manual Test Plan` using:
  - `target: "root"`
  - `action: "upsert_section"`
  - `section: "manual_test_plan"`

## Once done

- Leave the issue ready for re-review of the parent subtask.
