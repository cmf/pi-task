import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    createInitialWorkflow,
    dispatchWorkflowEventForTest,
    finalCommitActionForWorkingCopy,
    fixCommitPreflightAction,
    issueNeedsClose,
    loadWorkflowForTest,
    loadWorkflowPrompt,
    stateAllowsActiveDepthForKind,
    validateWorkflowCommandKind,
    validateWorkflowForTest,
} from "../index.js";

function makeTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function loadWorkflowState(root: string): string {
    const loaded = loadWorkflowForTest(root);
    assert.ok(!("error" in loaded));
    return loaded.workflow.state;
}

function makeFixCommitWorkflow(root: string) {
    const workflow = createInitialWorkflow("fix", "123", "Fix bug", "leaf");
    workflow.state = "commit";
    workflow.manual_test_status = "passed";
    fs.mkdirSync(path.join(root, ".tasks"), {recursive: true});
    fs.writeFileSync(path.join(root, ".tasks", "workflow.json"), JSON.stringify(workflow));
    return workflow;
}

function makeTaskCommitWorkflow(root: string) {
    const workflow = createInitialWorkflow("task", "123", "Fix bug", "leaf");
    workflow.state = "commit";
    fs.mkdirSync(path.join(root, ".tasks"), {recursive: true});
    fs.writeFileSync(path.join(root, ".tasks", "workflow.json"), JSON.stringify(workflow));
    return workflow;
}

function makeFinalizationHarness(options: {hasChanges: boolean; commitFails?: boolean}) {
    let hasChanges = options.hasChanges;
    const calls: string[] = [];
    const pi = {
        exec: async (command: string, args: string[]) => {
            if (command !== "jj") throw new Error(`Unexpected command: ${command}`);
            if (args[0] === "diff") {
                return {code: 0, stdout: hasChanges ? "diff --git a/file b/file" : "", stderr: ""};
            }
            if (args[0] === "log") {
                return {code: 0, stdout: "previous commit", stderr: ""};
            }
            if (args[0] === "commit") {
                calls.push("commit");
                if (options.commitFails) return {code: 1, stdout: "", stderr: "commit failed"};
                hasChanges = false;
                return {code: 0, stdout: "", stderr: ""};
            }
            throw new Error(`Unexpected jj arguments: ${args.join(" ")}`);
        },
    };
    const ctx = {
        ui: {notify: () => undefined},
        sessionManager: {getSessionId: () => undefined},
    };
    const closeIssue = async (_pi: unknown, _root: string, taskId: string) => {
        calls.push(`close:${taskId}`);
        return {ok: true as const};
    };
    return {pi, ctx, closeIssue, calls};
}

const finalCommitEvent = {
    type: "COMPLETE" as const,
    completedState: "commit" as const,
    rootIssueMarkdown: "# Fix bug",
    assistantMessage: "<commit-message>fix: finish issue</commit-message>",
};

test("schema 1 workflows migrate atomically to task kind without a workflow version increment", () => {
    const root = makeTempDir("pi-task-migrate-");
    fs.mkdirSync(path.join(root, ".tasks"), {recursive: true});
    fs.writeFileSync(path.join(root, ".tasks", "workflow.json"), JSON.stringify({
        schema_version: 1,
        task_id: "123",
        title: "Existing task",
        subtasks: [],
        state: "refine",
        active_task_id: "123",
        active_path_ids: ["123"],
        session_leaf_id: "leaf",
        version: 7,
        updated_at: "2026-01-01T00:00:00.000Z",
    }));

    const loaded = loadWorkflowForTest(root);
    assert.ok(!("error" in loaded));
    assert.equal(loaded.workflow.schema_version, 2);
    assert.equal(loaded.workflow.workflow_kind, "task");
    assert.equal(loaded.workflow.version, 7);

    const saved = JSON.parse(fs.readFileSync(path.join(root, ".tasks", "workflow.json"), "utf8"));
    assert.equal(saved.schema_version, 2);
    assert.equal(saved.workflow_kind, "task");
    assert.equal(saved.version, 7);
});

test("fix workflow initialization starts at root implement with undecided manual testing", () => {
    const workflow = createInitialWorkflow("fix", "123", "Fix bug", "leaf");
    assert.equal(workflow.workflow_kind, "fix");
    assert.equal(workflow.state, "implement");
    assert.equal(workflow.manual_test_status, "undecided");
    assert.deepEqual(workflow.active_path_ids, ["123"]);
});

