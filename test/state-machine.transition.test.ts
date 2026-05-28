import test from "node:test";
import assert from "node:assert/strict";

import {
    transition,
    type TransitionDecision,
    type WorkflowEvent,
    type WorkflowSnapshot,
    type WorkflowState,
} from "../state-machine.js";

const ROOT = "TASK-ROOT";
const SUBTASK = "TASK-SUB";
const FINDING = "TASK-FIND";
const NEXT = "TASK-NEXT";

const VALID_PLAN_MARKDOWN = `
# Root

## Plan
<subtasks>
- title: Implement parser
  description: Add parser behavior
- title: Add tests
  description: Cover edge cases
  tdd: false
</subtasks>
`;

const EMPTY_PLAN_MARKDOWN = `
## Plan
<subtasks>
[]
</subtasks>
`;

const INLINE_PLAN_MARKDOWN = `
## Plan
<subtasks>- title: Inline subtask
  description: Inline fallback parser path</subtasks>
`;

const ROOT_DESCRIPTION_WITH_FIXES_MARKDOWN = `
# Root

Implement deterministic task close behavior.
Fixes: owner/repo#123

## Plan
<subtasks>
- title: Implement parser
  description: Add parser behavior
</subtasks>
`;

const ROOT_SECTION_WITH_FIXES_MARKDOWN = `
# Root

Implement deterministic task close behavior.

## Summary of Changes
Fixes: owner/repo#123
`;

function makeSnapshot(state: WorkflowState, overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
    return {
        state,
        rootTaskId: ROOT,
        activeTaskId: ROOT,
        activeTaskParentId: null,
        activeTaskNextSiblingId: null,
        ...overrides,
    };
}

function complete(
    completedState: WorkflowState,
    assistantMessage = "",
    rootIssueMarkdown = "",
): WorkflowEvent {
    return {type: "COMPLETE", completedState, assistantMessage, rootIssueMarkdown};
}

function expectKind<TKind extends TransitionDecision["kind"]>(
    decision: TransitionDecision,
    kind: TKind,
): asserts decision is Extract<TransitionDecision, { kind: TKind }> {
    assert.equal(decision.kind, kind);
}

test("refine: ignores interactive COMPLETE without a transition", () => {
    const decision = transition(makeSnapshot("refine"), complete("refine", "Still refining"));

    expectKind(decision, "ignored");
    assert.equal(decision.state, "refine");
    assert.equal(decision.activeTaskTarget.type, "current");
    assert.deepEqual(decision.effects, []);
});

test("refine: transitions to plan on <transition>plan</transition>", () => {
    const decision = transition(makeSnapshot("refine"), complete("refine", "<transition>plan</transition>"));

    expectKind(decision, "applied");
    assert.equal(decision.state, "plan");
    assert.deepEqual(decision.activeTaskTarget, {type: "root"});
});

test("refine: rejects unexpected transition tags", () => {
    const decision = transition(makeSnapshot("refine"), complete("refine", "<transition>review-plan</transition>"));

    expectKind(decision, "rejected");
    assert.equal(decision.reason, "Expected <transition>plan</transition>");
});

test("plan: ignores interactive COMPLETE without a transition", () => {
    const decision = transition(makeSnapshot("plan"), complete("plan", "Need more details"));

    expectKind(decision, "ignored");
    assert.equal(decision.state, "plan");
});

test("plan: rejects unexpected transition tags", () => {
    const decision = transition(
        makeSnapshot("plan"),
        complete("plan", "<transition>implement</transition>", VALID_PLAN_MARKDOWN),
    );

    expectKind(decision, "rejected");
    assert.equal(decision.reason, "Expected <transition>review-plan</transition>");
});

test("plan: rejects review-plan transition when root markdown is missing", () => {
    const decision = transition(
        makeSnapshot("plan"),
        complete("plan", "<transition>review-plan</transition>"),
    );

    expectKind(decision, "rejected");
    assert.equal(decision.reason, "Cannot move to review-plan: Root issue markdown is required.");
});

test("plan: rejects review-plan transition when plan subtasks are empty", () => {
    const decision = transition(
        makeSnapshot("plan"),
        complete("plan", "<transition>review-plan</transition>", EMPTY_PLAN_MARKDOWN),
    );

    expectKind(decision, "rejected");
    assert.equal(
        decision.reason,
        "Expected non-empty ## Plan/<subtasks>...</subtasks> in root issue before moving to review-plan",
    );
});

