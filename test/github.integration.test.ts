import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    addIssueComment,
    closeIssue,
    createIssue,
    createIssueWithParent,
    findChildIssueByExactTitle,
    getIssueByNumber,
    getRepositoryId,
    listIssues,
    listSubIssues,
    markIssueInProgressWithLabel,
    updateIssueBody,
    type GitHubClientConfig,
} from "../github.js";

const KEY_PATH = path.join(os.homedir(), ".api-keys", "github-tasks");
const OWNER = "cmf";
const REPO = "issue-test";
const IN_PROGRESS_LABEL = "status:in-progress";
const INTEGRATION_ENABLED = process.env.PI_TASK_GITHUB_INTEGRATION_TESTS === "1";
const INTEGRATION_SKIP_REASON = "Set PI_TASK_GITHUB_INTEGRATION_TESTS=1 to run GitHub integration tests.";

function integrationTest(name: string, run: () => Promise<void>): void {
    test(name, {skip: INTEGRATION_ENABLED ? undefined : INTEGRATION_SKIP_REASON}, run);
}

function readRequiredToken(): string {
    if (!fs.existsSync(KEY_PATH)) {
        throw new Error(`Missing GitHub token file: ${KEY_PATH}`);
    }

    const token = fs.readFileSync(KEY_PATH, "utf8").trim();
    if (!token) {
        throw new Error(`GitHub token file is empty: ${KEY_PATH}`);
    }

    return token;
}

function createConfig(): GitHubClientConfig {
    return {
        owner: OWNER,
        repo: REPO,
        token: readRequiredToken(),
    };
}

function uniqueTitle(prefix: string): string {
    return `${prefix} ${new Date().toISOString()} ${Math.random().toString(36).slice(2, 10)}`;
}

async function closeIfOpen(config: GitHubClientConfig, issueNumber: number | null): Promise<void> {
    if (!issueNumber) return;

    const issue = await getIssueByNumber(config, issueNumber);
    if (!issue || issue.state === "CLOSED") return;
    await closeIssue(config, issue.id);
}

integrationTest("github integration: repo access + list issues", async () => {
    const config = createConfig();

    const repositoryId = await getRepositoryId(config);
    assert.ok(repositoryId.length > 0, "Expected non-empty repository id");

    const issues = await listIssues(config, {states: ["OPEN", "CLOSED"], pageSize: 10, orderDirection: "DESC"});
    assert.ok(Array.isArray(issues));

    if (issues.length > 0) {
        assert.ok(issues[0].id.length > 0);
        assert.ok(issues[0].number > 0);
        assert.ok(issues[0].title.length > 0);
    }
});

integrationTest("github integration: create issue, add in-progress label, comment, close", async () => {
    const config = createConfig();

    const title = uniqueTitle("pi-task github integration");
    const body = "Created by integration test for task extension GitHub primitives.";
    let issueNumber: number | null = null;

    try {
        const created = await createIssue(config, {title, body});
        issueNumber = created.number;

        assert.equal(created.title, title);
        assert.equal(created.state, "OPEN");

        const labelResult = await markIssueInProgressWithLabel(config, created.id, IN_PROGRESS_LABEL);
        assert.ok(labelResult.labelId.length > 0, "Expected non-empty label id");

        const noteText = `integration-note ${Date.now()}`;
        const note = await addIssueComment(config, created.id, noteText);
        assert.equal(note.body, noteText);

        const loaded = await getIssueByNumber(config, created.number, {commentsFirst: 50});
        assert.ok(loaded, "Expected created issue to be readable");
        assert.ok(loaded!.labels.includes(IN_PROGRESS_LABEL), `Expected label ${IN_PROGRESS_LABEL} to be present`);
        assert.ok(loaded!.comments.some((comment) => comment.id === note.id));

        const closed = await closeIssue(config, created.id);
        assert.equal(closed.state, "CLOSED");

        const afterClose = await getIssueByNumber(config, created.number);
        assert.ok(afterClose, "Expected issue to still be retrievable after close");
        assert.equal(afterClose!.state, "CLOSED");
    } finally {
        await closeIfOpen(config, issueNumber);
    }
});

integrationTest("github integration: update issue body", async () => {
    const config = createConfig();

    const title = uniqueTitle("pi-task body update integration");
    let issueNumber: number | null = null;

    try {
        const created = await createIssue(config, {
            title,
            body: "Initial issue body from integration test.",
        });
        issueNumber = created.number;

        const updatedBody = [
            "Updated issue body from integration test.",
            "",
            "## Summary of Changes",
            "- Added by updateIssueBody integration test",
            `- Marker: ${Date.now()}`,
        ].join("\n");

        const updated = await updateIssueBody(config, created.id, updatedBody);
        assert.equal(updated.id, created.id);
        assert.equal(updated.body, updatedBody);

        const loaded = await getIssueByNumber(config, created.number);
        assert.ok(loaded, "Expected updated issue to be readable");
        assert.equal(loaded!.body, updatedBody);
    } finally {
        await closeIfOpen(config, issueNumber);
    }
});

integrationTest("github integration: parent-child creation and lookup", async () => {
    const config = createConfig();

    const parentTitle = uniqueTitle("pi-task parent integration");
    const childTitle = uniqueTitle("pi-task child integration");

    let parentNumber: number | null = null;
    let childNumber: number | null = null;

    try {
        const parent = await createIssue(config, {
            title: parentTitle,
            body: "Parent issue created by integration test.",
        });
        parentNumber = parent.number;

        const child = await createIssueWithParent(config, {
            parentIssueId: parent.id,
            title: childTitle,
            body: "Child issue created by integration test.",
        });
        childNumber = child.number;

        const found = await findChildIssueByExactTitle(config, {
            parentIssueId: parent.id,
            title: childTitle,
        });

        assert.ok(found, "Expected to find child issue by exact title");
        assert.equal(found!.id, child.id);

        const children = await listSubIssues(config, parent.id);
        assert.ok(children.some((issue) => issue.id === child.id), "Expected child in listSubIssues output");

        const loadedChild = await getIssueByNumber(config, child.number);
        assert.ok(loadedChild, "Expected child issue to be readable");
        assert.ok(loadedChild!.parent, "Expected child to have parent relation");
        assert.equal(loadedChild!.parent!.id, parent.id);
    } finally {
        await closeIfOpen(config, childNumber);
        await closeIfOpen(config, parentNumber);
    }
});
