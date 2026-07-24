---
name: task-workflow
description: Manually diagnose, repair or advance a stuck /task workflow by inspecting and editing .tasks/workflow.json in a per-workflow workspace.
---

# Task workflow recovery

Use this skill only for a `/task` extension workflow in a per-workflow workspace. The persisted `workflow_kind` may be `task` or `fix`.

## Read first

Before changing anything, read:

- `.tasks/workflow.json`
- `references/workflow-json.md` relative to the directory containing this `SKILL.md`.

## Goal

Make the smallest safe edit to `.tasks/workflow.json` so `/task` can continue.

Do not do speculative cleanup. Do not rewrite the workflow from scratch.

## Safety rules

- Only use this in a per-task workspace that already has `.tasks/workflow.json`.
- Back up the workflow file before editing it.
- Prefer clearing stale transient fields over changing workflow state.
- Never invent task IDs. If you add a node to the task tree, use a real existing issue/task ID.
- Preserve kind-specific tree depth limits: task root -> subtask -> review finding (max 2); fix root -> follow-up (max 1).
- Keep `active_path_ids` exactly equal to the root-to-active path.
- If a transition normally has side effects (create issues, close issues, `jj commit`), do not skip those side effects unless they already happened and the workflow file is just behind.

## Backup

Before editing:

```bash
cp .tasks/workflow.json .tasks/workflow.json.bak.$(date +%Y%m%d-%H%M%S)
```

## Fast diagnosis

Check these first:

1. Is the JSON valid?
2. Is `state` one of:
   `refine`, `plan`, `review-plan`, `implement`, `review`, `implement-review`, `subtask-commit`, `manual-test`, `commit`, `complete`
3. Does `active_task_id` exist in the tree?
4. Does `active_path_ids` match the actual path to `active_task_id`?
5. Is active depth compatible with `workflow_kind` and state?
6. For fix workflows, is `manual_test_status` present and consistent with the intended verification path?
7. Is `pending_prompt_run` stale?
8. Is `session_leaf_id` stale because the workflow moved to a new Pi session?

## State/depth map

Task workflow:

- Depth 0 only:
  - `refine`
  - `plan`
  - `review-plan`
  - `manual-test`
  - `commit`
  - `complete`
- Depth 1 only:
  - `implement`
  - `review`
  - `subtask-commit`
- Depth 2 only:
  - `implement-review`

Fix workflow:

- Depth 0 only: `implement`, `review`, `manual-test`, `commit`, `complete`
- Depth 1 only: `implement-review`
- Invalid in fix: `refine`, `plan`, `review-plan`, `subtask-commit`

Depth is `active_path_ids.length - 1`.

## Common safe repairs

### 1) Stale pending run

Use when a request failed, timed out, or is no longer actually running.

Usually safe edit:

- set `pending_prompt_run` to `null`
- leave `state`, `active_task_id`, and tree structure unchanged
- update `updated_at`
- usually leave `version` unchanged unless you are applying an actual state transition

Usually leave `last_consumed_assistant_id` alone.

### 2) Wrong active task/path for the current state

Fix by editing only:

- `active_task_id`
- `active_path_ids`
- possibly `state`
- `updated_at`
- `version` only if you are applying an actual transition

Examples:

- In a task workflow, `implement`/`review`/`subtask-commit` must point at a root child, and `implement-review` must point at a depth-2 review-finding child.
- In a fix workflow, `implement-review` must point at a depth-1 follow-up child; all other valid fix states point at the root.
- Root states must point back to the root task.

### 3) Stale `session_leaf_id`

If `/task` is resuming in a different Pi session and navigation keeps failing, prefer the built-in recovery first: `/task` can bind `unbound`, rebind some initial workspaces, or prompt to update the leaf automatically.

Manually update `session_leaf_id` to the current session leaf only when that automatic recovery is blocked and you are sure it is the correct recovery.

### 4) Missed transition with no missing side effects

If the assistant clearly reached the next state but the file did not advance, you can manually move the workflow forward.

Examples that are usually safe if the required artifacts already exist:

- For a task workflow: `refine -> plan`, `plan -> review-plan`, `implement -> review`, or `manual-test -> commit`.
- For a fix workflow, `implement -> review` is safe at the root.
- For a fix workflow, `manual-test -> commit` must also set `manual_test_status` to `passed`.

For a task workflow, `manual-test -> implement` is only safe if the required depth-1 subtasks already exist under the root. A fix workflow does not use this transition; use `manual-test -> implement-review` with existing depth-1 follow-up children and keep `manual_test_status` as `pending`.

When you do this, update:

- `state`
- `active_task_id` if needed
- `active_path_ids`
- `updated_at`
- `version`

### 5) Transitions that require existing child nodes

Only do these if the tree already contains the correct child tasks, or you can add real existing task IDs.

- `review-plan -> implement`
  - needs depth-1 subtask nodes under the root
  - active task should usually become the first subtask
- For a task workflow, `review -> implement-review` needs depth-2 finding nodes under the active subtask; activate the first finding.
- For a fix workflow, `review -> implement-review` needs a depth-1 follow-up under the root; activate the first follow-up.
- Within task `implement-review`, move to the next sibling finding or return to the parent subtask in `review`.
- Within fix `implement-review`, move to the next sibling follow-up or return to the root in `review`, preserving `manual_test_status`.
- For a task workflow, `manual-test -> implement` needs depth-1 subtask nodes under the root; activate the first subtask.
- For a fix workflow, `manual-test -> implement-review` needs a depth-1 follow-up under the root; activate the first follow-up and keep `manual_test_status` as `pending`.

If the needed child nodes do not exist yet, do not fabricate them.

### 6) Clear blocked empty-subtask commit state

If `pending_empty_subtask_commit` is present but the workflow should continue normally, set it to `null` only when you are intentionally abandoning that special-case resume path.

## Fields you will usually touch

- `state`
- `active_task_id`
- `active_path_ids`
- `session_leaf_id` sometimes
- `pending_prompt_run`
- `pending_empty_subtask_commit`
- fix-only `manual_test_status` when repairing manual-test transitions
- `version` when applying an actual transition
- `updated_at`

## Fields you should usually not touch

- `schema_version`
- `task_id` for the root
- existing task IDs unless you are correcting the tree to match real tasks
- `last_consumed_assistant_id` unless you have a specific replay reason

## Minimal repair procedure

1. Read the current workflow file.
2. Explain the exact inconsistency.
3. Propose the smallest edit.
4. Confirm with the user that they want the edit applied.
5. Back up the file.
6. Apply the edit.
7. Re-read the file and verify:
   - valid JSON
   - valid state
   - active task exists
   - path matches
   - state/depth is valid
8. Tell the user exactly what changed.
9. Tell the user to run `/task`.

## Output style

Be explicit and concrete:

- name the file path: `.tasks/workflow.json`
- name the old and new state/task/path
- say why the edit is safe
- call out any assumptions

For detailed schema and repair recipes, read `references/workflow-json.md` relative to this skill file.
