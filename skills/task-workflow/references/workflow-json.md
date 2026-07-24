# Workflow JSON reference

This file documents the parts of `.tasks/workflow.json` that matter for manual recovery.

## Shape

The workflow file is a task tree rooted at the root issue, plus workflow metadata.

```json
{
  "schema_version": 2,
  "workflow_kind": "task",
  "task_id": "123",
  "title": "Root task title",
  "subtasks": [],
  "state": "refine",
  "active_task_id": "123",
  "active_path_ids": ["123"],
  "session_leaf_id": "leaf-id",
  "session_file_path": null,
  "last_consumed_assistant_id": null,
  "pending_prompt_run": null,
  "pending_empty_subtask_commit": null,
  "pending_fix_commit": null,
  "manual_test_followups": [],
  "version": 1,
  "updated_at": "2026-04-11T00:00:00.000Z",
  "last_transition": {
    "event": "initialize",
    "from_state": "refine",
    "to_state": "refine",
    "from_active_task_id": "123",
    "to_active_task_id": "123",
    "at": "2026-04-11T00:00:00.000Z"
  }
}
```

## Tree rules

Each node has:

- `task_id: string`
- `title: string`
- `subtasks: TaskNode[]`

Rules:

- task IDs must be unique across the whole tree
- task workflow max depth is 2
  - depth 0: root
  - depth 1: root subtasks
  - depth 2: review findings under one subtask
- fix workflow max depth is 1
  - depth 0: root fix issue
  - depth 1: review or manual-test follow-up
- `active_task_id` must exist in the tree
- `active_path_ids` must exactly match the root-to-active path

## Schema and workflow kind

Schema version 1 is migrated deterministically to schema version 2 by adding `workflow_kind: "task"`. Migration preserves workflow `version` because it is not a state transition. Unknown schema versions remain invalid.

`workflow_kind` is authoritative; never infer it from `state`.

Fix workflows also require:

```json
"manual_test_status": "undecided"
```

Allowed values are `undecided`, `pending`, and `passed`. Task workflows must not contain this field.

## State rules

Task states:

- `refine`
- `plan`
- `review-plan`
- `implement`
- `review`
- `implement-review`
- `subtask-commit`
- `manual-test`
- `commit`
- `complete`

Task allowed active depth by state:

- depth 0:
  - `refine`
  - `plan`
  - `review-plan`
  - `manual-test`
  - `commit`
  - `complete`
- depth 1:
  - `implement`
  - `review`
  - `subtask-commit`
- depth 2:
  - `implement-review`

Fix allowed states/depths:

- depth 0: `implement`, `review`, `manual-test`, `commit`, `complete`
- depth 1: `implement-review`
- invalid: `refine`, `plan`, `review-plan`, `subtask-commit`

## Important optional fields

### `pending_prompt_run`

Shape:

```json
{
  "state": "implement",
  "active_task_id": "456",
  "session_leaf_id": "leaf-id",
  "previous_assistant_id": "msg-id-or-null",
  "started_at": "2026-04-11T00:00:00.000Z"
}
```

Use `null` when there is no in-flight prompt run.

A stale value here is a common cause of a wedged workflow after a failed run.

### `pending_empty_subtask_commit`

Shape:

```json
{
  "task_id": "456",
  "commit_message": "subtask message"
}
```

Use `null` when not in that special recovery path.

### `pending_fix_commit`

Fix-only retry metadata:

```json
{
  "commit_message": "fix: correct behavior",
  "started_at": "2026-07-12T00:00:00.000Z"
}
```

The shell persists this before the single fix commit. If the commit succeeds but root closure or workflow persistence fails, `/task` can verify the matching parent commit and resume finalization without creating a duplicate commit. Do not clear it while recovering a partially completed fix finalization unless you have verified the commit did not happen.

### `manual_test_followups`

Shape:

```json
[
  {
    "issue_id": "242",
    "title": "Fix manual-test failure",
    "fingerprint": "fix-manual-test-failure",
    "created_at": "2026-04-11T00:00:00.000Z",
    "from_manual_test_version": 66
  }
]
```

This records follow-up issues created by task `manual-test -> implement` or fix `manual-test -> implement-review`. On later manual-test prompts the extension checks GitHub for each linked issue and injects deterministic context, so closed follow-ups are treated as historical rather than fresh failures.

