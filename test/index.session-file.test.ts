import test from "node:test";
import assert from "node:assert/strict";

import {
    buildTaskBranchRevsetFromTaskHeadCommit,
    completionReadyToMergeNotice,
    findPendingPromptRunCompletionCandidate,
    inProgressRootIssueIdFromWorkflow,
    normalizeSessionFilePath,
    parseOriginRemoteUrlFromJjGitRemoteListOutput,
    resolveEditorPrefillValue,
    shouldNotifyPendingTransitionOutsideTaskLoop,
} from "../index.js";

test("normalizeSessionFilePath returns null for undefined", () => {
    assert.equal(normalizeSessionFilePath(undefined), null);
});

test("normalizeSessionFilePath returns null for blank input", () => {
    assert.equal(normalizeSessionFilePath("   \n\t  "), null);
});

test("normalizeSessionFilePath trims and preserves non-empty absolute paths", () => {
    assert.equal(
        normalizeSessionFilePath("  /Users/colin/.pi/agent/sessions/foo.jsonl  "),
        "/Users/colin/.pi/agent/sessions/foo.jsonl",
    );
});

test("parseOriginRemoteUrlFromJjGitRemoteListOutput extracts origin URL", () => {
    const output = [
        "upstream https://github.com/example/upstream.git",
        "origin git@github.com:owner/repo.git",
    ].join("\n");

    assert.equal(
        parseOriginRemoteUrlFromJjGitRemoteListOutput(output),
        "git@github.com:owner/repo.git",
    );
});

test("parseOriginRemoteUrlFromJjGitRemoteListOutput ignores non-origin remotes", () => {
    const output = "upstream https://github.com/example/upstream.git";

    assert.equal(
        parseOriginRemoteUrlFromJjGitRemoteListOutput(output),
        null,
    );
});

test("parseOriginRemoteUrlFromJjGitRemoteListOutput returns null for blank input", () => {
    assert.equal(parseOriginRemoteUrlFromJjGitRemoteListOutput("   \n\t"), null);
});

test("shouldNotifyPendingTransitionOutsideTaskLoop returns true for replayable unconsumed transition", () => {
    assert.equal(
        shouldNotifyPendingTransitionOutsideTaskLoop({
            workflowState: "refine",
            latestAssistantMessageId: "a1",
            latestAssistantMessageText: "<transition>plan</transition>",
            lastConsumedAssistantId: null,
            taskLoopActive: false,
        }),
        true,
    );
});

test("shouldNotifyPendingTransitionOutsideTaskLoop returns false while task loop is active", () => {
    assert.equal(
        shouldNotifyPendingTransitionOutsideTaskLoop({
            workflowState: "refine",
            latestAssistantMessageId: "a1",
            latestAssistantMessageText: "<transition>plan</transition>",
            lastConsumedAssistantId: null,
            taskLoopActive: true,
        }),
        false,
    );
});

test("shouldNotifyPendingTransitionOutsideTaskLoop returns false when assistant message already consumed", () => {
    assert.equal(
        shouldNotifyPendingTransitionOutsideTaskLoop({
            workflowState: "refine",
            latestAssistantMessageId: "a1",
            latestAssistantMessageText: "<transition>plan</transition>",
            lastConsumedAssistantId: "a1",
            taskLoopActive: false,
        }),
        false,
    );
});

test("shouldNotifyPendingTransitionOutsideTaskLoop returns false for non-replayable output", () => {
    assert.equal(
        shouldNotifyPendingTransitionOutsideTaskLoop({
            workflowState: "refine",
            latestAssistantMessageId: "a1",
            latestAssistantMessageText: "still refining",
            lastConsumedAssistantId: null,
            taskLoopActive: false,
        }),
        false,
    );
});

test("shouldNotifyPendingTransitionOutsideTaskLoop returns false when there is no assistant id", () => {
    assert.equal(
        shouldNotifyPendingTransitionOutsideTaskLoop({
            workflowState: "refine",
            latestAssistantMessageId: null,
            latestAssistantMessageText: "<transition>plan</transition>",
            lastConsumedAssistantId: null,
            taskLoopActive: false,
        }),
        false,
    );
});

