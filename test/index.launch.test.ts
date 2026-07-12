import test from "node:test";
import assert from "node:assert/strict";

import * as taskExtension from "../index.js";

type DetectTaskWorkspaceLaunchMode = (env: Record<string, string | undefined>) => "herdr" | "tmux" | "ghostty" | "manual";
type BuildGhosttyWorkspaceTabAppleScript = (workspacePath: string, command?: string) => string;
type ParseHerdrWorkspaceCreateOutput = (stdout: string) =>
    | {ok: true; target: {workspaceId: string; rootPaneId: string}}
    | {ok: false; error: string};
type ExecResult = {code: number; stdout: string; stderr: string};
type LaunchHerdrWorkspace = (params: {
    workspacePath: string;
    slug: string;
    exec: (command: string, args: string[]) => Promise<ExecResult>;
}) => Promise<{ok: true} | {ok: false; error: string}>;
type LaunchTaskWorkspace = (params: {
    workspacePath: string;
    slug: string;
    env: Record<string, string | undefined>;
    exec: (command: string, args: string[]) => Promise<ExecResult>;
    notify: (message: string, level: "info" | "warning") => void;
}) => Promise<void>;

const {
    detectTaskWorkspaceLaunchMode,
    buildGhosttyWorkspaceTabAppleScript,
    parseHerdrWorkspaceCreateOutput,
    launchHerdrWorkspace,
    launchTaskWorkspace,
} = taskExtension as {
    detectTaskWorkspaceLaunchMode?: DetectTaskWorkspaceLaunchMode;
    buildGhosttyWorkspaceTabAppleScript?: BuildGhosttyWorkspaceTabAppleScript;
    parseHerdrWorkspaceCreateOutput?: ParseHerdrWorkspaceCreateOutput;
    launchHerdrWorkspace?: LaunchHerdrWorkspace;
    launchTaskWorkspace?: LaunchTaskWorkspace;
};

test("detectTaskWorkspaceLaunchMode detects Herdr", () => {
    assert.equal(typeof detectTaskWorkspaceLaunchMode, "function");
    assert.equal(detectTaskWorkspaceLaunchMode!({HERDR_ENV: "1"}), "herdr");
});

test("detectTaskWorkspaceLaunchMode prefers Herdr over tmux and Ghostty", () => {
    assert.equal(
        detectTaskWorkspaceLaunchMode!({
            HERDR_ENV: "1",
            TMUX: "tmux-session",
            GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app",
        }),
        "herdr",
    );
});

test("detectTaskWorkspaceLaunchMode only accepts the exact Herdr marker", () => {
    assert.equal(detectTaskWorkspaceLaunchMode!({HERDR_ENV: "true", TMUX: "tmux-session"}), "tmux");
});

