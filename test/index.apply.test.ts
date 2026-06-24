import test from "node:test";
import assert from "node:assert/strict";

import {
    buildTaskApplyPrompt,
    buildTaskIssueHandlingHeader,
    parseTaskApplyArgs,
    runTaskApplyIterations,
    summarizeTaskApplyResults,
    validateTaskApplyAssistantMessage,
} from "../index.js";

function escapedLiteralPattern(text: string): RegExp {
    return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

function staleIdentifierPattern(...parts: string[]): RegExp {
    return escapedLiteralPattern(parts.join("_"));
}

function standaloneStaleToolPattern(): RegExp {
    return new RegExp(`\\b${partsToEscapedLiteral("task", "issue", "edit")}\\b`);
}

function partsToEscapedLiteral(...parts: string[]): string {
    return parts.join("_").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("parseTaskApplyArgs accepts numbered findings and removes duplicates", () => {
    assert.deepEqual(parseTaskApplyArgs("1 2 2 5"), {findings: ["1", "2", "5"]});
});

test("parseTaskApplyArgs expands ranges", () => {
    assert.deepEqual(parseTaskApplyArgs("1-3 5-6"), {findings: ["1", "2", "3", "5", "6"]});
});

test("parseTaskApplyArgs treats commas as separators", () => {
    assert.deepEqual(parseTaskApplyArgs("1, 2, 3, 5, 6"), {findings: ["1", "2", "3", "5", "6"]});
    assert.deepEqual(parseTaskApplyArgs("1-3, 5-6"), {findings: ["1", "2", "3", "5", "6"]});
});

test("parseTaskApplyArgs accepts mixed numbers ranges and commas", () => {
    assert.deepEqual(parseTaskApplyArgs("1, 2-4 4, 6-7"), {findings: ["1", "2", "3", "4", "6", "7"]});
});

test("parseTaskApplyArgs accepts an optional trailing instruction", () => {
    assert.deepEqual(parseTaskApplyArgs("1 do b"), {findings: ["1"], instruction: "do b"});
    assert.deepEqual(parseTaskApplyArgs("1, 2-3 choose option b"), {
        findings: ["1", "2", "3"],
        instruction: "choose option b",
    });
});

test("parseTaskApplyArgs rejects missing or invalid numbered findings", () => {
    assert.deepEqual(parseTaskApplyArgs(""), {error: "Usage: /task apply <finding-number-or-range> [finding-number-or-range ...] [instruction]"});
    assert.deepEqual(parseTaskApplyArgs("do b"), {error: "Usage: /task apply <finding-number-or-range> [finding-number-or-range ...] [instruction]"});
    assert.deepEqual(parseTaskApplyArgs("0"), {error: "Finding identifiers must be positive integers or ranges: 0"});
    assert.deepEqual(parseTaskApplyArgs("3-1"), {error: "Finding ranges must be ascending: 3-1"});
});

test("parseTaskApplyArgs caps total selected findings", () => {
    assert.deepEqual(parseTaskApplyArgs("1-51"), {error: "Cannot apply more than 50 findings at once."});
});

test("buildTaskApplyPrompt tells the agent to use current issue content as authoritative", () => {
    const prompt = buildTaskApplyPrompt({
        finding: "2",
        rootIssueMarkdown: "# Example\n\n## Plan\nold/current plan",
    });

    assert.match(prompt, /applying finding 2/i);
    assert.match(prompt, /current root issue content below is authoritative/i);
    assert.match(prompt, /Ignore older copies of the plan/i);
    assert.match(prompt, /Apply only finding 2/i);
    assert.match(prompt, /Do not emit any workflow transition/i);
    assert.match(prompt, /will be ignored/i);
    assert.match(prompt, /`target: "root"`/i);
    assert.match(prompt, /task_issue_edit_section/);
    assert.match(prompt, /task_issue_insert_section/);
    assert.match(prompt, /task_issue_edit_description/);
    assert.match(prompt, /if the root issue `## Plan` section exists/i);
    assert.match(prompt, /if the root issue `## Plan` section is missing/i);
    assert.match(prompt, /if the root issue `## Manual Test Plan` section exists/i);
    assert.match(prompt, /if the root issue `## Manual Test Plan` section is missing/i);
    assert.match(prompt, /small, unique `oldText` blocks/i);
    assert.match(prompt, /unless most of a section changed/i);
    assert.match(prompt, /If finding 2 invalidates issue description or design text/i);
    assert.match(prompt, /Do not include the `# Title` line/i);
    assert.match(prompt, /# Example/);
    assert.doesNotMatch(prompt, staleIdentifierPattern("upsert", "section"));
    assert.doesNotMatch(prompt, staleIdentifierPattern("set", "description"));
    assert.doesNotMatch(prompt, standaloneStaleToolPattern());
});

test("buildTaskIssueHandlingHeader names targeted issue edit tools only", () => {
    const header = buildTaskIssueHandlingHeader({
        workflowVersion: 19,
        workflowState: "implement",
        activeIssueId: "5",
        activePathIds: ["1", "5"],
    });

    assert.match(header, /Workflow Version: 19/);
    assert.match(header, /Workflow State: implement/);
    assert.match(header, /Active Issue ID: 5/);
    assert.match(header, /Active Path: 1 -> 5/);
    assert.match(header, /task_issue_insert_section/);
    assert.match(header, /task_issue_edit_section/);
    assert.match(header, /task_issue_edit_description/);
    assert.doesNotMatch(header, staleIdentifierPattern("upsert", "section"));
    assert.doesNotMatch(header, staleIdentifierPattern("set", "description"));
    assert.doesNotMatch(header, standaloneStaleToolPattern());
});

test("buildTaskApplyPrompt includes optional user instruction", () => {
    const prompt = buildTaskApplyPrompt({
        finding: "1",
        instruction: "do b",
        rootIssueMarkdown: "# Example\n\n## Plan\ncurrent plan",
    });

    assert.match(prompt, /Additional user instruction/i);
    assert.match(prompt, /<apply-instruction>\ndo b\n<\/apply-instruction>/);
});

test("validateTaskApplyAssistantMessage rejects workflow transitions", () => {
    assert.deepEqual(
        validateTaskApplyAssistantMessage("Updated the issue.\n\n<transition>review-plan</transition>"),
        {error: "Unexpected workflow transition emitted during /task apply: review-plan"},
    );
});

test("validateTaskApplyAssistantMessage rejects unknown transition tags", () => {
    assert.deepEqual(
        validateTaskApplyAssistantMessage("Updated the issue.\n\n<transition>bogus</transition>"),
        {error: "Unexpected workflow transition emitted during /task apply: bogus"},
    );
});

test("validateTaskApplyAssistantMessage allows transition-free updates", () => {
    assert.deepEqual(validateTaskApplyAssistantMessage("Updated the root issue plan."), {ok: true});
});

test("summarizeTaskApplyResults reports changed and unchanged findings accurately", () => {
    assert.deepEqual(
        summarizeTaskApplyResults({changed: ["1", "2"], unchanged: ["5"]}),
        {
            level: "warning",
            message: "Applied findings 1, 2; no root issue change detected for finding 5. Run /task to re-review the plan.",
        },
    );
});

test("summarizeTaskApplyResults does not claim apply success when all findings are unchanged", () => {
    assert.deepEqual(
        summarizeTaskApplyResults({changed: [], unchanged: ["1", "2"]}),
        {
            level: "warning",
            message: "No root issue changes detected for findings 1, 2. Run /task to re-review the plan.",
        },
    );
});

test("runTaskApplyIterations reloads current root issue before each selected finding", async () => {
    const issueReads = [
        "# Example\n\n## Plan\noriginal plan\n",
        "# Example\n\n## Plan\noriginal plan\n- applied finding 1\n",
        "# Example\n\n## Plan\noriginal plan\n- applied finding 1\n",
        "# Example\n\n## Plan\noriginal plan\n- applied finding 1\n- applied finding 2\n",
    ];
    const prompts: string[] = [];
    const navigations: Array<{baseLeafId: string; finding: string}> = [];
    const notifications: Array<{message: string; level: "info" | "warning" | "error"}> = [];

    const result = await runTaskApplyIterations({
        findings: ["1", "2"],
        instruction: "prefer option b",
        baseLeafId: "review-findings-leaf",
        isIdle: () => true,
        waitForIdle: async () => {},
        navigateToBase: async (baseLeafId, finding) => {
            navigations.push({baseLeafId, finding});
            return {cancelled: false};
        },
        loadRootIssueMarkdown: async () => ({content: issueReads.shift()!}),
        runPrompt: async (prompt) => {
            prompts.push(prompt);
            return {assistantMessage: "Updated the root issue plan.", assistantMessageId: `assistant-${prompts.length}`};
        },
        consumeAssistantMessage: async () => ({ok: true}),
        notify: (message, level) => notifications.push({message, level}),
    });

    assert.equal(result, true);
    assert.deepEqual(navigations, [
        {baseLeafId: "review-findings-leaf", finding: "1"},
        {baseLeafId: "review-findings-leaf", finding: "2"},
    ]);
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /original plan/);
    assert.match(prompts[0], /prefer option b/);
    assert.doesNotMatch(prompts[0], /applied finding 1/);
    assert.match(prompts[1], /applied finding 1/);
    assert.match(prompts[1], /prefer option b/);
    assert.deepEqual(notifications.at(-1), {
        level: "warning",
        message: "Applied findings 1, 2. Run /task to re-review the plan.",
    });
});

test("runTaskApplyIterations consumes unexpected transitions and stops", async () => {
    const consumed: Array<string | null> = [];
    const notifications: Array<{message: string; level: "info" | "warning" | "error"}> = [];
    let promptRuns = 0;

    const result = await runTaskApplyIterations({
        findings: ["1", "2"],
        baseLeafId: "review-findings-leaf",
        isIdle: () => true,
        waitForIdle: async () => {},
        navigateToBase: async () => ({cancelled: false}),
        loadRootIssueMarkdown: async () => ({content: "# Example\n\n## Plan\noriginal plan\n"}),
        runPrompt: async () => {
            promptRuns += 1;
            return {
                assistantMessage: "Updated.\n\n<transition>review-plan</transition>",
                assistantMessageId: "assistant-transition",
            };
        },
        consumeAssistantMessage: async (assistantMessageId) => {
            consumed.push(assistantMessageId);
            return {ok: true};
        },
        notify: (message, level) => notifications.push({message, level}),
    });

    assert.equal(result, false);
    assert.equal(promptRuns, 1);
    assert.deepEqual(consumed, ["assistant-transition"]);
    assert.deepEqual(notifications.at(-1), {
        level: "warning",
        message: "Unexpected workflow transition emitted during /task apply: review-plan; ignored. Run /task to re-review the updated plan.",
    });
});
