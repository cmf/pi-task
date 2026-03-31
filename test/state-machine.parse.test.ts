import test from "node:test";
import assert from "node:assert/strict";

import {
    canReplayCompleteFromAssistantMessage,
    eventNeedsRootIssueMarkdown,
    parseAssistantOutput,
    type WorkflowEvent,
    type WorkflowSnapshot,
} from "../state-machine.js";

function expectParsed(result: ReturnType<typeof parseAssistantOutput>) {
    assert.ok("parsed" in result, `Expected parsed result, got error: ${"error" in result ? result.error : "unknown"}`);
    return result.parsed;
}

function expectError(result: ReturnType<typeof parseAssistantOutput>) {
    assert.ok("error" in result, "Expected error result");
    return result.error;
}

function makeSnapshot(state: WorkflowSnapshot["state"]): WorkflowSnapshot {
    return {
        state,
        rootTaskId: "TASK-ROOT",
        activeTaskId: "TASK-ROOT",
        activeTaskParentId: null,
        activeTaskNextSiblingId: null,
    };
}

function completeEvent(completedState: WorkflowSnapshot["state"]): WorkflowEvent {
    return {
        type: "COMPLETE",
        completedState,
        assistantMessage: "",
        rootIssueMarkdown: "",
    };
}

test("parseAssistantOutput picks the last valid transition tag", () => {
    const parsed = expectParsed(parseAssistantOutput(`
<transition>plan</transition>
<transition>not-a-state</transition>
<transition>review-plan</transition>
`, "refine"));

    assert.equal(parsed.requestedState, "review-plan");
});

test("parseAssistantOutput parses review findings YAML in review state", () => {
    const parsed = expectParsed(parseAssistantOutput(`
<review-findings>
- title: Fix null handling
  description: Add null checks
- title: Add regression test
  tdd: false
</review-findings>
<transition>implement-review</transition>
`, "review"));

    assert.equal(parsed.requestedState, "implement-review");
    assert.deepEqual(parsed.reviewFindings, [
        {title: "Fix null handling", description: "Add null checks", tdd: true},
        {title: "Add regression test", description: "", tdd: false},
    ]);
});

test("parseAssistantOutput returns parse errors for malformed review findings in review state", () => {
    const error = expectError(parseAssistantOutput(`
<review-findings>
- title: [
</review-findings>
<transition>implement-review</transition>
`, "review"));

    assert.match(error, /Failed to parse Finding YAML block/);
});

test("parseAssistantOutput ignores malformed review findings outside review state", () => {
    const parsed = expectParsed(parseAssistantOutput(`
<review-findings>
- title: [
</review-findings>
<transition>plan</transition>
`, "implement"));

    assert.equal(parsed.requestedState, "plan");
    assert.deepEqual(parsed.reviewFindings, []);
});

test("parseAssistantOutput trims multiline commit message blocks", () => {
    const parsed = expectParsed(parseAssistantOutput(`
<commit-message>
  chore: finalize task

  include summary line
</commit-message>
`, "subtask-commit"));

    assert.equal(parsed.commitMessage, "chore: finalize task\n\n  include summary line");
});

test("parseAssistantOutput errors when review findings YAML is not a list", () => {
    const error = expectError(parseAssistantOutput(`
<review-findings>
title: Not a list
</review-findings>
<transition>implement-review</transition>
`, "review"));

    assert.equal(error, "Finding YAML block must be a list (a YAML sequence).");
});

test("parseAssistantOutput errors when a review finding item is not an object", () => {
    const error = expectError(parseAssistantOutput(`
<review-findings>
- just-a-string
</review-findings>
<transition>implement-review</transition>
`, "review"));

    assert.equal(error, "Finding 1 is not an object.");
});

test("parseAssistantOutput errors when a review finding is missing title", () => {
    const error = expectError(parseAssistantOutput(`
<review-findings>
- description: Missing title
</review-findings>
<transition>implement-review</transition>
`, "review"));

    assert.equal(error, "Finding 1 is missing a non-empty string 'title'.");
});

test("parseAssistantOutput supports inline review-findings tags", () => {
    const parsed = expectParsed(parseAssistantOutput(
        "<review-findings>- title: Inline finding\n  description: Parsed from inline tag</review-findings><transition>implement-review</transition>",
        "review",
    ));

    assert.equal(parsed.requestedState, "implement-review");
    assert.deepEqual(parsed.reviewFindings, [
        {title: "Inline finding", description: "Parsed from inline tag", tdd: true},
    ]);
});

test("parseAssistantOutput supports inline commit-message tags and normalizes CRLF", () => {
    const parsed = expectParsed(parseAssistantOutput(
        "<commit-message>feat: inline commit\r\n\r\nbody line one\rbody line two</commit-message>",
        "commit",
    ));

    assert.equal(parsed.commitMessage, "feat: inline commit\n\nbody line one\nbody line two");
});

test("parseAssistantOutput parses review findings when state is omitted", () => {
    const parsed = expectParsed(parseAssistantOutput(`
<review-findings>
- title: Omitted state still parses
  description: Because parse defaults to review-findings enabled
</review-findings>
<transition>implement-review</transition>
`));

    assert.equal(parsed.requestedState, "implement-review");
    assert.deepEqual(parsed.reviewFindings, [
        {
            title: "Omitted state still parses",
            description: "Because parse defaults to review-findings enabled",
            tdd: true,
        },
    ]);
});

test("parseAssistantOutput treats falsy findings YAML as empty list", () => {
    const parsed = expectParsed(parseAssistantOutput(`
<review-findings>
false
</review-findings>
<transition>implement-review</transition>
`, "review"));

    assert.equal(parsed.requestedState, "implement-review");
    assert.deepEqual(parsed.reviewFindings, []);
});

test("eventNeedsRootIssueMarkdown requests root markdown for commit COMPLETE events", () => {
    assert.equal(
        eventNeedsRootIssueMarkdown(makeSnapshot("commit"), completeEvent("commit")),
        true,
    );
});

test("eventNeedsRootIssueMarkdown does not request root markdown for subtask-commit COMPLETE events", () => {
    assert.equal(
        eventNeedsRootIssueMarkdown(makeSnapshot("subtask-commit"), completeEvent("subtask-commit")),
        false,
    );
});

test("canReplayCompleteFromAssistantMessage returns true for refine->plan transition tag", () => {
    assert.equal(
        canReplayCompleteFromAssistantMessage("refine", "<transition>plan</transition>"),
        true,
    );
});

test("canReplayCompleteFromAssistantMessage returns false for implement with plain text", () => {
    assert.equal(
        canReplayCompleteFromAssistantMessage("implement", "Looks good"),
        false,
    );
});

test("canReplayCompleteFromAssistantMessage requires findings for review implement-review", () => {
    assert.equal(
        canReplayCompleteFromAssistantMessage("review", "<transition>implement-review</transition>"),
        false,
    );

    assert.equal(
        canReplayCompleteFromAssistantMessage(
            "review",
            "<review-findings>\n- title: Fix parser\n</review-findings>\n<transition>implement-review</transition>",
        ),
        true,
    );
});

test("canReplayCompleteFromAssistantMessage allows commit-message based states", () => {
    assert.equal(
        canReplayCompleteFromAssistantMessage(
            "subtask-commit",
            "<commit-message>feat: finalize subtask</commit-message>",
        ),
        true,
    );

    assert.equal(
        canReplayCompleteFromAssistantMessage(
            "commit",
            "<commit-message>feat: finalize task</commit-message>",
        ),
        true,
    );
});
