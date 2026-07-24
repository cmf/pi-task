# pi-task workflow state machine

`pi-task` is a Pi extension that turns AI-assisted coding into a deterministic, ticket-driven workflow. It connects GitHub Issues, `jj` workspaces, and Pi's agent loop so that each task gets its own isolated workspace, explicit workflow state, review gates, subtasks, commits, and final squash-merge path.

The core idea is: instead of asking an agent to "go build this", the extension drives it through an explicit lifecycle. `/task` runs both the full task lifecycle and a shorter fix lifecycle for root issues that are already specific enough to implement directly.

It's designed to require my attention only at specific points, so that I can run different tasks asynchronously (including homeschooling etc).

Original inspiration: https://github.com/badlogic/claude-commands

Agents tend to get distracted by spurious context, influenced by context earlier in the conversation, etc. The extension uses Pi's conversation tree to give each workflow step an isolated context.

Before running a step, the workflow navigates back to the point in the conversation where `/task` was originally run, then sends the prompt for the current state, including the root issue content and any sub-issue content. This means each step sees a controlled context: workflow metadata, the active issue path, and the state-specific instructions. The extension can then read the assistant's response from that branch and apply the next state transition.

However this is tricky in pi because it's not clear when an agent turn is completely settled, and so the `end_turn` events do not have access to manipulate the conversation tree. This is because things may happen asynchronously after the end of the turn (compaction, steering, extension follow-up commands etc). This is an active area of development in pi: https://github.com/earendil-works/pi/issues/2023 & https://jot.mariozechner.at/s/cy2bzlpoilaanc.

## Status

This library is forkware - it's designed to work for me, and I'm unlikely to add features that work for other people, unless they also work for me. But feel free to use it, copy it, remix it, get inspired by it or whatever - use it as you like.

## Mermaid diagram

```mermaid
stateDiagram-v2
    direction TB

    [*] --> refine
    refine --> plan
    plan --> review_plan

    review_plan --> review_plan: user updates plan
    review_plan --> implement: approved or /task lgtm

    implement --> review: completed or /task done

    review --> implement_review
    implement_review --> implement_review: next finding or /task done
    implement_review --> review: completed or /task done

    review --> subtask_commit
    subtask_commit --> implement: next subtask
    subtask_commit --> manual_test: all subtasks done

    manual_test --> implement
    manual_test --> commit

    commit --> complete
    complete --> [*]
```

## Fix workflow

Use `/task` for every workflow. When a selected open root issue has an exact, case-insensitive `fix` label, workspace initialization persists `workflow_kind: "fix"` and starts at `implement`; otherwise it persists a normal task workflow at `refine`. Selection lines show the inferred kind. The extension paginates issue labels, refetches the selected issue, and verifies that it is still open and root immediately before initialization. It never creates or changes the user-owned `fix` label, and later label changes do not alter the persisted workflow kind.

```mermaid
stateDiagram-v2
    [*] --> implement
    implement --> review
    review --> implement_review: findings
    implement_review --> implement_review: next follow-up
    implement_review --> review: final follow-up
    review --> manual_test: manual verification useful/pending
    review --> commit: automated verification sufficient
    manual_test --> implement_review: confirmed failure follow-ups
    manual_test --> commit: verification passed
    commit --> complete
```

Commands:

- `/task`: start or resume either workflow kind.
- `/task done`: manually complete `implement` or `implement-review` using the persisted kind's behavior.
- `/task lgtm`: approve the current kind-specific review state; fix workflows respect the manual-test latch.
- `/task apply`: task-only and valid only in `review-plan`.
- `/task delete`: available from the main workspace.
- `/fix` remains a compatibility alias that delegates to `/task`; it does not select workflow kind.

Fix workflows produce one final implementation commit. Review findings and confirmed manual-test failures become root child issues, but are not committed separately. A manual-test latch prevents review from skipping a required rerun after a failed pass. Empty final fix commits are blocked before the root issue is closed.

Persisted workflows include `workflow_kind: "task" | "fix"`. Schema-version-1 files migrate to schema version 2 as task workflows without incrementing the workflow transition version.

## Future plans

- Codify TDD in states & transitions
  - `implement-test`
  - `review-tests`
  - `implement-test-review`
- Deterministic formatting/linting after implementation steps

## YAML blocks used by transitions

Plan subtasks live in the root issue:

```
 ## Plan
 <subtasks>
 - title: Example subtask
   description: |
     What needs to be done.
   tdd: true
 </subtasks>
```

Review findings:

```
 <review-findings>
 - title: Fix edge case
   description: |
     The implementation misses this case.
   tdd: true
 </review-findings>
```

Manual-test followups:

```
 <manual-test-subtasks>
 - title: Fix manual test failure
   description: |
     What failed during manual verification.
   tdd: true
 </manual-test-subtasks>
```

Commits:
```
 <commit-message>
 Implement task workflow diagram
 Explain transitions and update docs.
 </commit-message>
```

## Transition summary

| From | To | Trigger | Criteria / effects |
|---|---|---|---|
| `refine` | `plan` | `<transition>plan</transition>` | Begin planning. |
| `plan` | `review-plan` | `<transition>review-plan</transition>` | Root issue must contain a valid `## Plan` with non-empty `<subtasks>`. |
| `review-plan` | `review-plan` | `<transition>review-plan</transition>` | Re-review after plan changes. Plan subtasks must still parse. |
| `review-plan` | `implement` | `<transition>implement</transition>` or `/task lgtm` | Creates child issues from plan subtasks; activates first subtask. |
| `implement` | `review` | Agent turn completes or `/task done` | Deterministic transition after implementation prompt; `/task done` manually applies the same completion transition. |
| `review` | `implement-review` | `<transition>implement-review</transition>` + `<review-findings>` | Creates finding issues under current subtask; activates first finding. |
| `implement-review` | `implement-review` | Agent turn completes or `/task done` | Closes current finding and moves to next finding. |
| `implement-review` | `review` | Agent turn completes or `/task done` | Closes final finding and returns to parent subtask review. |
| `review` | `subtask-commit` | `<transition>subtask-commit</transition>` or `/task lgtm` | Review approved. |
| `subtask-commit` | `implement` | `<commit-message>` and next subtask exists | Closes current subtask, runs `jj commit`, activates next subtask. |
| `subtask-commit` | `manual-test` | `<commit-message>` and no subtasks remain | Closes current subtask, runs `jj commit`, returns to root. |
| `manual-test` | `implement` | `<transition>implement</transition>` + `<manual-test-subtasks>` | Creates follow-up subtasks from manual test failures. |
| `manual-test` | `commit` | `<transition>commit</transition>` | Manual verification passed. |
| `commit` | `complete` | `<commit-message>` | Closes root issue and runs final `jj commit`; workspace is ready to merge. |

