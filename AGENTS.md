# Agents / Extensions

## Task extension (`index.ts`)

The extension provides deterministic **task** and **fix** workflows on top of GitHub sub-issues and `jj` workspaces, with an explicit local state machine.

- Commands: `/task` and `/fix`
- Main-workspace cleanup: `/task delete` lets you select and remove a per-task workspace (`jj workspace forget` + delete workspace directory).
- Escape hatch: `/task lgtm` (task workspace only) to force-approve `review-plan` or `review`.
- Recovery command: `/task done` (task workspace only) manually completes an implementation-style state (`implement` or `implement-review`) when automatic advancement was missed.
- `/fix lgtm` force-approves fix review while respecting the manual-test latch.
- `/fix done` manually completes fix `implement` or `implement-review`.
- Source of truth: **`.tasks/workflow.json`** in the workflow workspace.
- Task prompts: `.pi/task/<state>.md`, `~/.pi/agent/task/<state>.md`, then `prompts/<state>.md`.
- Fix prompts: `.pi/fix/<state>.md`, `~/.pi/agent/fix/<state>.md`, then `prompts/fix/<state>.md`.

### Local workflow file

Per-task workspaces must contain:

- `.tasks/workflow.json`

This file is the canonical workflow store and includes:

- task tree (`task_id`, `title`, `subtasks`)
- `schema_version` (currently 2; schema 1 migrates to task kind)
- `workflow_kind` (`task` or `fix`)
- fix-only `manual_test_status` (`undecided`, `pending`, or `passed`)
- `state`
- `active_task_id`
- `active_path_ids`
- `session_leaf_id`
- `version`
- `updated_at`
- optional `last_transition`

If the file is missing/invalid, the extension fails fast with a manual-cleanup error.

### Workspaces

The extension treats your repo in two modes:

**Main workspace (your normal repo checkout)**

- Runs task selection and workspace management.
- Offers to merge completed per-task workspaces back into main.
- Chooses an open root GitHub issue, marks it with `status:in-progress`, creates a
  dedicated `jj workspace` under `~/.workspaces/<task-id>/<repo>`, and initializes
  `.tasks/workflow.json` in that workspace.
- Instructs you to run `pi` in that workspace (or opens a tmux window).

**Per-task workspace (`~/.workspaces/<task-id>/<repo>`)**

- Runs the agent loop from `.tasks/workflow.json`.
- Builds ticket context from workflow path IDs (root → … → active).
- Executes explicit state transitions and side effects, then persists the workflow atomically.
- On side-effect failure, transition is aborted and workflow state remains unchanged.

### Workflow states (explicit)

- `refine`
- `plan`
- `review-plan`
- `implement`
- `review`
- `implement-review`
- `subtask-commit`
- `manual-test`
- `commit`
- optional terminal `complete`

`implement-plan` is not persisted; it is no longer a canonical state.

Fix workflows only allow root `implement`, `review`, `manual-test`, `commit`, `complete`, plus depth-1 `implement-review`. They do not allow `refine`, `plan`, `review-plan`, or `subtask-commit`.

### Transition contract

- `refine -> plan` via assistant output: `<transition>plan</transition>`
- `plan -> review-plan` via assistant output: `<transition>review-plan</transition>`
- `review-plan`:
  - on `<transition>review-plan</transition>`: remain in `review-plan` and run another review pass
  - on `<transition>implement</transition>` (or `/task lgtm`): parse `<subtasks>...</subtasks>`, create/reuse depth-1 subtasks, set first active, move to `implement`
- `implement -> review` deterministically after turn or via `/task done`
- `review`:
  - on `<transition>subtask-commit</transition>` (or `/task lgtm`): move to `subtask-commit`
  - on `<review-findings>...</review-findings>` + `<transition>implement-review</transition>`: create/reuse depth-2 finding tasks, set first active, move to `implement-review`
- `implement-review` (deterministically after turn or via `/task done`):
  - close active finding
  - move to next finding or back to parent subtask `review`
- `subtask-commit`:
  - parse `<commit-message>...</commit-message>`
  - close active subtask + `jj commit`
  - move to next root subtask `implement` or root `manual-test`
- `manual-test`:
  - on assistant output `<transition>commit</transition>`: moves to `commit`
  - on `<manual-test-subtasks>...</manual-test-subtasks>` + `<transition>implement</transition>`: create/reuse depth-1 subtasks, set first active, move to `implement`
- `commit`:
  - parse `<commit-message>...</commit-message>`
  - close root task + final `jj commit`
  - optionally move to `complete`

Fix transition contract:

- `implement -> review` deterministically or via `/fix done`.
- `review -> implement-review` with non-empty `<review-findings>`; children are created under root.
- `implement-review` closes each child, advances siblings, then returns to root `review`.
- `review -> manual-test` sets `manual_test_status: pending`.
- `review -> commit` is allowed only while manual testing is `undecided`.
- `manual-test -> implement-review` with confirmed `<manual-test-subtasks>` keeps testing pending.
- Pending manual testing forces successful review back to `manual-test`.
- `manual-test -> commit` sets testing to `passed`.
- `commit -> complete` requires a non-empty working copy, performs one fix commit, then closes root.

### Invariants enforced

- `active_task_id` exists in workflow tree
- `active_path_ids` exactly matches root → active path
- unique task IDs across tree
- task max tree depth = 2; fix max tree depth = 1
- state/depth compatibility is workflow-kind aware
- `version` increments exactly once per successful transition

### Merging

The extension manages per-task `jj workspace` creation under
`~/.workspaces/<task-id>/<repo>` and merges completed workspaces back into the
main workspace as a **single squashed commit** (message defaults to the task commit description).

## Project-local skill

### `task-workflow`

A packaged skill lives at `skills/task-workflow/SKILL.md`.

Use it when a task workspace is stuck and you need to manually repair or advance
`.tasks/workflow.json` so `/task` can continue.

The skill covers:

- workflow state/depth rules
- task tree invariants
- safe handling of `pending_prompt_run`, `session_leaf_id`, and related fields
- minimal manual edit procedures for common stuck-workflow cases
