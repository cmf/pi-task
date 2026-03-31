# Agents / Extensions

## Task extension (`index.ts`)

The **task** extension provides a deterministic, ticket-driven workflow on top of
`tk` (tickets) and `jj` (workspaces), with an explicit local state machine.

- Command: `/task`
- Main-workspace cleanup: `/task delete` lets you select and remove a per-task workspace (`jj workspace forget` + delete workspace directory).
- Escape hatch: `/task lgtm` (task workspace only) to force-approve `review-plan` or `review`.
- Source of truth: **`.tasks/workflow.json`** in the task workspace.
- Prompt selection: loads `prompts/<workflow.state>.md` (or project override at `.pi/task/<state>.md`, then user override at `~/.pi/agent/task/<state>.md`).

### Local workflow file

Per-task workspaces must contain:

- `.tasks/workflow.json`

This file is the canonical workflow store and includes:

- task tree (`task_id`, `title`, `subtasks`)
- `schema_version`
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
- Chooses a ticket from `tk ready`, creates a dedicated `jj workspace` under
  `~/.workspaces/<task-id>/<repo>`, marks the ticket `in_progress` (`tk start`),
  and initializes `.tasks/workflow.json` in that workspace.
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

### Transition contract

- `refine -> plan` via assistant output: `<transition>plan</transition>`
- `plan -> review-plan` via assistant output: `<transition>review-plan</transition>`
- `review-plan`:
  - on `<transition>review-plan</transition>`: remain in `review-plan` and run another review pass
  - on `<transition>implement</transition>` (or `/task lgtm`): parse `<subtasks>...</subtasks>`, create/reuse depth-1 subtasks, set first active, move to `implement`
- `implement -> review` deterministically after turn
- `review`:
  - on `<transition>subtask-commit</transition>` (or `/task lgtm`): move to `subtask-commit`
  - on `<review-findings>...</review-findings>` + `<transition>implement-review</transition>`: create/reuse depth-2 finding tasks, set first active, move to `implement-review`
- `implement-review`:
  - close active finding
  - move to next finding or back to parent subtask `review`
- `subtask-commit`:
  - parse `<commit-message>...</commit-message>`
  - close active subtask + `jj commit`
  - move to next root subtask `implement` or root `manual-test`
- `manual-test`:
  - on assistant output `<transition>commit</transition>`: moves to `commit`
- `commit`:
  - parse `<commit-message>...</commit-message>`
  - close root task + final `jj commit`
  - optionally move to `complete`

### Invariants enforced

- `active_task_id` exists in workflow tree
- `active_path_ids` exactly matches root → active path
- unique task IDs across tree
- max tree depth = 2 (root, subtask, review finding)
- state/depth compatibility is enforced
- `version` increments exactly once per successful transition

### Merging

The extension manages per-task `jj workspace` creation under
`~/.workspaces/<task-id>/<repo>` and merges completed workspaces back into the
main workspace as a **single squashed commit** (message defaults to the root ticket title).
