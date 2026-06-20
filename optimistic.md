# Plan: optimistic /task auto-resume after interrupted turns

## Problem

The task workflow currently relies on `/task` owning the whole prompt -> agent turn -> transition dispatch loop. If an agent turn is interrupted by a transient provider/API/tool error, `runTaskWorkspace()` sees the error and returns:

```ts
if (agentEndLooksLikeErrorFromSession(ctx)) {
    ctx.ui.notify("Agent turn ended with an error; fix the issue and run /task to resume.", "warning");
    return;
}
```

Even when the assistant later produces a valid completion for the pending prompt run, the workflow does not automatically continue because the code that can safely navigate the session tree is only available through `ExtensionCommandContext.navigateTree()`, and regular event handlers receive only `ExtensionContext`.

The manual recovery path mostly works via `pending_prompt_run` and `replayPendingAssistantTransition()`, but it requires the user to run `/task` again. This is annoying for common transient interruptions.

## Goal

Add an optimistic auto-resume mechanism:

1. Preserve the current preferred path: while `/task` still owns a live `ExtensionCommandContext`, use that same command context directly, exactly as the workflow does today.
2. Only when `/task` has already returned because the turn looked interrupted, fall back to a captured command context as an optimistic recovery hack.
3. On `agent_end`, if there is a pending task prompt completion and no live `/task` loop is already handling it, attempt to replay the transition.
4. If replay succeeds and the workflow should continue, re-enter `runTaskWorkspace()` automatically using the captured command context.
5. If anything looks unsafe or stale, bail out and keep the current manual `/task` recovery behavior.

This should be best-effort and conservative. The workflow file remains the source of truth. The captured-context path is a fallback, not the normal control flow.

## Non-goals

- Do not make `navigateTree()` available on normal `ExtensionContext`.
- Do not bypass workflow invariant validation.
- Do not auto-resume if the user/session/workflow has clearly moved on.
- Do not remove `/task done`, `/task lgtm`, or replay-on-next-`/task` recovery.

## Design

### 1. Keep the normal command-context path primary

Do not move normal transition handling out of `runTaskWorkspace()`.

For uninterrupted runs, the existing flow remains authoritative:

1. `/task` invokes `runTaskWorkspace(pi, ctx, root)` with a fresh `ExtensionCommandContext`.
2. `runTaskWorkspace()` navigates using that live `ctx.navigateTree(...)`.
3. It sends the prompt, captures the assistant output, dispatches the transition, clears `pending_prompt_run`, and loops if appropriate.

The optimistic continuation should only be consumed after `runTaskWorkspace()` has returned early due to an interrupted/error-looking turn. In other words:

- normal path: current command context, synchronous `/task` ownership
- fallback path: captured command context, deferred from `agent_end`

This avoids making the hack the main workflow and limits the stale-context risk to the recovery case.

### 2. Add an in-memory optimistic continuation record

Add a module-level variable near the other task-loop globals:

```ts
type OptimisticTaskContinuation = {
    root: string;
    ctx: ExtensionCommandContext;
    workflowVersion: number;
    workflowState: WorkflowState;
    activeTaskId: string;
    sessionLeafId: string;
    pendingPromptRun: PendingPromptRun;
    previousAssistantId: string | null;
    createdAt: number;
};

let optimisticTaskContinuation: OptimisticTaskContinuation | null = null;
```

Important details:

- Store `ExtensionCommandContext`, not only `ExtensionContext`, because `navigateTree()` and `waitForIdle()` are command-only APIs.
- Store a snapshot of workflow identity fields so the later resume can prove it is still operating on the same pending run.
- Store the exact `pending_prompt_run` written to `.tasks/workflow.json`.
- This is intentionally in-memory only. If Pi exits/reloads, manual `/task` recovery remains the fallback.

### 3. Capture the continuation after persisting `pending_prompt_run`

In `runTaskWorkspace()`, after `persistPendingPromptRun()` succeeds and `workflow = withPendingPromptRun.workflow`, record the continuation:

```ts
const pendingPromptRun = {
    state: workflow.state,
    active_task_id: workflow.active_task_id,
    session_leaf_id: workflow.session_leaf_id,
    previous_assistant_id: previousAssistantId,
    started_at: new Date().toISOString(),
};

const withPendingPromptRun = persistPendingPromptRun(root, workflow, pendingPromptRun);
...
workflow = withPendingPromptRun.workflow;

optimisticTaskContinuation = {
    root,
    ctx,
    workflowVersion: workflow.version,
    workflowState: workflow.state,
    activeTaskId: workflow.active_task_id,
    sessionLeafId: workflow.session_leaf_id,
    pendingPromptRun,
    previousAssistantId,
    createdAt: Date.now(),
};
```

Avoid recomputing slightly different timestamps. Build the `pendingPromptRun` object once and use it both for persistence and capture.

### 4. Clear the continuation on normal completion paths

Clear `optimisticTaskContinuation` when the owning `/task` loop no longer needs it, especially when the normal command-context path handled the turn successfully:

