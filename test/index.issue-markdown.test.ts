import test from "node:test";
import assert from "node:assert/strict";

import * as taskExtension from "../index.js";

const {formatWorkflowIssueMarkdown} = taskExtension as {
    formatWorkflowIssueMarkdown?: (issue: {
        title: string;
        body: string;
        comments: Array<{body: string; authorLogin: string | null}>;
    }) => string;
};

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
