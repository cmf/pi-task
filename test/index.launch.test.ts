import test from "node:test";
import assert from "node:assert/strict";

import * as taskExtension from "../index.js";

type DetectTaskWorkspaceLaunchMode = (env: Record<string, string | undefined>) => "tmux" | "ghostty" | "manual";
type BuildGhosttyWorkspaceTabAppleScript = (workspacePath: string, command?: string) => string;

const {detectTaskWorkspaceLaunchMode, buildGhosttyWorkspaceTabAppleScript} = taskExtension as {
    detectTaskWorkspaceLaunchMode?: DetectTaskWorkspaceLaunchMode;
    buildGhosttyWorkspaceTabAppleScript?: BuildGhosttyWorkspaceTabAppleScript;
};

test("detectTaskWorkspaceLaunchMode prefers tmux over Ghostty", () => {
    assert.equal(typeof detectTaskWorkspaceLaunchMode, "function");
    assert.equal(
        detectTaskWorkspaceLaunchMode!({TMUX: "tmux-session", GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app"}),
        "tmux",
    );
});

test("detectTaskWorkspaceLaunchMode returns ghostty when Ghostty env is present", () => {
    assert.equal(typeof detectTaskWorkspaceLaunchMode, "function");
    assert.equal(
        detectTaskWorkspaceLaunchMode!({GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app"}),
        "ghostty",
    );
});

test("detectTaskWorkspaceLaunchMode falls back to manual when no supported terminal env is present", () => {
    assert.equal(typeof detectTaskWorkspaceLaunchMode, "function");
    assert.equal(detectTaskWorkspaceLaunchMode!({}), "manual");
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