- after successful transition dispatch and `pending_prompt_run` is cleared
- before continuing the normal in-function workflow loop after a successful transition
- when `runTaskWorkspace()` exits because there is no prompt run
- when navigation is cancelled
- when `runTaskPrompt()` fails to start
- when the user is in `manual-test` and the loop intentionally stops
- when `workflow.state === "complete"`

Do not clear it merely because the turn ended with an error-looking assistant/tool state. That is the one case where the fallback may still be useful.

A small helper is useful:

```ts
function clearOptimisticTaskContinuation(root?: string): void {
    if (!root || optimisticTaskContinuation?.root === root) {
        optimisticTaskContinuation = null;
    }
}
```

Use targeted clearing so a stale continuation from another workspace cannot interfere.

### 5. Add validation before optimistic resume

Create a helper that loads the current workflow and checks the captured snapshot:

```ts
function loadValidOptimisticContinuation(
    continuation: OptimisticTaskContinuation,
): {workflow: PersistedWorkflow} | {skip: string} | {error: string} {
    const loaded = loadWorkflow(continuation.root);
    if ("error" in loaded) return {error: loaded.error};

    const workflow = loaded.workflow;

    if (workflow.version !== continuation.workflowVersion) {
        return {skip: "workflow version changed"};
    }
    if (workflow.state !== continuation.workflowState) {
        return {skip: "workflow state changed"};
    }
    if (workflow.active_task_id !== continuation.activeTaskId) {
        return {skip: "active task changed"};
    }
    if (workflow.session_leaf_id !== continuation.sessionLeafId) {
        return {skip: "session leaf changed"};
    }
    if (!pendingPromptRunsEqual(workflow.pending_prompt_run, continuation.pendingPromptRun)) {
        return {skip: "pending prompt run changed"};
    }

    return {workflow};
}
```

This is the main safety valve. If the user manually ran `/task`, edited `.tasks/workflow.json`, switched tasks, or otherwise changed state, optimistic resume does nothing.

### 6. Add the optimistic resume function

Add an async helper:

```ts
async function maybeOptimisticallyResumeTask(pi: ExtensionAPI): Promise<void> {
    // If a normal /task loop is still active, let it keep ownership. The captured-context
    // hack is only for after the command path has already returned.
    if (isTaskLoopActive()) return;

    const continuation = optimisticTaskContinuation;
    if (!continuation) return;

    optimisticTaskContinuation = null;

    // Optional TTL to avoid old continuations firing much later.
    if (Date.now() - continuation.createdAt > 5 * 60_000) {
        return;
    }

    const {ctx, root} = continuation;

    try {
        if (!ctx.isIdle()) {
            await ctx.waitForIdle();
        }

        const validated = loadValidOptimisticContinuation(continuation);
        if ("error" in validated) {
            ctx.ui.notify(validated.error, "error");
            return;
        }
        if ("skip" in validated) {
            if (ENABLE_TRANSITION_DEBUG) {
                ctx.ui.notify(`optimistic-resume: skipped: ${validated.skip}`, "info");
            }
            return;
        }

        const replayed = await replayPendingAssistantTransition(pi, ctx, root, validated.workflow);
        if ("error" in replayed) {
            ctx.ui.notify(replayed.error, "error");
            return;
        }

        if (!replayed.changed || replayed.workflow.state === "complete") {
            return;
        }

        await withTaskLoopGuard(() => runTaskWorkspace(pi, ctx, root));
    } catch (error) {
        // Captured command ctx may be stale after reload/session replacement.
        // This path must remain best-effort.
        try {
            ctx.ui.notify(`Optimistic /task resume failed; run /task to resume manually: ${error}`, "warning");
        } catch {
            // Ignore notify failures from stale ctx.
        }
    }
}
```

Important behavior:

- If `isTaskLoopActive()` is true, do nothing. The live command-context path gets priority.
- Clear the global before doing async work to avoid reentrancy.
- Wait for idle before using navigation or command APIs.
- Run through `replayPendingAssistantTransition()` first. This reuses existing parsing, state-machine dispatch, side effects, consumed-assistant tracking, and pending-run clearing.
- Only call `runTaskWorkspace()` if the replay actually changed workflow state and the state is not complete.

### 7. Invoke optimistic resume from `agent_end`

Update the existing handler:

```ts
pi.on("agent_end", async (_event, ctx) => {
    await maybeNotifyPendingTransitionOutsideTaskLoop(pi, ctx);

    // Fallback only. If /task is still active, maybeOptimisticallyResumeTask()
    // will no-op and the normal command-context path will handle the transition.
    setTimeout(() => {
        void maybeOptimisticallyResumeTask(pi);
    }, 0);
});
```

Why defer with `setTimeout(..., 0)`:

- `agent_end` may fire while internal event processing is still unwinding.
- Deferring gives the harness a chance to settle into idle before `waitForIdle()` / `navigateTree()` are used.
- The resume helper still explicitly waits for idle.