test("detectTaskWorkspaceLaunchMode prefers tmux over Ghostty", () => {
    assert.equal(
        detectTaskWorkspaceLaunchMode!({TMUX: "tmux-session", GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app"}),
        "tmux",
    );
});

test("detectTaskWorkspaceLaunchMode returns ghostty when Ghostty env is present", () => {
    assert.equal(
        detectTaskWorkspaceLaunchMode!({GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app"}),
        "ghostty",
    );
});

test("detectTaskWorkspaceLaunchMode falls back to manual when no supported terminal env is present", () => {
    assert.equal(detectTaskWorkspaceLaunchMode!({}), "manual");
});

test("parseHerdrWorkspaceCreateOutput extracts workspace and root pane IDs", () => {
    assert.equal(typeof parseHerdrWorkspaceCreateOutput, "function");
    assert.deepEqual(parseHerdrWorkspaceCreateOutput!(JSON.stringify({
        result: {
            workspace: {workspace_id: "workspace-1"},
            root_pane: {pane_id: "pane-1"},
        },
    })), {
        ok: true,
        target: {workspaceId: "workspace-1", rootPaneId: "pane-1"},
    });
});

test("parseHerdrWorkspaceCreateOutput rejects invalid JSON", () => {
    const result = parseHerdrWorkspaceCreateOutput!("not json");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /invalid JSON/i);
});

test("parseHerdrWorkspaceCreateOutput rejects missing or empty workspace IDs", () => {
    for (const workspaceId of [undefined, "", "   "]) {
        const result = parseHerdrWorkspaceCreateOutput!(JSON.stringify({
            result: {workspace: {workspace_id: workspaceId}, root_pane: {pane_id: "pane-1"}},
        }));
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.error, /workspace_id/);
    }
});

test("parseHerdrWorkspaceCreateOutput rejects missing or empty root pane IDs", () => {
    for (const paneId of [undefined, "", "   "]) {
        const result = parseHerdrWorkspaceCreateOutput!(JSON.stringify({
            result: {workspace: {workspace_id: "workspace-1"}, root_pane: {pane_id: paneId}},
        }));
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.error, /pane_id/);
    }
});

test("launchHerdrWorkspace creates a workspace and starts pi in its root pane", async () => {
    assert.equal(typeof launchHerdrWorkspace, "function");
    const calls: Array<[string, string[]]> = [];
    const result = await launchHerdrWorkspace!({
        workspacePath: "/tmp/task",
        slug: "task-slug",
        exec: async (command, args) => {
            calls.push([command, args]);
            return calls.length === 1
                ? {code: 0, stdout: JSON.stringify({result: {workspace: {workspace_id: "w1"}, root_pane: {pane_id: "p1"}}}), stderr: ""}
                : {code: 0, stdout: "", stderr: ""};
        },
    });

    assert.deepEqual(result, {ok: true});
    assert.deepEqual(calls, [
        ["herdr", ["workspace", "create", "--cwd", "/tmp/task", "--label", "task-slug", "--focus"]],
        ["herdr", ["pane", "run", "p1", "pi"]],
    ]);
});

test("launchHerdrWorkspace reports create failures without attempting another Herdr command", async () => {
    const calls: Array<[string, string[]]> = [];
    const result = await launchHerdrWorkspace!({
        workspacePath: "/tmp/task",
        slug: "task-slug",
        exec: async (command, args) => {
            calls.push([command, args]);
            return {code: 1, stdout: "create stdout", stderr: "create stderr"};
        },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.match(result.error, /create stdout/);
        assert.match(result.error, /create stderr/);
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "herdr");
});

test("launchTaskWorkspace falls back to manual instructions without opening Ghostty after a Herdr failure", async () => {
    assert.equal(typeof launchTaskWorkspace, "function");
    const calls: Array<[string, string[]]> = [];
    const notifications: Array<[string, "info" | "warning"]> = [];

    await launchTaskWorkspace!({
        workspacePath: "/tmp/task",
        slug: "task-slug",
        env: {
            HERDR_ENV: "1",
            GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app",
        },
        exec: async (command, args) => {
            calls.push([command, args]);
            return {code: 1, stdout: "", stderr: "create failed"};
        },
        notify: (message, level) => notifications.push([message, level]),
    });

    assert.deepEqual(calls, [[
        "herdr",
        ["workspace", "create", "--cwd", "/tmp/task", "--label", "task-slug", "--focus"],
    ]]);
    assert.equal(calls.some(([command]) => command === "osascript"), false);
    assert.deepEqual(notifications, [
        ["Failed to create Herdr workspace: create failed", "warning"],
        ["Next: cd /tmp/task && pi", "info"],
    ]);
});

test("launchHerdrWorkspace closes the new workspace when starting pi fails", async () => {
    const calls: Array<[string, string[]]> = [];
    const results: ExecResult[] = [
        {code: 0, stdout: JSON.stringify({result: {workspace: {workspace_id: "w1"}, root_pane: {pane_id: "p1"}}}), stderr: ""},
        {code: 1, stdout: "", stderr: "start failed"},
        {code: 0, stdout: "", stderr: ""},
    ];
    const result = await launchHerdrWorkspace!({
        workspacePath: "/tmp/task",
        slug: "task-slug",
        exec: async (command, args) => {
            calls.push([command, args]);
            return results.shift()!;
        },
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /start failed/);
    assert.deepEqual(calls.at(-1), ["herdr", ["workspace", "close", "w1"]]);
});

test("launchHerdrWorkspace preserves the start failure when cleanup also fails", async () => {
    const results: ExecResult[] = [
        {code: 0, stdout: JSON.stringify({result: {workspace: {workspace_id: "w1"}, root_pane: {pane_id: "p1"}}}), stderr: ""},
        {code: 1, stdout: "", stderr: "start failed"},
        {code: 1, stdout: "", stderr: "cleanup failed"},
    ];
    const result = await launchHerdrWorkspace!({
        workspacePath: "/tmp/task",
        slug: "task-slug",
        exec: async () => results.shift()!,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.match(result.error, /start failed/);
        assert.match(result.error, /cleanup failed/);
    }
});

test("buildGhosttyWorkspaceTabAppleScript configures workspace path and runs gpi by default", () => {
    assert.equal(typeof buildGhosttyWorkspaceTabAppleScript, "function");

    const script = buildGhosttyWorkspaceTabAppleScript!("/Users/colin/src/my-project");

    assert.match(script, /tell application "Ghostty"/);
    assert.match(script, /set initial working directory of cfg to "\/Users\/colin\/src\/my-project"/);
    assert.match(script, /set t to new tab in win with configuration cfg/);
    assert.match(script, /input text "gpi" to term/);
    assert.match(script, /send key "enter" to term/);
});
