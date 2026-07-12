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
            tdd: true,
            idempotencyKey: `${ROOT}::Implement parser`,
        },
        {
            type: "CREATE_ISSUE",
            parentTaskId: ROOT,
            title: "Add tests",
            description: "Cover edge cases",
            tdd: false,
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
            tdd: true,
            idempotencyKey: `${ROOT}::Implement parser`,
        },
        {
            type: "CREATE_ISSUE",
            parentTaskId: ROOT,
            title: "Add tests",
            description: "Cover edge cases",
            tdd: false,
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

test("review: ignores clarifying-question COMPLETE without a transition", () => {
    const snapshot = makeSnapshot("review", {activeTaskId: SUBTASK, activeTaskParentId: ROOT});
    const decision = transition(
        snapshot,
        complete("review", "One clarifying question: should this also cover nil input?"),
    );

    expectKind(decision, "ignored");
    assert.equal(decision.state, "review");
    assert.deepEqual(decision.activeTaskTarget, {type: "current"});
    assert.deepEqual(decision.effects, []);

    const laterDecision = transition(
        snapshot,
        complete("review", "Looks good now.\n<transition>subtask-commit</transition>"),
    );

    expectKind(laterDecision, "applied");
    assert.equal(laterDecision.state, "subtask-commit");
    assert.deepEqual(laterDecision.activeTaskTarget, {type: "current"});
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
            tdd: true,
            idempotencyKey: `${SUBTASK}::Fix edge case`,
        },
        {
            type: "CREATE_ISSUE",
            parentTaskId: SUBTASK,
            title: "Add test",
            description: "Ensure regression coverage",
            tdd: true,
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
            tdd: true,
            idempotencyKey: `${ROOT}::Fix broken save flow`,
        },
        {
            type: "CREATE_ISSUE",
            parentTaskId: ROOT,
            title: "Update verification steps",
            description: "",
            tdd: false,
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

test("commit: appends Fixes line from root description to single-line final commit", () => {
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
        {type: "RUN_JJ_COMMIT", message: "feat: finalize workflow\n\nFixes: owner/repo#123"},
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

function makeFixSnapshot(
    state: WorkflowState,
    manualTestStatus: "undecided" | "pending" | "passed" = "undecided",
    overrides: Partial<WorkflowSnapshot> = {},
): WorkflowSnapshot {
    return {
        ...makeSnapshot(state),
        workflowKind: "fix",
        manualTestStatus,
        ...overrides,
    };
}

test("fix implement advances at the root to review", () => {
    const decision = transition(makeFixSnapshot("implement"), complete("implement", "implemented"));
    expectKind(decision, "applied");
    assert.equal(decision.state, "review");
    assert.deepEqual(decision.activeTaskTarget, {type: "root"});
});

test("fix review can approve directly to commit while manual testing is undecided", () => {
    const decision = transition(makeFixSnapshot("review"), complete("review", "<transition>commit</transition>"));
    expectKind(decision, "applied");
    assert.equal(decision.state, "commit");
    assert.equal(decision.manualTestStatus, "undecided");
});

test("fix review rejects direct commit when manual-test status is missing", () => {
    const decision = transition(
        makeSnapshot("review", {workflowKind: "fix"}),
        complete("review", "<transition>commit</transition>"),
    );

    expectKind(decision, "rejected");
    assert.equal(decision.reason, "Fix workflow snapshot is missing manualTestStatus");
});

test("fix review can select manual-test and latches it pending", () => {
    const decision = transition(makeFixSnapshot("review"), complete("review", "<transition>manual-test</transition>"));
    expectKind(decision, "applied");
    assert.equal(decision.state, "manual-test");
    assert.equal(decision.manualTestStatus, "pending");
});

test("fix review creates root finding issues", () => {
    const decision = transition(
        makeFixSnapshot("review"),
        complete("review", `
<review-findings>
- title: Fix regression
  description: Cover the missed edge case
</review-findings>
<transition>implement-review</transition>`),
    );
    expectKind(decision, "applied");
    assert.equal(decision.state, "implement-review");
    assert.deepEqual(decision.activeTaskTarget, {type: "first-created-child", parentTaskId: ROOT});
});

test("fix review rejects duplicate finding titles before creating issues", () => {
    const decision = transition(
        makeFixSnapshot("review"),
        complete("review", `
<review-findings>
- title: Fix regression
  description: Cover one edge case
- title: Fix regression
  description: Cover another edge case
</review-findings>
<transition>implement-review</transition>`),
    );

    expectKind(decision, "rejected");
    assert.equal(decision.reason, "Finding titles must be unique; duplicate title: Fix regression");
    assert.deepEqual(decision.effects, []);
});

test("fix implement-review iterates root children and returns to root review", () => {
    const next = transition(makeFixSnapshot("implement-review", "pending", {
        activeTaskId: FINDING,
        activeTaskParentId: ROOT,
        activeTaskNextSiblingId: NEXT,
    }), complete("implement-review"));
    expectKind(next, "applied");
    assert.equal(next.state, "implement-review");
    assert.deepEqual(next.activeTaskTarget, {type: "next-sibling"});

    const final = transition(makeFixSnapshot("implement-review", "pending", {
        activeTaskId: FINDING,
        activeTaskParentId: ROOT,
    }), complete("implement-review"));
    expectKind(final, "applied");
    assert.equal(final.state, "review");
    assert.deepEqual(final.activeTaskTarget, {type: "root"});
    assert.equal(final.manualTestStatus, "pending");
});

test("fix done supports implement and implement-review", () => {
    const implement = transition(makeFixSnapshot("implement"), manualDone("implement"));
    expectKind(implement, "applied");
    assert.equal(implement.state, "review");

    const finding = transition(makeFixSnapshot("implement-review", "pending", {
        activeTaskId: FINDING,
        activeTaskParentId: ROOT,
    }), manualDone("implement-review"));
    expectKind(finding, "applied");
    assert.equal(finding.state, "review");
});

test("fix lgtm respects the manual-test latch", () => {
    const undecided = transition(makeFixSnapshot("review"), {type: "FORCE_LGTM", completedState: "review"});
    expectKind(undecided, "applied");
    assert.equal(undecided.state, "commit");

    const pending = transition(makeFixSnapshot("review", "pending"), {type: "FORCE_LGTM", completedState: "review"});
    expectKind(pending, "applied");
    assert.equal(pending.state, "manual-test");

    const passed = transition(makeFixSnapshot("review", "passed"), {type: "FORCE_LGTM", completedState: "review"});
    expectKind(passed, "rejected");
});

test("fix rejects task-only states", () => {
    const decision = transition(makeFixSnapshot("plan"), complete("plan", "<transition>review-plan</transition>"));
    expectKind(decision, "rejected");
    assert.match(decision.reason, /not valid for fix workflow/);
});

test("fix review cannot skip pending or already-passed manual testing", () => {
    const pending = transition(makeFixSnapshot("review", "pending"), complete("review", "<transition>commit</transition>"));
    expectKind(pending, "rejected");
    assert.match(pending.reason, /manual testing is pending/);

    const passed = transition(makeFixSnapshot("review", "passed"), complete("review", "<transition>commit</transition>"));
    expectKind(passed, "rejected");
    assert.match(passed.reason, /only allowed while manual testing is undecided/);
});

test("fix manual-test success marks testing passed and moves to commit", () => {
    const decision = transition(makeFixSnapshot("manual-test", "pending"), complete("manual-test", "<transition>commit</transition>"));
    expectKind(decision, "applied");
    assert.equal(decision.state, "commit");
    assert.equal(decision.manualTestStatus, "passed");
});

test("fix manual-test rejects success when manual-test status is missing", () => {
    const decision = transition(
        makeSnapshot("manual-test", {workflowKind: "fix"}),
        complete("manual-test", "<transition>commit</transition>"),
    );

    expectKind(decision, "rejected");
    assert.equal(decision.reason, "Fix workflow snapshot is missing manualTestStatus");
});

test("fix manual-test creates root follow-ups and moves to implement-review", () => {
    const decision = transition(makeFixSnapshot("manual-test", "pending"), complete("manual-test", `
<manual-test-subtasks>
- title: Fix failed verification
  description: Repair the observed behavior
</manual-test-subtasks>
<transition>implement-review</transition>`));
    expectKind(decision, "applied");
    assert.equal(decision.state, "implement-review");
    assert.equal(decision.manualTestStatus, "pending");
    assert.deepEqual(decision.activeTaskTarget, {type: "first-created-child", parentTaskId: ROOT});
});

test("fix manual-test rejects duplicate follow-up titles before creating issues", () => {
    const decision = transition(makeFixSnapshot("manual-test", "pending"), complete("manual-test", `
<manual-test-subtasks>
- title: Fix failed verification
  description: Repair one failure
- title: Fix failed verification
  description: Repair another failure
</manual-test-subtasks>
<transition>implement-review</transition>`));

    expectKind(decision, "rejected");
    assert.equal(decision.reason, "Subtask titles must be unique; duplicate title: Fix failed verification");
    assert.deepEqual(decision.effects, []);
});

test("fix review returns to manual-test after follow-up implementation", () => {
    const decision = transition(makeFixSnapshot("review", "pending"), complete("review", "<transition>manual-test</transition>"));
    expectKind(decision, "applied");
    assert.equal(decision.state, "manual-test");
});

test("fix commit closes the root and creates the single commit", () => {
    const decision = transition(makeFixSnapshot("commit", "passed"), complete("commit", "<commit-message>fix: finish issue</commit-message>"));
    expectKind(decision, "applied");
    assert.equal(decision.state, "complete");
    assert.deepEqual(decision.effects, [
        {type: "CLOSE_ISSUE", taskId: ROOT},
        {type: "RUN_JJ_COMMIT", message: "fix: finish issue"},
    ]);
});
