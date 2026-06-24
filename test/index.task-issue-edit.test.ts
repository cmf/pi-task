import test from "node:test";
import assert from "node:assert/strict";

import taskExtension, {
    applyEditsToNormalizedContent,
    computeTaskIssueEditBody,
    editIssueDescription,
    editMarkdownSection,
    findMarkdownSectionRange,
    insertMarkdownSection,
    parseIssueNumberFromTaskId,
} from "../index.js";
import * as indexModule from "../index.js";

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

test("legacy markdown helper APIs are not exported", () => {
    const descriptionHelper = ["set", "Issue", "Description", "Markdown"].join("");
    const sectionHelper = ["upsert", "Markdown", "Section"].join("");

    assert.equal(descriptionHelper in indexModule, false);
    assert.equal(sectionHelper in indexModule, false);
});

test("applyEditsToNormalizedContent matches Pi fuzzy edit normalization", () => {
    const content = "Café uses “quoted” text — and non\u00A0breaking space.   \nNext line";

    const result = applyEditsToNormalizedContent(
        content,
        [{
            oldText: "Café uses \"quoted\" text - and non breaking space.",
            newText: "Normalized replacement.",
        }],
        "issue body",
    );

    assert.equal(result.baseContent, "Café uses \"quoted\" text - and non breaking space.\nNext line");
    assert.equal(result.newContent, "Normalized replacement.\nNext line");
});

test("applyEditsToNormalizedContent normalizes CRLF oldText to LF", () => {
    const result = applyEditsToNormalizedContent(
        "one\ntwo\nthree",
        [{oldText: "one\r\ntwo", newText: "ONE\nTWO"}],
        "issue body",
    );

    assert.equal(result.newContent, "ONE\nTWO\nthree");
});

test("applyEditsToNormalizedContent rejects duplicate matches", () => {
    assert.throws(
        () => applyEditsToNormalizedContent(
            "repeat\nrepeat",
            [{oldText: "repeat", newText: "changed"}],
            "issue body",
        ),
        /Found 2 occurrences of the text in issue body/,
    );
});

test("applyEditsToNormalizedContent rejects missing matches", () => {
    assert.throws(
        () => applyEditsToNormalizedContent(
            "existing content",
            [{oldText: "missing", newText: "changed"}],
            "issue body",
        ),
        /Could not find the exact text in issue body/,
    );
});

test("applyEditsToNormalizedContent rejects overlapping edits", () => {
    assert.throws(
        () => applyEditsToNormalizedContent(
            "abcdef",
            [
                {oldText: "abc", newText: "ABC"},
                {oldText: "bcd", newText: "BCD"},
            ],
            "issue body",
        ),
        /overlap in issue body/,
    );
});

test("applyEditsToNormalizedContent rejects no-op replacements", () => {
    assert.throws(
        () => applyEditsToNormalizedContent(
            "unchanged",
            [{oldText: "unchanged", newText: "unchanged"}],
            "issue body",
        ),
        /No changes made to issue body/,
    );
});

test("applyEditsToNormalizedContent rejects empty oldText", () => {
    assert.throws(
        () => applyEditsToNormalizedContent(
            "content",
            [{oldText: "", newText: "insert"}],
            "issue body",
        ),
        /oldText must not be empty in issue body/,
    );
});

test("findMarkdownSectionRange returns the selected workflow section body range", () => {
    const body = [
        "Intro",
        "",
        "## Plan",
        "- one",
        "- two",
        "",
        "## Manual Test Plan",
        "- run",
    ].join("\n");

    assert.deepEqual(findMarkdownSectionRange(body, "## Plan"), {
        headerStart: 7,
        headerEnd: 14,
        bodyStart: 15,
        bodyEnd: 28,
    });
});