test("plan: transitions to review-plan when valid subtasks exist", () => {
    const decision = transition(
        makeSnapshot("plan"),
        complete("plan", "<transition>review-plan</transition>", VALID_PLAN_MARKDOWN),
    );

    expectKind(decision, "applied");
    assert.equal(decision.state, "review-plan");
    assert.deepEqual(decision.activeTaskTarget, {type: "root"});
});

test("plan: supports inline <subtasks>...</subtasks> fallback format", () => {
    const decision = transition(
        makeSnapshot("plan"),
        complete("plan", "<transition>review-plan</transition>", INLINE_PLAN_MARKDOWN),
    );

    expectKind(decision, "applied");
    assert.equal(decision.state, "review-plan");
    assert.deepEqual(decision.activeTaskTarget, {type: "root"});
});

test("review-plan: can remain in review-plan for re-review", () => {
    const decision = transition(
        makeSnapshot("review-plan"),
        complete("review-plan", "<transition>review-plan</transition>", VALID_PLAN_MARKDOWN),
    );

    expectKind(decision, "applied");
    assert.equal(decision.state, "review-plan");
    assert.deepEqual(decision.activeTaskTarget, {type: "current"});
    assert.deepEqual(decision.effects, []);
});

test("review-plan: rejects re-review when plan block is missing", () => {
    const decision = transition(
        makeSnapshot("review-plan"),
        complete("review-plan", "<transition>review-plan</transition>", "# no plan"),
    );

    expectKind(decision, "rejected");
    assert.equal(
        decision.reason,
        "Cannot re-review: Could not find a `## Plan` section with a <subtasks>...</subtasks> block.",
    );
});

test("review-plan: rejects re-review when plan subtasks are empty", () => {
    const decision = transition(
        makeSnapshot("review-plan"),
        complete("review-plan", "<transition>review-plan</transition>", EMPTY_PLAN_MARKDOWN),
    );

    expectKind(decision, "rejected");
    assert.equal(decision.reason, "Cannot re-review: no plan subtasks found in root issue markdown");
});

test("review-plan: rejects implement transition when plan block is missing", () => {
    const decision = transition(
        makeSnapshot("review-plan"),
        complete("review-plan", "<transition>implement</transition>", "# no plan"),
    );

    expectKind(decision, "rejected");
    assert.equal(
        decision.reason,
        "Cannot approve plan: Could not find a `## Plan` section with a <subtasks>...</subtasks> block.",
    );
});

test("review-plan: rejects implement transition when plan subtasks are empty", () => {
    const decision = transition(
        makeSnapshot("review-plan"),
        complete("review-plan", "<transition>implement</transition>", EMPTY_PLAN_MARKDOWN),
    );

    expectKind(decision, "rejected");
    assert.equal(decision.reason, "Cannot approve plan: no plan subtasks found in root issue markdown");
});

test("review-plan: rejects unexpected transition tags", () => {
    const decision = transition(
        makeSnapshot("review-plan"),
        complete("review-plan", "<transition>commit</transition>", VALID_PLAN_MARKDOWN),
    );

    expectKind(decision, "rejected");
    assert.equal(
        decision.reason,
        "Expected <transition>implement</transition> or <transition>review-plan</transition>",
    );
});

test("review-plan: approval creates subtasks and moves to implement", () => {
    const decision = transition(
        makeSnapshot("review-plan"),
        complete("review-plan", "<transition>implement</transition>", VALID_PLAN_MARKDOWN),
    );

    expectKind(decision, "applied");
    assert.equal(decision.state, "implement");
    assert.deepEqual(decision.activeTaskTarget, {type: "first-created-child", parentTaskId: ROOT});
    assert.deepEqual(decision.effects, [
        {
            type: "CREATE_ISSUE",
            parentTaskId: ROOT,
            title: "Implement parser",
            description: "Add parser behavior",
            idempotencyKey: `${ROOT}::Implement parser`,
        },
        {
            type: "CREATE_ISSUE",
            parentTaskId: ROOT,
            title: "Add tests",
            description: "Cover edge cases",
            idempotencyKey: `${ROOT}::Add tests`,
        },
    ]);
});

