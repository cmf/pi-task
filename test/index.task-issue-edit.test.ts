import test from "node:test";
import assert from "node:assert/strict";

import {
    parseIssueNumberFromTaskId,
    setIssueDescriptionMarkdown,
    upsertMarkdownSection,
} from "../index.js";

test("parseIssueNumberFromTaskId supports supported identifier forms", () => {
    assert.equal(parseIssueNumberFromTaskId("123"), 123);
    assert.equal(parseIssueNumberFromTaskId("#456"), 456);
    assert.equal(parseIssueNumberFromTaskId("cmf/issue-test#789"), 789);
    assert.equal(parseIssueNumberFromTaskId("https://github.com/cmf/issue-test/issues/42"), 42);
});

test("parseIssueNumberFromTaskId rejects unsupported identifiers", () => {
    assert.equal(parseIssueNumberFromTaskId(""), null);
    assert.equal(parseIssueNumberFromTaskId("tp-1234"), null);
    assert.equal(parseIssueNumberFromTaskId("not-an-issue"), null);
});

test("setIssueDescriptionMarkdown replaces preamble and preserves sections", () => {
    const existing = [
        "Old description",
        "",
        "## Plan",
        "- old",
        "",
        "## Summary of Changes",
        "- done",
    ].join("\n");

    const next = setIssueDescriptionMarkdown(existing, "New description\n\nWith context");

    assert.equal(
        next,
        [
            "New description",
            "",
            "With context",
            "",
            "## Plan",
            "- old",
            "",
            "## Summary of Changes",
            "- done",
        ].join("\n"),
    );
});

test("upsertMarkdownSection appends section when missing", () => {
    const existing = "Intro\n\n## Plan\n- step 1";
    const next = upsertMarkdownSection(existing, "## Summary of Changes", "- Added tests");

    assert.equal(
        next,
        [
            "Intro",
            "",
            "## Plan",
            "- step 1",
            "",
            "## Summary of Changes",
            "- Added tests",
        ].join("\n"),
    );
});

test("upsertMarkdownSection replaces existing section only", () => {
    const existing = [
        "Intro",
        "",
        "## Plan",
        "- one",
        "- two",
        "",
        "## Manual Test Plan",
        "- run A",
        "",
        "## Summary of Changes",
        "- old",
    ].join("\n");

    const next = upsertMarkdownSection(existing, "## Manual Test Plan", "- run A\n- run B");

    assert.equal(
        next,
        [
            "Intro",
            "",
            "## Plan",
            "- one",
            "- two",
            "",
            "## Manual Test Plan",
            "- run A",
            "- run B",
            "",
            "## Summary of Changes",
            "- old",
        ].join("\n"),
    );
});