test("reusing a child updates changed finding details and removes its stale TDD exemption marker", async () => {
    const root = makeTempDir("pi-fix-reused-child-tdd-");
    const workflow = createInitialWorkflow("fix", "123", "Fix bug", "leaf");
    workflow.state = "review";
    fs.mkdirSync(path.join(root, ".tasks"), {recursive: true});
    fs.writeFileSync(path.join(root, ".tasks", "workflow.json"), JSON.stringify(workflow));

    const originalFetch = globalThis.fetch;
    const originalRepository = process.env.GITHUB_REPOSITORY;
    const originalToken = process.env.GITHUB_TOKEN;
    let updatedBody: string | null = null;
    process.env.GITHUB_REPOSITORY = "owner/repo";
    process.env.GITHUB_TOKEN = "token";

    globalThis.fetch = (async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
            query: string;
            variables: Record<string, unknown>;
        };
        const issue = (number: number, body: string) => ({
            id: `issue-${number}`,
            number,
            title: number === 123 ? "Fix bug" : "Existing finding",
            body,
            state: "OPEN",
            createdAt: "2026-01-01T00:00:00.000Z",
            closedAt: null,
            parent: number === 123 ? null : {id: "issue-123", number: 123, title: "Fix bug"},
            labels: {nodes: []},
        });

        let data: unknown;
        if (request.query.includes("query IssueByNumber")) {
            const number = request.variables.number as number;
            data = {repository: {issue: issue(number, number === 456 ? "Existing body\n\n<!-- tdd: false -->" : "Root body")}};
        } else if (request.query.includes("query ListSubIssues")) {
            data = {
                node: {
                    subIssues: {
                        nodes: [issue(456, "Existing body\n\n<!-- tdd: false -->")],
                        pageInfo: {hasNextPage: false, endCursor: null},
                    },
                },
            };
        } else if (request.query.includes("mutation UpdateIssueBody")) {
            updatedBody = request.variables.body as string;
            data = {updateIssue: {issue: issue(456, updatedBody)}};
        } else {
            throw new Error(`Unexpected GraphQL request: ${request.query}`);
        }

        return new Response(JSON.stringify({data}), {
            status: 200,
            headers: {"content-type": "application/json"},
        });
    }) as typeof fetch;

    try {
        const result = await dispatchWorkflowEventForTest(
            {exec: async () => { throw new Error("Unexpected command"); }} as never,
            {ui: {notify: () => undefined}, sessionManager: {getSessionId: () => undefined}} as never,
            root,
            workflow,
            {
                type: "COMPLETE",
                completedState: "review",
                rootIssueMarkdown: "# Fix bug\n\nRoot body\n",
                assistantMessage: [
                    "<review-findings>",
                    "- title: Existing finding",
                    "  description: Fix it",
                    "  tdd: true",
                    "</review-findings>",
                    "<transition>implement-review</transition>",
                ].join("\n"),
            },
        );

        assert.ok(!("error" in result));
        assert.equal(updatedBody, "Fix it");
        assert.equal(result.workflow.active_task_id, "456");
    } finally {
        globalThis.fetch = originalFetch;
        if (originalRepository === undefined) delete process.env.GITHUB_REPOSITORY;
        else process.env.GITHUB_REPOSITORY = originalRepository;
        if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = originalToken;
        fs.rmSync(root, {recursive: true, force: true});
    }
});

test("kind-specific state and active depth validation", () => {
    assert.equal(stateAllowsActiveDepthForKind("fix", "implement", 0), true);
    assert.equal(stateAllowsActiveDepthForKind("fix", "implement-review", 1), true);
    assert.equal(stateAllowsActiveDepthForKind("fix", "plan", 0), false);
    assert.equal(stateAllowsActiveDepthForKind("task", "implement", 1), true);

    const invalid = createInitialWorkflow("fix", "123", "Fix bug", "leaf");
    invalid.state = "plan";
    assert.match(validateWorkflowForTest(invalid) ?? "", /not valid for fix workflow/);
});

test("task and fix commands reject persisted workflow mismatches", () => {
    assert.deepEqual(validateWorkflowCommandKind("task", "fix"), {error: "This is a fix workspace. Run /fix."});
    assert.deepEqual(validateWorkflowCommandKind("fix", "task"), {error: "This is a task workspace. Run /task."});
    assert.deepEqual(validateWorkflowCommandKind("fix", "fix"), {ok: true});
});