test("review-plan: force LGTM creates subtasks and appends note", () => {
    const decision = transition(
        makeSnapshot("review-plan"),
        {
            type: "FORCE_LGTM",
            completedState: "review-plan",
            rootIssueMarkdown: VALID_PLAN_MARKDOWN,
        },
    );

    expectKind(decision, "applied");
    assert.equal(decision.state, "implement");
    assert.deepEqual(decision.activeTaskTarget, {type: "first-created-child", parentTaskId: ROOT});
    assert.deepEqual(decision.effects, [
        {
            type: "CREATE_ISSUE",
            parentTaskId: ROOT,
            title: "Implement parser",
            description: "Add parser behavior",
            idempotencyKey: `${ROOT}::Implement parser`,
        },
        {
            type: "CREATE_ISSUE",
            parentTaskId: ROOT,
            title: "Add tests",
            description: "Cover edge cases",
            idempotencyKey: `${ROOT}::Add tests`,
        },
        {
            type: "ADD_NOTE",
            taskId: ROOT,
            note: "Forced LGTM via /task lgtm (skipping plan review findings).",
        },
    ]);
});

test("review-plan: rejects force LGTM when plan markdown is missing", () => {
    const decision = transition(
        makeSnapshot("review-plan"),
        {
            type: "FORCE_LGTM",
            completedState: "review-plan",
        },
    );

    expectKind(decision, "rejected");
    assert.equal(decision.reason, "Cannot force approval: Root issue markdown is required.");
});

test("review-plan: rejects force LGTM when plan subtasks are empty", () => {
    const decision = transition(
        makeSnapshot("review-plan"),
        {
            type: "FORCE_LGTM",
            completedState: "review-plan",
            rootIssueMarkdown: EMPTY_PLAN_MARKDOWN,
        },
    );

    expectKind(decision, "rejected");
    assert.equal(decision.reason, "Cannot force approval: no plan subtasks found in root issue markdown");
});

test("implement: always advances to review", () => {
    const decision = transition(
        makeSnapshot("implement", {activeTaskId: SUBTASK, activeTaskParentId: ROOT}),
        complete("implement", "any assistant output"),
    );

    expectKind(decision, "applied");
    assert.equal(decision.state, "review");
    assert.deepEqual(decision.activeTaskTarget, {type: "current"});
});

function manualDone(completedState: WorkflowState): WorkflowEvent {
    return {type: "MANUAL_DONE", completedState};
}

test("manual done: advances implement to review", () => {
    const decision = transition(
        makeSnapshot("implement", {activeTaskId: SUBTASK, activeTaskParentId: ROOT}),
        manualDone("implement"),
    );

    expectKind(decision, "applied");
    assert.equal(decision.state, "review");
    assert.deepEqual(decision.activeTaskTarget, {type: "current"});
    assert.deepEqual(decision.effects, []);
});

test("manual done: advances implement-review like a completed implementation turn", () => {
    const withNext = transition(
        makeSnapshot("implement-review", {
            activeTaskId: FINDING,
            activeTaskParentId: SUBTASK,
            activeTaskNextSiblingId: NEXT,
        }),
        manualDone("implement-review"),
    );

    expectKind(withNext, "applied");
    assert.equal(withNext.state, "implement-review");
    assert.deepEqual(withNext.activeTaskTarget, {type: "next-sibling"});
    assert.deepEqual(withNext.effects, [{type: "CLOSE_ISSUE", taskId: FINDING}]);

    const lastFinding = transition(
        makeSnapshot("implement-review", {
            activeTaskId: FINDING,
            activeTaskParentId: SUBTASK,
            activeTaskNextSiblingId: null,
        }),
        manualDone("implement-review"),
    );

    expectKind(lastFinding, "applied");
    assert.equal(lastFinding.state, "review");
    assert.deepEqual(lastFinding.activeTaskTarget, {type: "parent"});
    assert.deepEqual(lastFinding.effects, [{type: "CLOSE_ISSUE", taskId: FINDING}]);
});

test("manual done: rejects unsupported states", () => {
    const decision = transition(makeSnapshot("review"), manualDone("review"));

    expectKind(decision, "rejected");
    assert.equal(decision.reason, "MANUAL_DONE is only valid in implement or implement-review");
});

test("review: approve path transitions to subtask-commit", () => {
    const decision = transition(
        makeSnapshot("review", {activeTaskId: SUBTASK, activeTaskParentId: ROOT}),
        complete("review", "<transition>subtask-commit</transition>"),
    );

    expectKind(decision, "applied");
    assert.equal(decision.state, "subtask-commit");
    assert.deepEqual(decision.activeTaskTarget, {type: "current"});
});

