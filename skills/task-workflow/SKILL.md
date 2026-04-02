---
name: task-workflow
description: Manually diagnose, repair or advance a stuck /task workflow by inspecting and editing .tasks/workflow.json in a per-task workspace. Use when a task workspace is wedged due to a stale pending run, wrong workflow state, bad active task/path, or a missed transition and you need to diagnose or recover the workflow safely.
---

# Task workflow recovery

Use this skill only for the task extension workflow in a per-task workspace.

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
- Preserve tree depth limits: root -> subtask -> review finding. Max depth is 2.
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
5. Is active depth compatible with state?
6. Is `pending_prompt_run` stale?
7. Is `session_leaf_id` stale because the workflow moved to a new Pi session?

## State/depth map

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

- `implement`/`review`/`subtask-commit` must point at a root child
- `implement-review` must point at a review-finding child
- root states must point back to the root task

### 3) Stale `session_leaf_id`

If `/task` is resuming in a different Pi session and navigation keeps failing, prefer the built-in recovery first: `/task` can bind `unbound`, rebind some initial workspaces, or prompt to update the leaf automatically.

Manually update `session_leaf_id` to the current session leaf only when that automatic recovery is blocked and you are sure it is the correct recovery.

### 4) Missed transition with no missing side effects

If the assistant clearly reached the next state but the file did not advance, you can manually move the workflow forward.

Examples that are usually safe if the required artifacts already exist:

- `refine -> plan`
- `plan -> review-plan`
- `implement -> review`
- `manual-test -> commit`

Note: `manual-test -> implement` is only safe if the required depth-1 subtasks already exist under the root.

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
- `review -> implement-review`
  - needs depth-2 finding nodes under the active subtask
  - active task should usually become the first finding
- within `implement-review`
  - if another sibling finding exists, stay in `implement-review` and move to that sibling
  - otherwise return to the parent subtask in `review`
- `manual-test -> implement`
  - needs depth-1 subtask nodes under the root
  - active task should usually become the first subtask

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
9. Tell the user to run `/task` again.

## Output style

Be explicit and concrete:

- name the file path: `.tasks/workflow.json`
- name the old and new state/task/path
- say why the edit is safe
- call out any assumptions

For detailed schema and repair recipes, read `references/workflow-json.md` relative to this skill file.