test("shouldNotifyPendingTransitionOutsideTaskLoop returns true for manual-test transition", () => {
    assert.equal(
        shouldNotifyPendingTransitionOutsideTaskLoop({
            workflowState: "manual-test",
            latestAssistantMessageId: "a1",
            latestAssistantMessageText: "<transition>commit</transition>",
            lastConsumedAssistantId: null,
            taskLoopActive: false,
        }),
        true,
    );
});

test("findPendingPromptRunCompletionCandidate returns the terminal assistant for an implement-review prompt run", () => {
    const candidate = findPendingPromptRunCompletionCandidate({
        branch: [
            {type: "message", id: "a-prev", message: {role: "assistant", content: "previous", stopReason: "stop"}},
            {type: "message", id: "u-task", message: {role: "user", content: "task prompt"}},
            {type: "message", id: "a-tool", message: {role: "assistant", content: "working", stopReason: "toolUse"}},
            {type: "message", id: "tr-ok", message: {role: "toolResult", isError: false, content: "ok"}},
            {type: "message", id: "a-final", message: {role: "assistant", content: "implemented", stopReason: "stop"}},
        ],
        pendingPromptRun: {
            state: "implement-review",
            active_task_id: "19",
            session_leaf_id: "leaf-1",
            previous_assistant_id: "a-prev",
            started_at: "2026-04-03T01:17:30.728Z",
        },
        workflowState: "implement-review",
        activeTaskId: "19",
        sessionLeafId: "leaf-1",
        lastConsumedAssistantId: null,
    });

    assert.deepEqual(candidate, {
        assistantMessageId: "a-final",
        assistantMessage: "implemented",
        hadErrors: false,
    });
});

test("findPendingPromptRunCompletionCandidate recovers from tool errors when a terminal assistant message follows", () => {
    const candidate = findPendingPromptRunCompletionCandidate({
        branch: [
            {type: "message", id: "a-prev", message: {role: "assistant", content: "previous", stopReason: "stop"}},
            {type: "message", id: "u-task", message: {role: "user", content: "task prompt"}},
            {type: "message", id: "a-tool", message: {role: "assistant", content: "working", stopReason: "toolUse"}},
            {type: "message", id: "tr-fail", message: {role: "toolResult", isError: true, content: "boom"}},
            {type: "message", id: "a-final", message: {role: "assistant", content: "implemented", stopReason: "stop"}},
        ],
        pendingPromptRun: {
            state: "implement-review",
            active_task_id: "19",
            session_leaf_id: "leaf-1",
            previous_assistant_id: "a-prev",
            started_at: "2026-04-03T01:17:30.728Z",
        },
        workflowState: "implement-review",
        activeTaskId: "19",
        sessionLeafId: "leaf-1",
        lastConsumedAssistantId: null,
    });

    assert.deepEqual(candidate, {
        assistantMessageId: "a-final",
        assistantMessage: "implemented",
        hadErrors: true,
    });
});

test("findPendingPromptRunCompletionCandidate still rejects assistant error turns", () => {
    const candidate = findPendingPromptRunCompletionCandidate({
        branch: [
            {type: "message", id: "a-prev", message: {role: "assistant", content: "previous", stopReason: "stop"}},
            {type: "message", id: "u-task", message: {role: "user", content: "task prompt"}},
            {type: "message", id: "a-fail", message: {role: "assistant", content: "failed", stopReason: "error"}},
            {type: "message", id: "a-final", message: {role: "assistant", content: "implemented", stopReason: "stop"}},
        ],
        pendingPromptRun: {
            state: "implement-review",
            active_task_id: "19",
            session_leaf_id: "leaf-1",
            previous_assistant_id: "a-prev",
            started_at: "2026-04-03T01:17:30.728Z",
        },
        workflowState: "implement-review",
        activeTaskId: "19",
        sessionLeafId: "leaf-1",
        lastConsumedAssistantId: null,
    });

    assert.equal(candidate, null);
});