test("review: rejects no transition and no findings", () => {
    const decision = transition(
        makeSnapshot("review", {activeTaskId: SUBTASK, activeTaskParentId: ROOT}),
        complete("review", "Still reviewing this change"),
    );

    expectKind(decision, "rejected");
    assert.equal(
        decision.reason,
        "Expected <transition>subtask-commit</transition> or findings + <transition>implement-review</transition>",
    );
});

test("review: findings + implement-review transition creates child finding issues", () => {
    const decision = transition(
        makeSnapshot("review", {activeTaskId: SUBTASK, activeTaskParentId: ROOT}),
        complete(
            "review",
            `
<review-findings>
- title: Fix edge case
  description: Handle nil input
- title: Add test
  description: Ensure regression coverage
</review-findings>
<transition>implement-review</transition>
`,
        ),
    );

    expectKind(decision, "applied");
    assert.equal(decision.state, "implement-review");
    assert.deepEqual(decision.activeTaskTarget, {type: "first-created-child", parentTaskId: SUBTASK});
    assert.deepEqual(decision.effects, [
        {
            type: "CREATE_ISSUE",
            parentTaskId: SUBTASK,
            title: "Fix edge case",
            description: "Handle nil input",
            idempotencyKey: `${SUBTASK}::Fix edge case`,
        },
        {
            type: "CREATE_ISSUE",
            parentTaskId: SUBTASK,
            title: "Add test",
            description: "Ensure regression coverage",
            idempotencyKey: `${SUBTASK}::Add test`,
        },
    ]);
});

test("review: rejects implement-review transition with no findings", () => {
    const decision = transition(
        makeSnapshot("review", {activeTaskId: SUBTASK, activeTaskParentId: ROOT}),
        complete("review", "<transition>implement-review</transition>"),
    );

    expectKind(decision, "rejected");
    assert.equal(
        decision.reason,
        "Got <transition>implement-review</transition> but no <review-findings> block",
    );
});

test("review: malformed findings YAML rejects transition", () => {
    const decision = transition(
        makeSnapshot("review", {activeTaskId: SUBTASK, activeTaskParentId: ROOT}),
        complete(
            "review",
            `
<review-findings>
- title: [
</review-findings>
<transition>implement-review</transition>
`,
        ),
    );

    expectKind(decision, "rejected");
    assert.match(decision.reason, /Failed to parse Finding YAML block/);
});

test("review: force LGTM moves directly to subtask-commit with note", () => {
    const decision = transition(
        makeSnapshot("review", {activeTaskId: SUBTASK, activeTaskParentId: ROOT}),
        {
            type: "FORCE_LGTM",
            completedState: "review",
        },
    );

    expectKind(decision, "applied");
    assert.equal(decision.state, "subtask-commit");
    assert.deepEqual(decision.effects, [
        {
            type: "ADD_NOTE",
            taskId: SUBTASK,
            note: "Forced LGTM via /task lgtm (skipping review findings).",
        },
    ]);
});

test("implement-review: rejects when activeTaskParentId is missing", () => {
    const decision = transition(
        makeSnapshot("implement-review", {activeTaskId: FINDING, activeTaskParentId: null}),
        complete("implement-review", "done"),
    );

    expectKind(decision, "rejected");
    assert.equal(decision.reason, "implement-review requires activeTaskParentId in snapshot");
});

test("implement-review: moves to next sibling finding when present", () => {
    const decision = transition(
        makeSnapshot("implement-review", {
            activeTaskId: FINDING,
            activeTaskParentId: SUBTASK,
            activeTaskNextSiblingId: NEXT,
        }),
        complete("implement-review", "done"),
    );

    expectKind(decision, "applied");
    assert.equal(decision.state, "implement-review");
    assert.deepEqual(decision.activeTaskTarget, {type: "next-sibling"});
    assert.deepEqual(decision.effects, [{type: "CLOSE_ISSUE", taskId: FINDING}]);
});

test("implement-review: returns to parent review when there is no next sibling", () => {
    const decision = transition(
        makeSnapshot("implement-review", {
            activeTaskId: FINDING,
            activeTaskParentId: SUBTASK,
            activeTaskNextSiblingId: null,
        }),
        complete("implement-review", "done"),
    );

    expectKind(decision, "applied");
    assert.equal(decision.state, "review");
    assert.deepEqual(decision.activeTaskTarget, {type: "parent"});
    assert.deepEqual(decision.effects, [{type: "CLOSE_ISSUE", taskId: FINDING}]);
});

