import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as taskExtension from "../index.js";

type JjExecResult = {code: number; stdout: string; stderr: string};
type MergeTaskBranchOntoMain = (params: {
    root: string;
    taskHeadCommitId: string;
    message: string;
    destinationMarker?: string;
    exec: (args: string[], options: {cwd: string}) => Promise<JjExecResult>;
}) => Promise<{kind: "merged"; hadConflicts: boolean} | {error: string}>;

const mergeTaskBranchOntoMain = (taskExtension as {
    mergeTaskBranchOntoMain?: MergeTaskBranchOntoMain;
}).mergeTaskBranchOntoMain;
const execFileAsync = promisify(execFile);

async function execJj(args: string[], options: {cwd: string}): Promise<JjExecResult> {
    try {
        const result = await execFileAsync("jj", args, {
            cwd: options.cwd,
            encoding: "utf8",
            maxBuffer: 10 * 1024 * 1024,
        });
        return {code: 0, stdout: result.stdout, stderr: result.stderr};
    } catch (error) {
        const failed = error as Error & {code?: number; stdout?: string; stderr?: string};
        return {
            code: typeof failed.code === "number" ? failed.code : 1,
            stdout: failed.stdout ?? "",
            stderr: failed.stderr ?? failed.message,
        };
    }
}

async function jj(cwd: string, ...args: string[]): Promise<string> {
    const result = await execJj(args, {cwd});
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
}

async function createRepoWithTaskWorkspaces(params: {conflicting: boolean}) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-merge-test-"));
    const root = path.join(temp, "repo");
    const task1 = path.join(temp, "task1");
    const task2 = path.join(temp, "task2");
    fs.mkdirSync(root);

    await jj(root, "git", "init", ".");
    await jj(root, "config", "set", "--repo", "user.name", "Test User");
    await jj(root, "config", "set", "--repo", "user.email", "test@example.com");
    fs.writeFileSync(path.join(root, "shared.txt"), "value=base\n");
    await jj(root, "commit", "-m", "base");
    await jj(root, "workspace", "add", "--name", "task1", "-r", "@", task1);
    await jj(root, "workspace", "add", "--name", "task2", "-r", "@", task2);

    if (params.conflicting) {
        fs.writeFileSync(path.join(task1, "shared.txt"), "value=task1\n");
        fs.writeFileSync(path.join(task2, "shared.txt"), "value=task2\n");
    } else {
        fs.writeFileSync(path.join(task1, "task1.txt"), "task1\n");
        fs.writeFileSync(path.join(task2, "task2.txt"), "task2\n");
    }

    await jj(task1, "commit", "-m", "task1");
    await jj(task2, "commit", "-m", "task2");
    await jj(root, "workspace", "update-stale");

    return {temp, root, task1, task2};
}

async function taskHead(workspace: string): Promise<string> {
    return jj(
        workspace,
        "--ignore-working-copy",
        "log",
        "-r",
        "latest(::@ & ~empty(), 1)",
        "--no-graph",
        "-T",
        "commit_id",
    );
}

async function workspaceCommitIds(workspace: string): Promise<string> {
    return jj(
        workspace,
        "--ignore-working-copy",
        "log",
        "-r",
        "@ | @-",
        "--no-graph",
        "-T",
        "commit_id ++ \"\\n\"",
    );
}

test("merging a task leaves unrelated task workspaces unchanged", async () => {
    assert.equal(typeof mergeTaskBranchOntoMain, "function");
    const repo = await createRepoWithTaskWorkspaces({conflicting: false});

    try {
        const task2Before = await workspaceCommitIds(repo.task2);
        const result = await mergeTaskBranchOntoMain!({
            root: repo.root,
            taskHeadCommitId: await taskHead(repo.task1),
            message: "merged task1",
            destinationMarker: "pi-task-test-destination-1",
            exec: execJj,
        });

        assert.deepEqual(result, {kind: "merged", hadConflicts: false});
        assert.equal(await workspaceCommitIds(repo.task2), task2Before);
        assert.equal(await jj(repo.root, "log", "-r", "@-", "--no-graph", "-T", "description"), "merged task1");
        assert.equal(await jj(repo.root, "log", "-r", "::@- & empty() & ~root()", "--no-graph", "-T", "commit_id"), "");
    } finally {
        fs.rmSync(repo.temp, {recursive: true, force: true});
    }
});

test("a conflicting task merge advances main and reports the conflict as a successful merge", async () => {
    assert.equal(typeof mergeTaskBranchOntoMain, "function");
    const repo = await createRepoWithTaskWorkspaces({conflicting: true});

    try {
        const first = await mergeTaskBranchOntoMain!({
            root: repo.root,
            taskHeadCommitId: await taskHead(repo.task1),
            message: "merged task1",
            destinationMarker: "pi-task-test-destination-2",
            exec: execJj,
        });
        assert.deepEqual(first, {kind: "merged", hadConflicts: false});

        const second = await mergeTaskBranchOntoMain!({
            root: repo.root,
            taskHeadCommitId: await taskHead(repo.task2),
            message: "merged task2",
            destinationMarker: "pi-task-test-destination-3",
            exec: execJj,
        });

        assert.deepEqual(second, {kind: "merged", hadConflicts: true});
        assert.equal(await jj(repo.root, "log", "-r", "@- & conflicts()", "--no-graph", "-T", "description"), "merged task2");
        assert.equal(await jj(repo.root, "diff", "--git", "--color=never"), "");
    } finally {
        fs.rmSync(repo.temp, {recursive: true, force: true});
    }
});