test("insertMarkdownSection inserts a missing section and fails when present", () => {
    const existing = "Intro\n\n## Plan\n- step 1";

    assert.equal(
        insertMarkdownSection(existing, "## Summary of Changes", "- Added tests"),
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

    assert.throws(
        () => insertMarkdownSection(existing, "## Plan", "- replacement"),
        /Section already exists: ## Plan/,
    );
});

test("insertMarkdownSection preserves untouched leading and trailing body whitespace", () => {
    const existing = "\nIntro\n\n## Plan\n- step 1\n\n";

    assert.equal(
        insertMarkdownSection(existing, "## Summary of Changes", "- Added tests"),
        "\nIntro\n\n## Plan\n- step 1\n\n## Summary of Changes\n- Added tests",
    );
});

test("editMarkdownSection edits only the selected section body", () => {
    const existing = [
        "Intro",
        "",
        "## Plan",
        "duplicate",
        "- old plan",
        "",
        "## Manual Test Plan",
        "duplicate",
    ].join("\n");

    assert.equal(
        editMarkdownSection(existing, "## Plan", [{oldText: "duplicate\n- old plan", newText: "duplicate\n- new plan"}]),
        [
            "Intro",
            "",
            "## Plan",
            "duplicate",
            "- new plan",
            "",
            "## Manual Test Plan",
            "duplicate",
        ].join("\n"),
    );
});

test("editMarkdownSection supports multiple disjoint edits and full-section replacement", () => {
    const existing = "## Plan\n- one\n- two\n- three";

    assert.equal(
        editMarkdownSection(existing, "## Plan", [
            {oldText: "- one", newText: "- ONE"},
            {oldText: "- three", newText: "- THREE"},
        ]),
        "## Plan\n- ONE\n- two\n- THREE",
    );

    assert.equal(
        editMarkdownSection(existing, "## Plan", [{oldText: "- one\n- two\n- three", newText: "- replacement"}]),
        "## Plan\n- replacement",
    );
});

test("editMarkdownSection preserves following workflow header after full-section replacement", () => {
    const existing = [
        "## Plan",
        "- one",
        "- two",
        "",
        "## Manual Test Plan",
        "- run",
    ].join("\n");

    assert.equal(
        editMarkdownSection(existing, "## Plan", [{oldText: "- one\n- two\n\n", newText: "- replacement"}]),
        [
            "## Plan",
            "- replacement",
            "",
            "## Manual Test Plan",
            "- run",
        ].join("\n"),
    );
});

test("editMarkdownSection preserves existing section-boundary whitespace", () => {
    assert.equal(
        editMarkdownSection(
            "## Plan\nold\n## Manual Test Plan\nkeep",
            "## Plan",
            [{oldText: "old", newText: "new"}],
        ),
        "## Plan\nnew\n## Manual Test Plan\nkeep",
    );
});

test("editMarkdownSection surfaces duplicate missing and overlapping edit failures", () => {
    assert.throws(
        () => editMarkdownSection("## Plan\nrepeat\nrepeat", "## Plan", [{oldText: "repeat", newText: "changed"}]),
        /Found 2 occurrences of the text in section ## Plan/,
    );
    assert.throws(
        () => editMarkdownSection("## Plan\nexisting", "## Plan", [{oldText: "missing", newText: "changed"}]),
        /Could not find the exact text in section ## Plan/,
    );
    assert.throws(
        () => editMarkdownSection("## Plan\nabcdef", "## Plan", [
            {oldText: "abc", newText: "ABC"},
            {oldText: "bcd", newText: "BCD"},
        ]),
        /overlap in section ## Plan/,
    );
});

test("editIssueDescription edits only the preamble before any h2 header", () => {
    const existing = [
        "Intro old",
        "### Details",
        "still description",
        "",
        "## Notes",
        "old should remain",
        "",
        "## Plan",
        "- old should remain",
    ].join("\n");

    assert.equal(
        editIssueDescription(existing, [{oldText: "Intro old", newText: "Intro new"}]),
        [
            "Intro new",
            "### Details",
            "still description",
            "",
            "## Notes",
            "old should remain",
            "",
            "## Plan",
            "- old should remain",
        ].join("\n"),
    );
});

test("editIssueDescription preserves blank lines around first section and trailing body whitespace", () => {
    const existing = "Intro old\n\n\n## Plan\n- keep\n\n";

    assert.equal(
        editIssueDescription(existing, [{oldText: "Intro old", newText: "Intro new"}]),
        "Intro new\n\n\n## Plan\n- keep\n\n",
    );
});

test("editIssueDescription supports full-description replacement and empty initialization", () => {
    assert.equal(
        editIssueDescription("Old description\n\n## Plan\n- keep", [{oldText: "Old description", newText: "New description"}]),
        "New description\n\n## Plan\n- keep",
    );

    assert.equal(
        editIssueDescription("## Plan\n- keep", [{oldText: "", newText: "New description"}]),
        "New description\n\n## Plan\n- keep",
    );
});

test("markdown section and description helpers reject level-2 headers in generated content", () => {
    assert.throws(
        () => insertMarkdownSection("Intro", "## Plan", "### allowed\n## Not allowed"),
        /Section bodies must not contain level-2 markdown headers/,
    );
    assert.throws(
        () => editMarkdownSection("## Plan\nold", "## Plan", [{oldText: "old", newText: "## Not allowed"}]),
        /Section bodies must not contain level-2 markdown headers/,
    );
    assert.throws(
        () => editIssueDescription("old", [{oldText: "old", newText: "## Not allowed"}]),
        /Section bodies must not contain level-2 markdown headers/,
    );

    assert.equal(insertMarkdownSection("Intro", "## Plan", "### Allowed"), "Intro\n\n## Plan\n### Allowed");
});

test("default export registers the three targeted issue edit tools only", () => {
    const tools: Array<{name: string; description?: string}> = [];
    const pi = {
        on() {},
        registerCommand() {},
        registerTool(tool: {name: string; description?: string}) {
            tools.push(tool);
        },
    };

    taskExtension(pi as never);

    const toolNames = tools.map((tool) => tool.name);
    assert.deepEqual(
        toolNames.filter((name) => name.startsWith("task_issue_")),
        ["task_issue_insert_section", "task_issue_edit_section", "task_issue_edit_description"],
    );
    assert.equal(toolNames.includes(["task", "issue", "edit"].join("_")), false);

    const descriptions = tools.map((tool) => tool.description ?? "").join("\n");
    assert.match(descriptions, /exact text replacement/i);
    assert.match(descriptions, /section bodies/i);
    assert.match(descriptions, /without `##` headers/i);
});

test("computeTaskIssueEditBody maps targeted tool inputs to issue body edits", () => {
    const body = [
        "Intro old",
        "",
        "## Plan",
        "- old plan",
        "",
        "## Manual Test Plan",
        "- run",
    ].join("\n");

    assert.equal(
        computeTaskIssueEditBody(body, {
            tool: "task_issue_insert_section",
            section: "summary_of_changes",
            content: "- Added targeted tools",
        }),
        [
            "Intro old",
            "",
            "## Plan",
            "- old plan",
            "",
            "## Manual Test Plan",
            "- run",
            "",
            "## Summary of Changes",
            "- Added targeted tools",
        ].join("\n"),
    );

    assert.equal(
        computeTaskIssueEditBody(body, {
            tool: "task_issue_edit_section",
            section: "plan",
            edits: [{oldText: "- old plan", newText: "- new plan"}],
        }),
        [
            "Intro old",
            "",
            "## Plan",
            "- new plan",
            "",
            "## Manual Test Plan",
            "- run",
        ].join("\n"),
    );

    assert.equal(
        computeTaskIssueEditBody(body, {
            tool: "task_issue_edit_description",
            edits: [{oldText: "Intro old", newText: "Intro new"}],
        }),
        [
            "Intro new",
            "",
            "## Plan",
            "- old plan",
            "",
            "## Manual Test Plan",
            "- run",
        ].join("\n"),
    );
});

test("computeTaskIssueEditBody surfaces targeted edit validation errors", () => {
    assert.throws(
        () => computeTaskIssueEditBody("Intro\n\n## Plan\n- old", {
            tool: "task_issue_insert_section",
            section: "plan",
            content: "- duplicate",
        }),
        /Section already exists: ## Plan/,
    );
    assert.throws(
        () => computeTaskIssueEditBody("## Plan\n- old", {
            tool: "task_issue_edit_section",
            section: "plan",
            edits: [{oldText: "- old", newText: "## Bad"}],
        }),
        /Section bodies must not contain level-2 markdown headers/,
    );
    assert.throws(
        () => computeTaskIssueEditBody("## Plan\n- old", {
            tool: "task_issue_edit_description",
            edits: [{oldText: "missing", newText: "changed"}],
        }),
        /Could not find the exact text in issue description/,
    );
    assert.throws(
        () => computeTaskIssueEditBody("Intro", {
            tool: "task_issue_edit_description",
            edits: [{oldText: "Intro", newText: "Intro"}],
        }),
        /No changes made to issue description/,
    );
});
