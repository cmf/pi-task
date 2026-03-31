---
model: openai-codex/gpt-5.4
thinking: high
---

Your task is to write a detailed implementation plan for the current issue, split
into small, concrete, independently-executable subtasks.

**YAGNI:**

- Prefer the minimum required change to make the issue work
- Choose the simplest solution that satisfies the requirements
- If something can be simplified further, do so

## Subtasks

A **subtask** is **one independently-deliverable change** (something that could
be implemented and reviewed on its own). A subtask can include multiple steps
(e.g. test → implement → verify), but it must be specific and actionable.

Avoid “investigation-only” subtasks. If you must investigate, it should be a
small, time-boxed first step inside a subtask that still ends with a concrete
code/config change.

### TDD policy

Subtasks default to requiring TDD.

Exceptions are allowed:

1. Swing code which is unreasonably difficult to test with automation
2. One-off scripts with no existing testing
3. Documentation-only changes

If you believe a subtask should be exempt from TDD, **ask the user to confirm**.
When the user confirms, set `tdd: false` for that subtask.

If `tdd` is true (default), the description should include these steps (adapt
commands to the repo):

- Write the failing test
- Run it to confirm it fails
- Implement the minimal code to make the test pass
- Run the tests to confirm they pass

If `tdd: false` (user-approved), the description should include:

- Note stating that the user explicitly approved manual verification for this subtask
- Implement the minimal code to fulfil the subtask requirements
- Run whatever manual/adhoc verification is appropriate

When `tdd: false`, the subtask should include testing steps in the `## Manual Test Plan` (below).

## Output format

Prepare plan content for a `## Plan` section.

Inside that section, include a delimited block containing **only** a YAML list of
subtask objects using `<subtasks>...</subtasks>` delimiters.

Inside the YAML list, each item must be:

- `title`: single-line string
- `description`: multi-line string containing markdown (use `|`)
- `tdd`: optional boolean (defaults to `true`; set `false` only with user approval)

YAML must be valid (proper indentation, no stray text inside the delimiters).

### Example

```md
## Plan
<subtasks>
- title: "Reject empty/blank project name (HTTP 400)"
  tdd: true
  description: |
    - Write a failing test in `tests/test_project_create.py` asserting that creating a project with an empty name returns HTTP 400.
    - Run: `pytest -q tests/test_project_create.py::test_create_project_empty_name`
      - Expected: the test fails with an assertion error (e.g. got 201 but expected 400).
    - Implement the minimal validation in `src/api/projects.py` (reject empty/whitespace-only names).
    - Run: `pytest -q tests/test_project_create.py::test_create_project_empty_name`
      - Expected: the test passes.

- title: "Return error code `project_name_required` for blank project name"
  tdd: true
  description: |
    - Write a failing test asserting the response body includes an error code/message (e.g. `{"error":"project_name_required"}`).
    - Run: `pytest -q tests/test_project_create.py::test_create_project_empty_name_message`
      - Expected: fails (message missing or different).
    - Implement the minimal error payload change in `src/api/projects.py`.
    - Run: `pytest -q tests/test_project_create.py::test_create_project_empty_name_message`
      - Expected: passes.

- title: "Add Swing preferences panel for proxy settings (user-approved no-TDD)"
  tdd: false
  description: |
    - User has confirmed that TDD is exempt for this Swing UI change.
    - Implement a new Swing configuration panel in `src/ui/ProxySettingsPanel.java`:
      - Text fields for host/port, a checkbox for "Use proxy"
      - Load initial values from existing config, if present
      - Persist changes back to config on Apply/OK
    - Wire the panel into the preferences dialog in `src/ui/PreferencesDialog.java`.
    - Manual verification:
      - Run: `./gradlew run`
        - Expected: app launches.
      - Open Preferences → Network.
        - Expected: the new Proxy Settings panel renders correctly.
      - Toggle "Use proxy", set host/port, click Apply, restart the app.
        - Expected: values persist and are reloaded.
</subtasks>
```

### Manual testing plan

Also prepare content for a `## Manual Test Plan` section after the subtasks.
- Steps must be explicit and include expected results.
- Include commands/URLs/UI navigation where relevant.

## Writing back to the issue (required)

Use `task_issue_edit` to persist both sections:

1. Root issue `## Plan`
   - `target: "root"`
   - `action: "upsert_section"`
   - `section: "plan"`
   - `content: <plan section body only, including <subtasks>...</subtasks>>`

2. Root issue `## Manual Test Plan`
   - `target: "root"`
   - `action: "upsert_section"`
   - `section: "manual_test_plan"`
   - `content: <manual test plan section body only>`

Do not ask the user to edit the issue manually.

## Once done

**Critical:** After writing the sections to the issue, request workflow transition by outputting:

`<transition>review-plan</transition>`

The extension advances workflow state from your `<transition>...</transition>` output.

## Remember

- Use exact file paths in the repo (no “or wherever this lives”)
- Use explicit commands (with expected outcomes) instead of “run tests”
- Keep subtasks DRY and YAGNI
- Prefer concrete edits over vague language (avoid “add validation”, “refactor stuff”)