If `setTimeout` feels too magical, use an explicit microtask/macrotask helper with a comment explaining that this is intentionally best-effort.

### 8. Be careful with the existing error branch

Keep the existing warning branch in `runTaskWorkspace()` but make its message reflect auto-resume:

```ts
ctx.ui.notify(
    "Agent turn ended with an error; will try to auto-resume if a valid completion was recorded. Otherwise run /task to resume.",
    "warning",
);
return;
```

Do not dispatch transitions directly from this branch. While `runTaskWorkspace()` is still on the stack, normal command-context handling remains preferred. Once this branch returns and the task loop is no longer active, `agent_end` may perform optimistic replay after the event loop settles.

### 9. Session shutdown/reload cleanup

Register cleanup for session lifecycle events that invalidate captured contexts:

```ts
pi.on("session_shutdown", () => {
    optimisticTaskContinuation = null;
});
```

This avoids trying to use a command context after session replacement, reload, or quit.

Also consider clearing on `session_tree` if it was not initiated by the optimistic task loop, but the workflow snapshot validation should already catch the important cases.

## Tests

### Unit tests

Add small tests for pure helpers if they are exported or can be tested indirectly:

1. `loadValidOptimisticContinuation` accepts an unchanged workflow with matching pending run.
2. It skips when workflow version changed.
3. It skips when state changed.
4. It skips when active task changed.
5. It skips when session leaf changed.
6. It skips when `pending_prompt_run` changed or was cleared.

If exporting the helper is undesirable, factor the comparison into a pure function:

```ts
function optimisticContinuationMatchesWorkflow(
    continuation: OptimisticTaskContinuation,
    workflow: PersistedWorkflow,
): {ok: true} | {ok: false; reason: string}
```

and test that.

### Integration-ish tests with stubs

Add tests around a new injectable helper if practical:

```ts
runOptimisticResume({
    continuation,
    loadWorkflow,
    replayPendingAssistantTransition,
    runTaskWorkspace,
    notify,
    isIdle,
    waitForIdle,
})
```

Cases:

1. No continuation: does nothing.
2. Stale continuation: does not replay.
3. Valid continuation, replay returns unchanged: does not run task workspace.
4. Valid continuation, replay changes to `complete`: does not run task workspace.
5. Valid continuation, replay changes to non-complete: calls `runTaskWorkspace` once.
6. Replay error: notifies and does not run task workspace.
7. Stale command context throws: swallowed with warning, no crash.

### Manual test plan

1. Start a task workspace with `/task`.
2. Force or simulate a transient error after the task prompt is sent but before the workflow advances.
3. Let the assistant produce a valid transition/completion after the error.
4. Verify that the extension automatically replays the transition and continues to the next workflow state without requiring another `/task`.
5. Repeat with a manual workflow change before `agent_end`; verify optimistic resume skips.
6. Repeat with session reload/replacement; verify no stale context crash and manual `/task` still recovers.
7. Verify normal uninterrupted `/task` behavior is unchanged.

## Risks

### Captured command context may become stale

The runner intentionally warns against using captured contexts after session replacement/reload. This plan mitigates that by:

- clearing on `session_shutdown`
- catching all errors around optimistic resume
- falling back to manual `/task`

### Tree navigation may still be unsafe at `agent_end`

Mitigations:

- defer with `setTimeout(..., 0)`
- call `ctx.waitForIdle()`
- validate workflow snapshot immediately before replay/rerun

### Duplicate transition dispatch

Mitigations:

- clear continuation before async work
- validate `workflow.version`
- validate `pending_prompt_run`
- rely on `last_consumed_assistant_id` and `persistConsumedAssistantMessageId()`

### User surprise

Optimistic auto-resume should be visible but not noisy. Use debug notifications only behind `ENABLE_TRANSITION_DEBUG`, except for warnings/errors.

## Implementation order

1. Preserve the current `runTaskWorkspace()` transition path as the primary path.
2. Add `OptimisticTaskContinuation` type and module-level variable.
3. Add helper to clear captured continuation.
4. Add pure snapshot-match helper and tests.
5. Capture continuation after `pending_prompt_run` is persisted.
6. Clear continuation on normal completion/cancellation paths, but not on the interrupted-turn branch.
7. Add `maybeOptimisticallyResumeTask()` with an `isTaskLoopActive()` no-op guard.
8. Wire it into `agent_end` with deferred execution.
9. Add `session_shutdown` cleanup.
10. Update warning text for interrupted turns.
11. Run the test suite and manually exercise the transient-error path.

## Acceptance criteria

- Normal `/task` execution behaves as before and continues to use the live command context.
- The captured-context hack is only used after the normal `/task` loop has returned from an interrupted turn.
- If a transient interruption leaves a valid pending completion in the session, the workflow advances without the user running `/task` again.
- If the workflow/session changed, optimistic resume does nothing.
- If the captured context is stale, the extension does not crash and the user can still run `/task` manually.
- Workflow invariants and transition side effects continue to be enforced by the existing state-machine path.
