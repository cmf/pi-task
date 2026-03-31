import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as taskExtension from "../index.js";

type LoadTaskPrompt = (name: string, cwd: string, agentDir: string, extensionModuleUrl?: string) => {
    content: string;
    path: string;
    source: "project" | "user" | "extension";
} | {
    error: string;
    searched: string[];
};

const {loadTaskPrompt} = taskExtension as {
    loadTaskPrompt?: LoadTaskPrompt;
};

function makeTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("loadTaskPrompt uses project base prompt and appends project then user append prompts", () => {
    assert.equal(typeof loadTaskPrompt, "function");

    const cwd = makeTempDir("pi-task-cwd-");
    const agentDir = makeTempDir("pi-task-agent-");

    fs.mkdirSync(path.join(cwd, ".pi", "task"), {recursive: true});
    fs.mkdirSync(path.join(agentDir, "task"), {recursive: true});

    fs.writeFileSync(path.join(cwd, ".pi", "task", "review.md"), "project base");
    fs.writeFileSync(path.join(agentDir, "task", "review.md"), "user base");
    fs.writeFileSync(path.join(cwd, ".pi", "task", "review-append.md"), "project append");
    fs.writeFileSync(path.join(agentDir, "task", "review-append.md"), "user append");

    const loaded = loadTaskPrompt!("review", cwd, agentDir);
    assert.ok(!("error" in loaded));
    assert.equal(loaded.path, path.join(cwd, ".pi", "task", "review.md"));
    assert.equal(loaded.source, "project");
    assert.equal(loaded.content, "project base\n\nproject append\n\nuser append");
});

test("loadTaskPrompt falls back to user base prompt and still appends project additions", () => {
    assert.equal(typeof loadTaskPrompt, "function");

    const cwd = makeTempDir("pi-task-cwd-");
    const agentDir = makeTempDir("pi-task-agent-");

    fs.mkdirSync(path.join(cwd, ".pi", "task"), {recursive: true});
    fs.mkdirSync(path.join(agentDir, "task"), {recursive: true});

    fs.writeFileSync(path.join(agentDir, "task", "implement.md"), "user base");
    fs.writeFileSync(path.join(cwd, ".pi", "task", "implement-append.md"), "project append");
    fs.writeFileSync(path.join(agentDir, "task", "implement-append.md"), "user append");

    const loaded = loadTaskPrompt!("implement", cwd, agentDir);
    assert.ok(!("error" in loaded));
    assert.equal(loaded.path, path.join(agentDir, "task", "implement.md"));
    assert.equal(loaded.source, "user");
    assert.equal(loaded.content, "user base\n\nproject append\n\nuser append");
});

test("loadTaskPrompt falls back to extension base prompt after project and user and appends all sources in priority order", () => {
    assert.equal(typeof loadTaskPrompt, "function");

    const cwd = makeTempDir("pi-task-cwd-");
    const agentDir = makeTempDir("pi-task-agent-");
    const extensionDir = makeTempDir("pi-task-extension-");

    fs.mkdirSync(path.join(cwd, ".pi", "task"), {recursive: true});
    fs.mkdirSync(path.join(agentDir, "task"), {recursive: true});
    fs.mkdirSync(path.join(extensionDir, "prompts"), {recursive: true});

    fs.writeFileSync(path.join(extensionDir, "prompts", "manual-test.md"), "extension base");
    fs.writeFileSync(path.join(cwd, ".pi", "task", "manual-test-append.md"), "project append");
    fs.writeFileSync(path.join(agentDir, "task", "manual-test-append.md"), "user append");
    fs.writeFileSync(path.join(extensionDir, "prompts", "manual-test-append.md"), "extension append");

    const extensionModuleUrl = new URL(`file://${path.join(extensionDir, "index.ts")}`).href;
    const loaded = loadTaskPrompt!("manual-test", cwd, agentDir, extensionModuleUrl);
    assert.ok(!("error" in loaded));
    assert.equal(loaded.path, path.join(extensionDir, "prompts", "manual-test.md"));
    assert.equal(loaded.source, "extension");
    assert.equal(loaded.content, "extension base\n\nproject append\n\nuser append\n\nextension append");
});