test("findPendingPromptRunCompletionCandidate ignores later unrelated turns after the prompt run", () => {
    const candidate = findPendingPromptRunCompletionCandidate({
        branch: [
            {type: "message", id: "a-prev", message: {role: "assistant", content: "previous", stopReason: "stop"}},
            {type: "message", id: "u-task", message: {role: "user", content: "task prompt"}},
            {type: "message", id: "a-final", message: {role: "assistant", content: "implemented", stopReason: "stop"}},
            {type: "message", id: "u-later", message: {role: "user", content: "another question"}},
            {type: "message", id: "a-later", message: {role: "assistant", content: "unrelated", stopReason: "stop"}},
        ],
        pendingPromptRun: {
            state: "implement-review",
            active_task_id: "19",
            session_leaf_id: "leaf-1",
            previous_assistant_id: "a-prev",
            started_at: "2026-04-03T01:17:30.728Z",
        },
        workflowState: "implement-review",
        activeTaskId: "19",
        sessionLeafId: "leaf-1",
        lastConsumedAssistantId: null,
    });

    assert.deepEqual(candidate, {
        assistantMessageId: "a-final",
        assistantMessage: "implemented",
        hadErrors: false,
    });
});

test("completionReadyToMergeNotice returns message when transition changed to complete", () => {
    assert.equal(
        completionReadyToMergeNotice({changed: true, nextState: "complete"}),
        "Final commit succeeded. Task workspace is ready to merge.",
    );
});

test("completionReadyToMergeNotice returns null when transition did not change", () => {
    assert.equal(
        completionReadyToMergeNotice({changed: false, nextState: "complete"}),
        null,
    );
});

test("completionReadyToMergeNotice returns null when next state is not complete", () => {
    assert.equal(
        completionReadyToMergeNotice({changed: true, nextState: "commit"}),
        null,
    );
});

test("resolveEditorPrefillValue falls back to default on undefined", () => {
    assert.equal(
        resolveEditorPrefillValue(undefined, "default-value"),
        "default-value",
    );
});

test("resolveEditorPrefillValue falls back to default on blank input", () => {
    assert.equal(
        resolveEditorPrefillValue("   \n\t  ", "default-value"),
        "default-value",
    );
});

test("resolveEditorPrefillValue trims surrounding whitespace", () => {
    assert.equal(
        resolveEditorPrefillValue("   custom value   ", "default-value"),
        "custom value",
    );
});

test("resolveEditorPrefillValue singleLine mode uses first non-empty line", () => {
    assert.equal(
        resolveEditorPrefillValue("\n\n first-line \n second-line", "default-value", {singleLine: true}),
        "first-line",
    );
});

test("buildTaskBranchRevsetFromTaskHeadCommit uses commit_id selectors", () => {
    assert.equal(
        buildTaskBranchRevsetFromTaskHeadCommit("abc123"),
        "(::commit_id(abc123) ~ ::fork_point(commit_id(abc123) | @-)) & ~empty()",
    );
});

test("buildTaskBranchRevsetFromTaskHeadCommit trims whitespace", () => {
    assert.equal(
        buildTaskBranchRevsetFromTaskHeadCommit("  abc123  \n"),
        "(::commit_id(abc123) ~ ::fork_point(commit_id(abc123) | @-)) & ~empty()",
    );
});

test("inProgressRootIssueIdFromWorkflow returns root issue id for non-complete workflow", () => {
    assert.equal(
        inProgressRootIssueIdFromWorkflow({
            workflowState: "implement",
            rootTaskId: "123",
        }),
        "123",
    );
});

test("inProgressRootIssueIdFromWorkflow excludes complete workflow", () => {
    assert.equal(
        inProgressRootIssueIdFromWorkflow({
            workflowState: "complete",
            rootTaskId: "123",
        }),
        null,
    );
});

test("inProgressRootIssueIdFromWorkflow rejects invalid issue ids", () => {
    assert.equal(
        inProgressRootIssueIdFromWorkflow({
            workflowState: "review",
            rootTaskId: "tp-123",
        }),
        null,
    );
});