test("fix prompt lookup uses fix namespace and override precedence", () => {
    const cwd = makeTempDir("pi-fix-cwd-");
    const agentDir = makeTempDir("pi-fix-agent-");
    fs.mkdirSync(path.join(cwd, ".pi", "fix"), {recursive: true});
    fs.mkdirSync(path.join(agentDir, "fix"), {recursive: true});
    fs.writeFileSync(path.join(cwd, ".pi", "fix", "review.md"), "project fix base");
    fs.writeFileSync(path.join(agentDir, "fix", "review-append.md"), "user fix append");

    const loaded = loadWorkflowPrompt("fix", "review", cwd, agentDir);
    assert.ok(!("error" in loaded));
    assert.equal(loaded.content, "project fix base\n\nuser fix append");
});

test("fix finalization commits before closing the root exactly once", async () => {
    const root = makeTempDir("pi-fix-finalize-");
    const workflow = makeFixCommitWorkflow(root);
    const harness = makeFinalizationHarness({hasChanges: true});

    const result = await dispatchWorkflowEventForTest(
        harness.pi as never,
        harness.ctx as never,
        root,
        workflow,
        finalCommitEvent,
        {closeWorkflowIssue: harness.closeIssue},
    );

    assert.ok(!("error" in result));
    assert.equal(result.workflow.state, "complete");
    assert.equal(loadWorkflowState(root), "complete");
    assert.deepEqual(harness.calls, ["commit", "close:123"]);
});

test("task finalization retry does not rewrite an intervening commit after root closure fails", async () => {
    const root = makeTempDir("pi-task-finalize-retry-");
    const workflow = makeTaskCommitWorkflow(root);
    let hasChanges = true;
    let parentMessage = "previous commit";
    let closeAttempts = 0;
    const calls: string[] = [];
    const pi = {
        exec: async (command: string, args: string[]) => {
            assert.equal(command, "jj");
            if (args[0] === "diff") return {code: 0, stdout: hasChanges ? "diff" : "", stderr: ""};
            if (args[0] === "log") return {code: 0, stdout: parentMessage, stderr: ""};
            if (args[0] === "commit") {
                calls.push("commit");
                hasChanges = false;
                parentMessage = "fix: finish issue";
                return {code: 0, stdout: "", stderr: ""};
            }
            if (args[0] === "desc") {
                calls.push("describe-parent");
                parentMessage = String(args[args.indexOf("-m") + 1]);
                return {code: 0, stdout: "", stderr: ""};
            }
            throw new Error(`Unexpected jj arguments: ${args.join(" ")}`);
        },
    };
    const ctx = {ui: {notify: () => undefined}, sessionManager: {getSessionId: () => undefined}};
    const closeIssue = async () => {
        closeAttempts += 1;
        if (closeAttempts === 1) return {ok: false as const, error: "GitHub unavailable"};
        return {ok: true as const};
    };

    const first = await dispatchWorkflowEventForTest(
        pi as never, ctx as never, root, workflow, finalCommitEvent, {closeWorkflowIssue: closeIssue},
    );
    assert.ok("error" in first);
    parentMessage = "unrelated intervening commit";

    const persisted = loadWorkflowForTest(root);
    assert.ok(!("error" in persisted));
    const retry = await dispatchWorkflowEventForTest(
        pi as never, ctx as never, root, persisted.workflow, finalCommitEvent, {closeWorkflowIssue: closeIssue},
    );

    assert.ok("error" in retry);
    assert.match(retry.error, /previously successful task commit/i);
    assert.deepEqual(calls, ["commit"]);
    assert.equal(parentMessage, "unrelated intervening commit");
});

test("failed fix commit leaves workflow unadvanced and does not close the root", async () => {
    const root = makeTempDir("pi-fix-commit-failure-");
    const workflow = makeFixCommitWorkflow(root);
    const harness = makeFinalizationHarness({hasChanges: true, commitFails: true});

    const result = await dispatchWorkflowEventForTest(
        harness.pi as never,
        harness.ctx as never,
        root,
        workflow,
        finalCommitEvent,
        {closeWorkflowIssue: harness.closeIssue},
    );

    assert.ok("error" in result);
    assert.match(result.error, /jj commit failed/);
    assert.deepEqual(harness.calls, ["commit"]);
    assert.equal(loadWorkflowState(root), "commit");
});