test("subtask-commit: rejects when commit message is missing", () => {
    const decision = transition(
        makeSnapshot("subtask-commit", {activeTaskId: SUBTASK, activeTaskParentId: ROOT}),
        complete("subtask-commit", "no commit message"),
    );

    expectKind(decision, "rejected");
    assert.equal(decision.reason, "Expected <commit-message>...</commit-message>");
});

test("subtask-commit: with next sibling, commits and advances to implement", () => {
    const decision = transition(
        makeSnapshot("subtask-commit", {
            activeTaskId: SUBTASK,
            activeTaskParentId: ROOT,
            activeTaskNextSiblingId: NEXT,
        }),
        complete(
            "subtask-commit",
            `
<commit-message>
feat: complete subtask

details
</commit-message>
`,
        ),
    );

    expectKind(decision, "applied");
    assert.equal(decision.state, "implement");
    assert.deepEqual(decision.activeTaskTarget, {type: "next-sibling"});
    assert.deepEqual(decision.effects, [
        {type: "CLOSE_ISSUE", taskId: SUBTASK},
        {type: "RUN_JJ_COMMIT", message: "feat: complete subtask\n\ndetails"},
    ]);
});

test("subtask-commit: last subtask moves to manual-test", () => {
    const decision = transition(
        makeSnapshot("subtask-commit", {
            activeTaskId: SUBTASK,
            activeTaskParentId: ROOT,
            activeTaskNextSiblingId: null,
        }),
        complete("subtask-commit", "<commit-message>chore: finish subtask</commit-message>"),
    );

    expectKind(decision, "applied");
    assert.equal(decision.state, "manual-test");
    assert.deepEqual(decision.activeTaskTarget, {type: "root"});
});

test("manual-test: COMPLETE transitions to commit on <transition>commit</transition>", () => {
    const decision = transition(makeSnapshot("manual-test"), complete("manual-test", "<transition>commit</transition>"));

    expectKind(decision, "applied");
    assert.equal(decision.state, "commit");
    assert.deepEqual(decision.activeTaskTarget, {type: "root"});
});

test("manual-test: ignores interactive COMPLETE without a transition", () => {
    const decision = transition(makeSnapshot("manual-test"), complete("manual-test", "Manual verification is still in progress."));

    expectKind(decision, "ignored");
    assert.equal(decision.state, "manual-test");
    assert.deepEqual(decision.activeTaskTarget, {type: "current"});
});

test("manual-test: implement transition requires manual-test subtasks", () => {
    const decision = transition(makeSnapshot("manual-test"), complete("manual-test", "<transition>implement</transition>"));

    expectKind(decision, "rejected");
    assert.equal(
        decision.reason,
        "Got <transition>implement</transition> but no <manual-test-subtasks> block",
    );
});

test("manual-test: implement transition creates root subtasks and moves to implement", () => {
    const decision = transition(
        makeSnapshot("manual-test"),
        complete(
            "manual-test",
            `
<manual-test-subtasks>
- title: Fix broken save flow
  description: Restore successful save after manual repro
- title: Update verification steps
  tdd: false
</manual-test-subtasks>
<transition>implement</transition>
`,
        ),
    );

    expectKind(decision, "applied");
    assert.equal(decision.state, "implement");
    assert.deepEqual(decision.activeTaskTarget, {type: "first-created-child", parentTaskId: ROOT});
    assert.deepEqual(decision.effects, [
        {
            type: "CREATE_ISSUE",
            parentTaskId: ROOT,
            title: "Fix broken save flow",
            description: "Restore successful save after manual repro",
            idempotencyKey: `${ROOT}::Fix broken save flow`,
        },
        {
            type: "CREATE_ISSUE",
            parentTaskId: ROOT,
            title: "Update verification steps",
            description: "",
            idempotencyKey: `${ROOT}::Update verification steps`,
        },
    ]);
});

test("commit: requires commit message", () => {
    const decision = transition(makeSnapshot("commit"), complete("commit", "no commit message"));

    expectKind(decision, "rejected");
    assert.equal(decision.reason, "Expected <commit-message>...</commit-message>");
});