### `last_consumed_assistant_id`

Usually leave this alone.

Only clear or change it if you intentionally want `/task` to try to replay an assistant completion that has not already been applied.

### `session_leaf_id`

This ties the workflow to a Pi conversation leaf.

Prefer the built-in recovery first: `/task` can bind `unbound`, rebind an initial workflow, or prompt to update the leaf automatically when navigation fails.

Manual edits are reasonable only when that recovery is otherwise blocked.

## Transition summary

This is the workflow model the manual edit must respect.

- `refine -> plan`
  - active stays root
- `plan -> review-plan`
  - active stays root
  - requires a non-empty `## Plan` / `<subtasks>...</subtasks>` block in the root issue markdown when the normal machine runs
- `review-plan -> implement`
  - requires depth-1 subtask nodes to exist
  - active becomes first subtask
- `implement -> review`
  - active stays current depth-1 subtask
- `review -> implement-review`
  - requires depth-2 finding nodes to exist under current subtask
  - active becomes first finding
- `review -> subtask-commit`
  - active stays current depth-1 subtask
- `implement-review -> review`
  - after the current finding is closed, return to the parent subtask when no more sibling findings remain
- `implement-review -> implement-review`
  - after the current finding is closed, move to the next sibling finding when one exists
- `subtask-commit -> implement`
  - closes current subtask, commits, moves to next sibling subtask
- `subtask-commit -> manual-test`
  - closes current subtask, commits, moves to root when no more sibling subtasks remain
- `manual-test -> implement`
  - requires depth-1 subtask nodes to exist under the root
  - active becomes first subtask
- `manual-test -> commit`
  - active stays root
- `commit -> complete`
  - closes root, runs final commit, active stays root

### Fix transition summary

- `implement -> review`: active stays root.
- `review -> implement-review`: requires depth-1 follow-up nodes under root; active becomes first child.
- `implement-review -> implement-review`: close current child and activate next sibling.
- `implement-review -> review`: close final child and return active to root.
- `review -> manual-test`: set `manual_test_status` to `pending`.
- `review -> commit`: allowed only while status is `undecided`.
- `manual-test -> implement-review`: requires depth-1 follow-up nodes and keeps status `pending`.
- after pending follow-ups, successful review must return to `manual-test`; do not repair directly to `commit`.
- `manual-test -> commit`: set status to `passed`.
- `commit -> complete`: requires a non-empty working copy; one `jj commit` succeeds before root closure.

## Fix repair recipes

- If a fix is in root `review` with `manual_test_status: pending`, the safe approval target is root `manual-test`, not `commit`.
- If a confirmed manual-test failure already has real child issues, set `state: implement-review`, active to the first child, and keep status `pending`.
- If the final follow-up is complete, close it externally only if that side effect already happened, then return to root `review`; keep status `pending` so verification reruns.
- Never use the task empty-final-commit parent-description fallback for a fix.

## Manual edit guidelines by scenario

### A) Assistant run died before producing anything useful

Typical edit:

- `pending_prompt_run: null`
- update `updated_at`
- usually leave `version` unchanged unless you are applying an actual state transition

### B) Assistant produced the right transition, but workflow file did not advance

Typical edit:

- move `state` to the next state
- update active task/path if required by the target state
- clear `pending_prompt_run`
- increment `version`
- update `updated_at`

### C) Active task/path is inconsistent

Typical edit:

- keep the tree
- repair `active_task_id`
- recompute `active_path_ids`
- adjust `state` only if needed to match depth
- update `updated_at`
- change `version` only if you are applying an actual transition

### D) Need to move into `implement` or `implement-review`

Extra caution:

- those states require existing child nodes
- do not invent fake IDs
- if the task tree is missing those nodes, stop and explain what real side effect is still missing

## Suggested bookkeeping for manual repairs

These edits are not performed by the normal machine, so there is no strict format requirement beyond valid JSON and invariants. A practical pattern is:

- for non-transition metadata cleanup, update `updated_at` and usually leave `version` unchanged
- for a real manual transition, increment `version` by 1
- optionally set:

```json
"last_transition": {
  "event": "manual-repair",
  "from_state": "old-state",
  "to_state": "new-state",
  "from_active_task_id": "old-id",
  "to_active_task_id": "new-id",
  "at": "now"
}
```

Only do this if you can set it truthfully.