test("empty fix is blocked before root closure", async () => {
    const root = makeTempDir("pi-fix-empty-");
    const workflow = makeFixCommitWorkflow(root);
    const harness = makeFinalizationHarness({hasChanges: false});

    const result = await dispatchWorkflowEventForTest(
        harness.pi as never,
        harness.ctx as never,
        root,
        workflow,
        finalCommitEvent,
        {closeWorkflowIssue: harness.closeIssue},
    );

    assert.ok("error" in result);
    assert.match(result.error, /no changes to commit/);
    assert.deepEqual(harness.calls, []);
    assert.equal(loadWorkflowState(root), "commit");
});

test("empty task final commit describes parent while empty fix final commit is blocked", () => {
    assert.equal(finalCommitActionForWorkingCopy("task", false), "describe-parent");
    assert.equal(finalCommitActionForWorkingCopy("fix", false), "block");
    assert.equal(finalCommitActionForWorkingCopy("fix", true), "commit");
});

test("root closure retry treats an already closed issue as complete", () => {
    assert.equal(issueNeedsClose("OPEN"), true);
    assert.equal(issueNeedsClose("CLOSED"), false);
});

test("fix final commit retry recognizes a previously successful matching commit", () => {
    assert.equal(fixCommitPreflightAction({
        hasChanges: false,
        requestedMessage: "fix: issue",
        pendingMessage: "fix: issue",
        parentMessage: "fix: issue",
    }), "already-committed");
    assert.equal(fixCommitPreflightAction({
        hasChanges: false,
        requestedMessage: "fix: issue",
        pendingMessage: null,
        parentMessage: "fix: issue",
    }), "block");
    assert.equal(fixCommitPreflightAction({
        hasChanges: true,
        requestedMessage: "fix: issue",
        pendingMessage: null,
        parentMessage: null,
    }), "commit");
});

test("workflow validation allows repeated manual-test titles with distinct issue IDs", () => {
    const workflow = createInitialWorkflow("fix", "123", "Fix bug", "leaf");
    workflow.manual_test_followups = [
        {
            issue_id: "239",
            title: "Repeated failure",
            fingerprint: "repeated-failure",
            created_at: "2026-04-26T11:25:44.000Z",
            from_manual_test_version: 64,
        },
        {
            issue_id: "242",
            title: "Repeated failure",
            fingerprint: "repeated-failure",
            created_at: "2026-04-26T11:30:40.000Z",
            from_manual_test_version: 66,
        },
    ];

    assert.equal(validateWorkflowForTest(workflow), null);
});

test("fix workflow validation rejects inconsistent manual-test latch states", () => {
    const manualTestUndecided = createInitialWorkflow("fix", "123", "Fix bug", "leaf");
    manualTestUndecided.state = "manual-test";
    assert.match(validateWorkflowForTest(manualTestUndecided) ?? "", /manual-test requires manual_test_status pending/);

    const reviewedPassed = createInitialWorkflow("fix", "123", "Fix bug", "leaf");
    reviewedPassed.state = "review";
    reviewedPassed.manual_test_status = "passed";
    assert.match(validateWorkflowForTest(reviewedPassed) ?? "", /passed is only valid in commit or complete/);
});

test("fix workflow validation rejects pending manual testing in commit or complete", () => {
    for (const state of ["commit", "complete"] as const) {
        const workflow = createInitialWorkflow("fix", "123", "Fix bug", "leaf");
        workflow.state = state;
        workflow.manual_test_status = "pending";

        assert.match(validateWorkflowForTest(workflow) ?? "", /commit or complete cannot have manual_test_status pending/);
    }
});

test("completed fix with pending manual testing cannot load as merge-ready", () => {
    const root = makeTempDir("pi-fix-pending-complete-");
    const workflow = createInitialWorkflow("fix", "123", "Fix bug", "leaf");
    workflow.state = "complete";
    workflow.manual_test_status = "pending";
    fs.mkdirSync(path.join(root, ".tasks"), {recursive: true});
    fs.writeFileSync(path.join(root, ".tasks", "workflow.json"), JSON.stringify(workflow));

    const loaded = loadWorkflowForTest(root);

    assert.ok("error" in loaded);
    assert.match(loaded.error, /commit or complete cannot have manual_test_status pending/);
});