test("commit: closes root issue and moves workflow to complete", () => {
    const decision = transition(
        makeSnapshot("commit"),
        complete("commit", "<commit-message>feat: finalize workflow</commit-message>"),
    );

    expectKind(decision, "applied");
    assert.equal(decision.state, "complete");
    assert.deepEqual(decision.activeTaskTarget, {type: "root"});
    assert.deepEqual(decision.effects, [
        {type: "CLOSE_ISSUE", taskId: ROOT},
        {type: "RUN_JJ_COMMIT", message: "feat: finalize workflow"},
    ]);
});

test("commit: appends Fixes line from root description to multiline final commit", () => {
    const decision = transition(
        makeSnapshot("commit"),
        complete(
            "commit",
            "<commit-message>feat: finalize workflow\n\nSummary body</commit-message>",
            ROOT_DESCRIPTION_WITH_FIXES_MARKDOWN,
        ),
    );

    expectKind(decision, "applied");
    assert.deepEqual(decision.effects, [
        {type: "CLOSE_ISSUE", taskId: ROOT},
        {
            type: "RUN_JJ_COMMIT",
            message: "feat: finalize workflow\n\nSummary body\n\nFixes: owner/repo#123",
        },
    ]);
});

test("commit: does not append Fixes line for single-line final commit message", () => {
    const decision = transition(
        makeSnapshot("commit"),
        complete(
            "commit",
            "<commit-message>feat: finalize workflow</commit-message>",
            ROOT_DESCRIPTION_WITH_FIXES_MARKDOWN,
        ),
    );

    expectKind(decision, "applied");
    assert.deepEqual(decision.effects, [
        {type: "CLOSE_ISSUE", taskId: ROOT},
        {type: "RUN_JJ_COMMIT", message: "feat: finalize workflow"},
    ]);
});

test("commit: does not duplicate Fixes line if already present in commit message", () => {
    const decision = transition(
        makeSnapshot("commit"),
        complete(
            "commit",
            "<commit-message>feat: finalize workflow\n\nSummary body\n\nFixes: owner/repo#123</commit-message>",
            ROOT_DESCRIPTION_WITH_FIXES_MARKDOWN,
        ),
    );

    expectKind(decision, "applied");
    assert.deepEqual(decision.effects, [
        {type: "CLOSE_ISSUE", taskId: ROOT},
        {
            type: "RUN_JJ_COMMIT",
            message: "feat: finalize workflow\n\nSummary body\n\nFixes: owner/repo#123",
        },
    ]);
});

test("commit: only considers Fixes line from root description (not later sections)", () => {
    const decision = transition(
        makeSnapshot("commit"),
        complete(
            "commit",
            "<commit-message>feat: finalize workflow\n\nSummary body</commit-message>",
            ROOT_SECTION_WITH_FIXES_MARKDOWN,
        ),
    );

    expectKind(decision, "applied");
    assert.deepEqual(decision.effects, [
        {type: "CLOSE_ISSUE", taskId: ROOT},
        {type: "RUN_JJ_COMMIT", message: "feat: finalize workflow\n\nSummary body"},
    ]);
});

test("complete: ignores COMPLETE events", () => {
    const decision = transition(makeSnapshot("complete"), complete("complete", "anything"));

    expectKind(decision, "ignored");
    assert.equal(decision.reason, "Workflow is complete");
    assert.equal(decision.state, "complete");
});

test("rejects stale COMPLETE and FORCE_LGTM events", () => {
    const staleComplete = transition(makeSnapshot("refine"), complete("plan", "<transition>plan</transition>"));
    expectKind(staleComplete, "rejected");
    assert.equal(staleComplete.reason, "Stale COMPLETE event for a different state");

    const staleForce = transition(makeSnapshot("review"), {
        type: "FORCE_LGTM",
        completedState: "plan",
        rootIssueMarkdown: VALID_PLAN_MARKDOWN,
    });
    expectKind(staleForce, "rejected");
    assert.equal(staleForce.reason, "Stale FORCE_LGTM event for a different state");
});

test("FORCE_LGTM is rejected in unsupported states", () => {
    const decision = transition(makeSnapshot("refine"), {
        type: "FORCE_LGTM",
        completedState: "refine",
        rootIssueMarkdown: VALID_PLAN_MARKDOWN,
    });

    expectKind(decision, "rejected");
    assert.equal(decision.reason, "FORCE_LGTM is only valid in review-plan or review");
});
