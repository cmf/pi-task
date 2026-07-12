import test from "node:test";
import assert from "node:assert/strict";

import * as taskExtension from "../index.js";
import {transition, type WorkflowSnapshot} from "../state-machine.js";

const {formatCreatedChildIssueBody, formatReusedChildIssueBody, formatWorkspaceCreationFailureMessage, formatWorkflowIssueBodyMarkdown, formatWorkflowIssueMarkdown} = taskExtension as {
    formatCreatedChildIssueBody?: (description: string, tdd: boolean) => string;
    formatReusedChildIssueBody?: (existingBody: string, description: string, tdd: boolean) => string;
    formatWorkspaceCreationFailureMessage?: (stderr: string) => string;
    formatWorkflowIssueBodyMarkdown?: (issue: {
        title: string;
        body: string;
    }) => string;
    formatWorkflowIssueMarkdown?: (issue: {
        title: string;
        body: string;
        comments: Array<{body: string; authorLogin: string | null}>;
        commentsTruncated?: boolean;
    }) => string;
};

test("formatCreatedChildIssueBody appends tdd false marker", () => {
    assert.equal(typeof formatCreatedChildIssueBody, "function");

    assert.equal(
        formatCreatedChildIssueBody!("Fix the thing", false),
        "Fix the thing\n\n<!-- tdd: false -->",
    );
});

test("formatReusedChildIssueBody appends tdd false marker for reused open issues", () => {
    assert.equal(typeof formatReusedChildIssueBody, "function");

    assert.equal(
        formatReusedChildIssueBody!("Existing issue body", "Existing issue body", false),
        "Existing issue body\n\n<!-- tdd: false -->",
    );
});

test("formatReusedChildIssueBody does not duplicate existing tdd false marker", () => {
    assert.equal(typeof formatReusedChildIssueBody, "function");

    assert.equal(
        formatReusedChildIssueBody!("Existing issue body\n\n<!-- tdd: false -->", "Existing issue body", false),
        "Existing issue body\n\n<!-- tdd: false -->",
    );
});

test("formatReusedChildIssueBody removes stale tdd false marker when TDD is required", () => {
    assert.equal(typeof formatReusedChildIssueBody, "function");

    assert.equal(
        formatReusedChildIssueBody!("Existing issue body\n\n<!-- tdd: false -->", "Existing issue body", true),
        "Existing issue body",
    );
});

test("formatReusedChildIssueBody replaces stale description and preserves workflow sections", () => {
    assert.equal(typeof formatReusedChildIssueBody, "function");

    assert.equal(
        formatReusedChildIssueBody!(
            "Old finding details\n\n## Plan\n\n- useful progress",
            "Updated finding details",
            true,
        ),
        "Updated finding details\n\n## Plan\n\n- useful progress",
    );
});

test("formatWorkspaceCreationFailureMessage mentions stale in-progress label cleanup", () => {
    assert.equal(typeof formatWorkspaceCreationFailureMessage, "function");

    const message = formatWorkspaceCreationFailureMessage!("boom");

    assert.match(message, /boom/);
    assert.match(message, /status:in-progress/);
    assert.match(message, /remove/i);
});

test("formatWorkflowIssueBodyMarkdown excludes comments from transition-parsed markdown", () => {
    assert.equal(typeof formatWorkflowIssueBodyMarkdown, "function");

    const bodyOnly = formatWorkflowIssueBodyMarkdown!({
        title: "Example issue",
        body: "Issue body without a plan",
    });

    assert.equal(bodyOnly, "# Example issue\n\nIssue body without a plan\n");

    const snapshot: WorkflowSnapshot = {
        state: "plan",
        rootTaskId: "1",
        activeTaskId: "1",
        activeTaskParentId: null,
        activeTaskNextSiblingId: null,
    };
    const decision = transition(snapshot, {
        type: "COMPLETE",
        completedState: "plan",
        assistantMessage: "<transition>review-plan</transition>",
        rootIssueMarkdown: bodyOnly,
    });

    assert.equal(decision.kind, "rejected");
    assert.match(decision.reason, /Could not find a `## Plan` section/);
});

test("formatWorkflowIssueMarkdown includes a marker when comments are truncated", () => {
    assert.equal(typeof formatWorkflowIssueMarkdown, "function");

    const markdown = formatWorkflowIssueMarkdown!({
        title: "Example issue",
        body: "Issue body",
        comments: [],
        commentsTruncated: true,
    });

    assert.match(markdown, /comments truncated/i);
});

test("formatWorkflowIssueMarkdown includes issue comments with author subheadings", () => {
    assert.equal(typeof formatWorkflowIssueMarkdown, "function");

    const markdown = formatWorkflowIssueMarkdown!({
        title: "Example issue",
        body: "Issue body",
        comments: [
            {authorLogin: "alice", body: "First comment"},
            {authorLogin: null, body: "Second comment"},
            {authorLogin: "bob", body: "   "},
        ],
    });

    assert.equal(
        markdown,
        [
            "# Example issue",
            "",
            "Issue body",
            "",
            "## Comment from alice",
            "",
            "First comment",
            "",
            "## Comment from unknown author",
            "",
            "Second comment",
            "",
        ].join("\n"),
    );
});
