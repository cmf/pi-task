/**
 * Task Extension - Deterministic task workflow for jj workspaces
 *
 * Provides /task command that detects workspace type:
 * - Main workspace: handles merge/cleanup of completed task workspaces, task selection
 * - Task workspace: handles active task work
 */

// Workflow state graph is defined in state-machine.ts.
// .tasks/workflow.json remains the persisted source of truth for current state/tree.

import type {ExtensionAPI, ExtensionCommandContext, ExtensionContext} from "@earendil-works/pi-coding-agent";
import {getAgentDir, parseFrontmatter} from "@earendil-works/pi-coding-agent";
import {StringEnum} from "@earendil-works/pi-ai";
import {Type} from "typebox";
import {
    canReplayCompleteFromAssistantMessage,
    eventNeedsRootIssueMarkdown,
    isWorkflowState,
    stateAllowsActiveDepthForKind as stateAllowsActiveDepthForKindMachine,
    transition as runWorkflowTransition,
    type ActiveTaskTarget as MachineActiveTaskTarget,
    type AppliedTransitionDecision as MachineAppliedTransitionDecision,
    type TransitionDecision as MachineTransitionDecision,
    type WorkflowEffect as MachineWorkflowEffect,
    type WorkflowEvent as MachineWorkflowEvent,
    type WorkflowSnapshot as MachineWorkflowSnapshot,
    type WorkflowState as MachineWorkflowState,
    type WorkflowKind,
    type ManualTestStatus,
} from "./state-machine.js";
import {
    addIssueComment,
    closeIssue as closeGitHubIssue,
    createIssueWithParent,
    findChildIssueByExactTitle,
    getIssueByNumber,
    listOpenRootIssues,
    markIssueInProgressWithLabel,
    updateIssueBody,
    GitHubSubIssueLinkError,
    type GitHubClientConfig,
    type GitHubIssueSummary,
} from "./github.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {fileURLToPath} from "node:url";

const DEFAULT_AGENT_START_TIMEOUT_MS = 10000;
const WORKFLOW_SCHEMA_VERSION = 2;
const WORKFLOW_DIR_NAME = ".tasks";
const WORKFLOW_FILE_NAME = "workflow.json";
const UNBOUND_SESSION_LEAF_ID = "unbound";
const ENABLE_TRANSITION_DEBUG = process.env.PI_TASK_DEBUG === "1";
const DEFAULT_GITHUB_TOKEN_PATH = path.join(os.homedir(), ".api-keys", "github-tasks");
const IN_PROGRESS_LABEL = "status:in-progress";
const githubConfigCache = new Map<string, GitHubClientConfig>();

const TASK_ISSUE_SECTION_HEADERS = {
    plan: "## Plan",
    manual_test_plan: "## Manual Test Plan",
    manual_verification: "## Manual Verification",
    summary_of_changes: "## Summary of Changes",
} as const;

type TaskIssueSection = keyof typeof TASK_ISSUE_SECTION_HEADERS;

const TaskIssueTargetParams = {
    target: StringEnum(["active", "root"] as const, {
        description: "Which workflow issue to edit.",
    }),
};

const TaskIssueSectionParam = StringEnum(["plan", "manual_test_plan", "manual_verification", "summary_of_changes"] as const, {
    description: "Workflow issue section to edit.",
});

const TaskIssueReplacementEditParams = Type.Object({
    oldText: Type.String({
        description: "Exact text for one targeted replacement. It must be unique in the section or description body and must not overlap with any other edits[].oldText in the same call.",
    }),
    newText: Type.String({
        description: "Replacement text for this targeted edit. Must not contain level-2 markdown headers (`## ...`).",
    }),
});

const TaskIssueInsertSectionToolParams = Type.Object({
    ...TaskIssueTargetParams,
    section: TaskIssueSectionParam,
    content: Type.String({
        description: "Section body to insert, without `##` headers.",
    }),
});

const TaskIssueEditSectionToolParams = Type.Object({
    ...TaskIssueTargetParams,
    section: TaskIssueSectionParam,
    edits: Type.Array(TaskIssueReplacementEditParams, {
        description: "One or more targeted replacements. Each edit is matched against the original section body, not incrementally. Do not include overlapping or nested edits.",
    }),
});

const TaskIssueEditDescriptionToolParams = Type.Object({
    ...TaskIssueTargetParams,
    edits: Type.Array(TaskIssueReplacementEditParams, {
        description: "One or more targeted replacements. Each edit is matched against the original issue description before the first `##` section, not incrementally. Do not include overlapping or nested edits.",
    }),
});

type TaskIssueToolTarget = "active" | "root";
type TaskIssueInsertSectionToolInput = {target: TaskIssueToolTarget; section: TaskIssueSection; content: string};
type TaskIssueEditSectionToolInput = {target: TaskIssueToolTarget; section: TaskIssueSection; edits: Edit[]};
type TaskIssueEditDescriptionToolInput = {target: TaskIssueToolTarget; edits: Edit[]};
type TaskIssueToolInput = TaskIssueInsertSectionToolInput | TaskIssueEditSectionToolInput | TaskIssueEditDescriptionToolInput;

type TaskIssueBodyEditInput =
    | {tool: "task_issue_insert_section"; section: TaskIssueSection; content: string}
    | {tool: "task_issue_edit_section"; section: TaskIssueSection; edits: Edit[]}
    | {tool: "task_issue_edit_description"; edits: Edit[]};

export function validateWorkflowCommandKind(
    commandKind: WorkflowKind,
    persistedKind: WorkflowKind,
): {ok: true} | {error: string} {
    if (commandKind === persistedKind) return {ok: true};
    return {error: persistedKind === "fix" ? "This is a fix workspace. Run /fix." : "This is a task workspace. Run /task."};
}

export function normalizeSessionFilePath(sessionFile: string | undefined): string | null {
    if (!sessionFile) return null;
    const trimmed = sessionFile.trim();
    return trimmed ? trimmed : null;
}

export function shouldNotifyPendingTransitionOutsideTaskLoop(params: {
    workflowKind?: WorkflowKind;
    workflowState: MachineWorkflowState;
    latestAssistantMessageId: string | null;
    latestAssistantMessageText: string;
    lastConsumedAssistantId?: string | null;
    taskLoopActive: boolean;
}): boolean {
    if (params.taskLoopActive) return false;
    if (!params.latestAssistantMessageId) return false;
    if ((params.lastConsumedAssistantId ?? null) === params.latestAssistantMessageId) return false;
    return canReplayCompleteFromAssistantMessage(params.workflowKind ?? "task", params.workflowState, params.latestAssistantMessageText);
}

export function findPendingPromptRunCompletionCandidate(params: {
    branch: Array<{type?: string; id?: unknown; message?: unknown}>;
    workflowKind?: WorkflowKind;
    pendingPromptRun?: PendingPromptRun | null;
    workflowState: MachineWorkflowState;
    activeTaskId: string;
    sessionLeafId: string;
    lastConsumedAssistantId?: string | null;
}): {assistantMessageId: string; assistantMessage: string; hadErrors: boolean} | null {
    const pending = params.pendingPromptRun ?? null;
    if (!pending) return null;
    if (pending.state !== params.workflowState) return null;
    if (pending.active_task_id !== params.activeTaskId) return null;
    if (pending.session_leaf_id !== params.sessionLeafId) return null;

    const previousAssistantId = pending.previous_assistant_id ?? null;
    if (!previousAssistantId) {
        return null;
    }

    const previousAssistantIndex = params.branch.findIndex((entry) => entry.type === "message" && entry.id === previousAssistantId);
    if (previousAssistantIndex < 0) {
        return null;
    }

    let promptUserIndex = -1;
    for (let i = previousAssistantIndex + 1; i < params.branch.length; i++) {
        const entry = params.branch[i];
        if (entry.type !== "message") continue;
        const message = entry.message as {role?: unknown} | undefined;
        if (message?.role === "user") {
            promptUserIndex = i;
            break;
        }
    }
    if (promptUserIndex < 0) {
        return null;
    }

    let nextUserIndex = params.branch.length;
    for (let i = promptUserIndex + 1; i < params.branch.length; i++) {
        const entry = params.branch[i];
        if (entry.type !== "message") continue;
        const message = entry.message as {role?: unknown} | undefined;
        if (message?.role === "user") {
            nextUserIndex = i;
            break;
        }
    }

    let candidate: {assistantMessageId: string; assistantMessage: string; hadErrors: boolean} | null = null;
    let sawToolError = false;

    for (let i = promptUserIndex + 1; i < nextUserIndex; i++) {
        const entry = params.branch[i];
        if (entry.type !== "message") continue;
        const message = entry.message as {
            role?: unknown;
            content?: unknown;
            stopReason?: unknown;
            errorMessage?: unknown;
            isError?: unknown;
        } | undefined;
        if (!message) continue;

        if (message.role === "toolResult") {
            if (message.isError === true) {
                sawToolError = true;
            }
            continue;
        }

        if (message.role !== "assistant") {
            continue;
        }

        if (
            message.stopReason === "error"
            || message.stopReason === "aborted"
            || typeof message.errorMessage === "string"
        ) {
            return null;
        }

        if (message.stopReason === "toolUse") {
            continue;
        }

        if (typeof entry.id !== "string" || !entry.id.trim()) {
            continue;
        }

        candidate = {
            assistantMessageId: entry.id,
            assistantMessage: extractMessageText(message.content),
            hadErrors: sawToolError,
        };
    }

    if (!candidate) {
        return null;
    }

    if ((params.lastConsumedAssistantId ?? null) === candidate.assistantMessageId) {
        return null;
    }

    return candidate;
}

export function replayAfterErrorsNotice(workflowKind: WorkflowKind): string {
    return `The previous /${workflowKind} run reported tool errors, but the agent later produced a completion. Replaying that completion now.`;
}

export function completionReadyToMergeNotice(params: {
    changed: boolean;
    nextState: MachineWorkflowState;
    workflowKind?: WorkflowKind;
}): string | null {
    if (!params.changed || params.nextState !== "complete") {
        return null;
    }

    return `Final commit succeeded. ${params.workflowKind === "fix" ? "Fix" : "Task"} workspace is ready to merge.`;
}

export function resolveEditorPrefillValue(
    input: string | undefined,
    defaultValue: string,
    options?: {singleLine?: boolean},
): string {
    const trimmed = typeof input === "string" ? input.trim() : "";
    if (!trimmed) {
        return defaultValue;
    }

    if (!options?.singleLine) {
        return trimmed;
    }

    const firstNonEmptyLine = trimmed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);

    return firstNonEmptyLine ?? defaultValue;
}

export function resolveEditorDialogValue(
    input: string | undefined,
    defaultValue: string,
    options?: {singleLine?: boolean},
): {cancelled: true} | {cancelled: false; value: string} {
    if (input === undefined) {
        return {cancelled: true};
    }

    return {
        cancelled: false,
        value: resolveEditorPrefillValue(input, defaultValue, options),
    };
}

export type TaskWorkspaceLaunchMode = "herdr" | "tmux" | "ghostty" | "manual";

export type HerdrWorkspaceLaunchTarget = {
    workspaceId: string;
    rootPaneId: string;
};

type WorkspaceLaunchExecResult = {code: number; stdout: string; stderr: string};
type WorkspaceLaunchExec = (command: string, args: string[]) => Promise<WorkspaceLaunchExecResult>;

export function detectTaskWorkspaceLaunchMode(env: Record<string, string | undefined>): TaskWorkspaceLaunchMode {
    if (env.HERDR_ENV === "1") {
        return "herdr";
    }
    if (env.TMUX) {
        return "tmux";
    }
    if (env.GHOSTTY_RESOURCES_DIR) {
        return "ghostty";
    }
    return "manual";
}

export function parseHerdrWorkspaceCreateOutput(stdout: string):
    | {ok: true; target: HerdrWorkspaceLaunchTarget}
    | {ok: false; error: string} {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch (error) {
        return {ok: false, error: `Herdr workspace create returned invalid JSON: ${error}`};
    }

    const result = isObject(parsed) && isObject(parsed.result) ? parsed.result : null;
    const workspace = result && isObject(result.workspace) ? result.workspace : null;
    const rootPane = result && isObject(result.root_pane) ? result.root_pane : null;
    const workspaceId = typeof workspace?.workspace_id === "string" ? workspace.workspace_id.trim() : "";
    const rootPaneId = typeof rootPane?.pane_id === "string" ? rootPane.pane_id.trim() : "";

    if (!workspaceId) {
        return {ok: false, error: "Herdr workspace create response is missing non-empty result.workspace.workspace_id."};
    }
    if (!rootPaneId) {
        return {ok: false, error: "Herdr workspace create response is missing non-empty result.root_pane.pane_id."};
    }

    return {ok: true, target: {workspaceId, rootPaneId}};
}

function externalCommandError(result: WorkspaceLaunchExecResult): string {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    if (stderr && stdout) {
        return `stderr: ${stderr}; stdout: ${stdout}`;
    }
    return stderr || stdout || "unknown error";
}

export async function launchHerdrWorkspace(params: {
    workspacePath: string;
    slug: string;
    exec: WorkspaceLaunchExec;
}): Promise<{ok: true} | {ok: false; error: string}> {
    const createResult = await params.exec("herdr", [
        "workspace", "create",
        "--cwd", params.workspacePath,
        "--label", params.slug,
        "--focus",
    ]);
    if (createResult.code !== 0) {
        return {ok: false, error: `Failed to create Herdr workspace: ${externalCommandError(createResult)}`};
    }

    const parsed = parseHerdrWorkspaceCreateOutput(createResult.stdout);
    if (!parsed.ok) {
        return parsed;
    }

    const startResult = await params.exec("herdr", ["pane", "run", parsed.target.rootPaneId, "pi"]);
    if (startResult.code === 0) {
        return {ok: true};
    }

    const startError = externalCommandError(startResult);
    const cleanupResult = await params.exec("herdr", ["workspace", "close", parsed.target.workspaceId]);
    if (cleanupResult.code !== 0) {
        return {
            ok: false,
            error: `Failed to start Pi in Herdr workspace: ${startError}. Also failed to close Herdr workspace ${parsed.target.workspaceId}: ${externalCommandError(cleanupResult)}`,
        };
    }

    return {ok: false, error: `Failed to start Pi in Herdr workspace: ${startError}`};
}

function escapeAppleScriptString(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildGhosttyWorkspaceTabAppleScript(workspacePath: string, command = "gpi"): string {
    const escapedWorkspacePath = escapeAppleScriptString(workspacePath);
    const escapedCommand = escapeAppleScriptString(command);

    return [
        'tell application "Ghostty"',
        "    set cfg to new surface configuration",
        `    set initial working directory of cfg to "${escapedWorkspacePath}"`,
        "",
        "    if (count of windows) = 0 then",
        "        set win to new window with configuration cfg",
        "    else",
        "        set win to front window",
        "    end if",
        "",
        "    set t to new tab in win with configuration cfg",
        "    set term to focused terminal of t",
        "",
        `    input text "${escapedCommand}" to term`,
        '    send key "enter" to term',
        "end tell",
    ].join("\n");
}

export async function launchTaskWorkspace(params: {
    workspacePath: string;
    slug: string;
    env: Record<string, string | undefined>;
    exec: WorkspaceLaunchExec;
    notify: (message: string, level: "info" | "warning") => void;
}): Promise<void> {
    const launchMode = detectTaskWorkspaceLaunchMode(params.env);
    if (launchMode === "herdr") {
        const herdrResult = await launchHerdrWorkspace({
            workspacePath: params.workspacePath,
            slug: params.slug,
            exec: params.exec,
        });
        if (herdrResult.ok) {
            params.notify(`Opened Herdr workspace: ${params.slug}`, "info");
            return;
        }

        params.notify(herdrResult.error, "warning");
        params.notify(`Next: cd ${params.workspacePath} && pi`, "info");
        return;
    }

    if (launchMode === "tmux") {
        await params.exec("tmux", ["new-window", "-n", params.slug, "-c", params.workspacePath]);
        await params.exec("tmux", ["send-keys", "pi", "Enter"]);
        params.notify(`Opened tmux window: ${params.slug}`, "info");
        return;
    }

    if (launchMode === "ghostty") {
        const ghosttyResult = await params.exec("osascript", ["-e", buildGhosttyWorkspaceTabAppleScript(params.workspacePath)]);
        if (ghosttyResult.code === 0) {
            params.notify(`Opened Ghostty tab: ${params.slug}`, "info");
            return;
        }

        const ghosttyError = ghosttyResult.stderr.trim() || ghosttyResult.stdout.trim() || "unknown error";
        params.notify(`Failed to open Ghostty tab automatically: ${ghosttyError}`, "warning");
    }

    params.notify(`Next: cd ${params.workspacePath} && pi`, "info");
}

function normalizeMarkdownNewlines(text: string): string {
    return text.replace(/\r\n?/g, "\n");
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			.normalize("NFKC")
			// Strip trailing whitespace per line
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

export interface FuzzyMatchResult {
	/** Whether a match was found */
	found: boolean;
	/** The index where the match starts (in the content that should be used for replacement) */
	index: number;
	/** Length of the matched text */
	matchLength: number;
	/** Whether fuzzy matching was used (false = exact match) */
	usedFuzzyMatch: boolean;
	/**
	 * The content to use for replacement operations.
	 * When exact match: original content. When fuzzy match: normalized content.
	 */
	contentForReplacement: string;
}

export interface Edit {
	oldText: string;
	newText: string;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * When fuzzy matching is used, the returned contentForReplacement is the
 * fuzzy-normalized version of the content (trailing whitespace stripped,
 * Unicode quotes/dashes normalized to ASCII).
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	// Try exact match first
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// Try fuzzy match - work entirely in normalized space
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

	if (fuzzyIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// When fuzzy matching, we work in the normalized space for replacement.
	// This means the output will have normalized whitespace/quotes/dashes,
	// which is acceptable since we're fixing minor formatting differences anyway.
	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

function countOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
	);
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. If any edit needs
 * fuzzy matching, the operation runs in fuzzy-normalized content space to
 * preserve current single-edit behavior.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
	const baseContent = initialMatches.some((match) => match.usedFuzzyMatch)
		? normalizeForFuzzyMatch(normalizedContent)
		: normalizedContent;

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(baseContent, edit.oldText);
		if (!matchResult.found) {
			throw getNotFoundError(path, i, normalizedEdits.length);
		}

		const occurrences = countOccurrences(baseContent, edit.oldText);
		if (occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	let newContent = baseContent;
	for (let i = matchedEdits.length - 1; i >= 0; i--) {
		const edit = matchedEdits[i];
		newContent =
			newContent.substring(0, edit.matchIndex) +
			edit.newText +
			newContent.substring(edit.matchIndex + edit.matchLength);
	}

	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent };
}

export function parseIssueNumberFromTaskId(taskId: string): number | null {
    const trimmed = taskId.trim();
    if (!trimmed) return null;

    if (/^\d+$/.test(trimmed)) {
        const parsed = Number(trimmed);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }

    const hashMatch = /^#(\d+)$/.exec(trimmed);
    if (hashMatch) {
        const parsed = Number(hashMatch[1]);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }

    const ownerRepoHashMatch = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#(\d+)$/.exec(trimmed);
    if (ownerRepoHashMatch) {
        const parsed = Number(ownerRepoHashMatch[1]);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }

    const issueUrlMatch = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)(?:[/?#].*)?$/i.exec(trimmed);
    if (issueUrlMatch) {
        const parsed = Number(issueUrlMatch[1]);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }

    return null;
}

export function inProgressRootIssueIdFromWorkflow(params: {
    workflowState: MachineWorkflowState;
    rootTaskId: string;
}): string | null {
    if (params.workflowState === "complete") {
        return null;
    }

    const issueNumber = parseIssueNumberFromTaskId(params.rootTaskId);
    if (!issueNumber) {
        return null;
    }

    return String(issueNumber);
}

const LEVEL_2_MARKDOWN_HEADER_PATTERN = /^##\s+/m;
const LEVEL_2_MARKDOWN_HEADER_ERROR = "Section bodies must not contain level-2 markdown headers (`## ...`). Use `###` or lower inside a section.";

type MarkdownSectionRange = {
    headerStart: number;
    headerEnd: number;
    bodyStart: number;
    bodyEnd: number;
};

function assertNoLevel2MarkdownHeaders(content: string): void {
    if (LEVEL_2_MARKDOWN_HEADER_PATTERN.test(normalizeMarkdownNewlines(content))) {
        throw new Error(LEVEL_2_MARKDOWN_HEADER_ERROR);
    }
}

function taskIssueSectionHeaderPattern(header: string): RegExp {
    return new RegExp(`^${escapeRegExp(normalizeMarkdownNewlines(header).trim())}\\s*$`, "m");
}

function findNextWorkflowSectionStart(body: string, fromIndex: number): number {
    const sectionHeaders = Object.values(TASK_ISSUE_SECTION_HEADERS);
    let nextIndex = body.length;

    for (const sectionHeader of sectionHeaders) {
        const match = taskIssueSectionHeaderPattern(sectionHeader).exec(body.slice(fromIndex));
        if (match) {
            nextIndex = Math.min(nextIndex, fromIndex + match.index);
        }
    }

    return nextIndex;
}

export function findMarkdownSectionRange(body: string, header: string): MarkdownSectionRange | null {
    const normalizedBody = normalizeMarkdownNewlines(body ?? "");
    const headerMatch = taskIssueSectionHeaderPattern(header).exec(normalizedBody);
    if (!headerMatch) {
        return null;
    }

    const headerStart = headerMatch.index;
    const headerEnd = headerStart + headerMatch[0].length;
    const bodyStart = normalizedBody[headerEnd] === "\n" ? headerEnd + 1 : headerEnd;
    const bodyEnd = findNextWorkflowSectionStart(normalizedBody, bodyStart);

    return {headerStart, headerEnd, bodyStart, bodyEnd};
}

export function insertMarkdownSection(existingBody: string, header: string, content: string): string {
    assertNoLevel2MarkdownHeaders(content);

    const normalizedBody = normalizeMarkdownNewlines(existingBody ?? "");
    const normalizedHeader = normalizeMarkdownNewlines(header).trim();
    const normalizedContent = normalizeMarkdownNewlines(content).trim();
    const sectionBlock = `${normalizedHeader}\n${normalizedContent}`;

    if (findMarkdownSectionRange(normalizedBody, normalizedHeader)) {
        throw new Error(`Section already exists: ${normalizedHeader}`);
    }

    if (!normalizedBody.trim()) {
        return sectionBlock;
    }

    const separator = normalizedBody.endsWith("\n") ? "" : "\n\n";
    return `${normalizedBody}${separator}${sectionBlock}`;
}

export function editMarkdownSection(existingBody: string, header: string, edits: Edit[]): string {
    for (const edit of edits) {
        assertNoLevel2MarkdownHeaders(edit.newText);
    }

    const normalizedBody = normalizeMarkdownNewlines(existingBody ?? "");
    const normalizedHeader = normalizeMarkdownNewlines(header).trim();
    const range = findMarkdownSectionRange(normalizedBody, normalizedHeader);
    if (!range) {
        throw new Error(`Section not found: ${normalizedHeader}`);
    }

    const sectionBody = normalizedBody.slice(range.bodyStart, range.bodyEnd);
    const result = applyEditsToNormalizedContent(sectionBody, edits, `section ${normalizedHeader}`);
    const afterSection = normalizedBody.slice(range.bodyEnd);
    const boundaryWhitespace = afterSection ? /\n+$/.exec(sectionBody)?.[0] ?? "\n" : "";
    const nextContent = afterSection && result.newContent && !result.newContent.endsWith("\n")
        ? `${result.newContent}${boundaryWhitespace}`
        : result.newContent;
    return `${normalizedBody.slice(0, range.bodyStart)}${nextContent}${afterSection}`;
}

export function editIssueDescription(existingBody: string, edits: Edit[]): string {
    for (const edit of edits) {
        assertNoLevel2MarkdownHeaders(edit.newText);
    }

    const normalizedBody = normalizeMarkdownNewlines(existingBody ?? "");
    const firstSection = LEVEL_2_MARKDOWN_HEADER_PATTERN.exec(normalizedBody);
    const descriptionEnd = firstSection ? firstSection.index : normalizedBody.length;
    const description = normalizedBody.slice(0, descriptionEnd);
    const rest = firstSection ? normalizedBody.slice(firstSection.index) : "";

    let nextDescription: string;
    if (edits.length === 1 && edits[0].oldText === "" && description.trim().length === 0) {
        nextDescription = normalizeMarkdownNewlines(edits[0].newText);
        if (nextDescription === description) {
            throw new Error("No changes made to issue description. The replacement produced identical content.");
        }
    } else {
        nextDescription = applyEditsToNormalizedContent(description, edits, "issue description").newContent;
    }

    if (!rest) {
        return nextDescription;
    }
    if (!nextDescription) {
        return rest;
    }
    const separator = nextDescription.endsWith("\n") ? "" : "\n\n";
    return `${nextDescription}${separator}${rest}`;
}

export function computeTaskIssueEditBody(existingBody: string, input: TaskIssueBodyEditInput): string {
    if (input.tool === "task_issue_insert_section") {
        return insertMarkdownSection(existingBody, taskIssueSectionHeader(input.section), input.content);
    }
    if (input.tool === "task_issue_edit_section") {
        return editMarkdownSection(existingBody, taskIssueSectionHeader(input.section), input.edits);
    }
    return editIssueDescription(existingBody, input.edits);
}

type TaskApplyArgs = {findings: string[]; instruction?: string};

const TASK_APPLY_USAGE = "Usage: /task apply <finding-number-or-range> [finding-number-or-range ...] [instruction]";
const TASK_APPLY_MAX_FINDINGS = 50;

export function parseTaskApplyArgs(args: string): TaskApplyArgs | {error: string} {
    const trimmed = args.trim();
    if (!trimmed) {
        return {error: TASK_APPLY_USAGE};
    }

    const findings: string[] = [];
    const seen = new Set<string>();
    const addFinding = (finding: number) => {
        const token = String(finding);
        if (!seen.has(token)) {
            seen.add(token);
            findings.push(token);
        }
    };

    let instructionStart: number | null = null;
    for (const match of trimmed.matchAll(/\S+/g)) {
        const rawToken = match[0];
        const token = rawToken.replace(/,+$/g, "");
        if (!token) {
            continue;
        }

        const parts = token.split(",").filter(Boolean);
        const tokenLooksLikeFindingSyntax = /^[\d,-]+$/.test(token);
        const allPartsHaveFindingSyntax = parts.length > 0
            && parts.every((part) => /^[1-9]\d*(?:-[1-9]\d*)?$/.test(part));

        if (!allPartsHaveFindingSyntax) {
            if (findings.length === 0) {
                return {error: tokenLooksLikeFindingSyntax ? `Finding identifiers must be positive integers or ranges: ${token}` : TASK_APPLY_USAGE};
            }
            if (tokenLooksLikeFindingSyntax) {
                return {error: `Finding identifiers must be positive integers or ranges: ${token}`};
            }
            instructionStart = match.index ?? 0;
            break;
        }

        for (const part of parts) {
            const rangeMatch = /^([1-9]\d*)-([1-9]\d*)$/.exec(part);
            if (rangeMatch) {
                const start = Number(rangeMatch[1]);
                const end = Number(rangeMatch[2]);
                if (start > end) {
                    return {error: `Finding ranges must be ascending: ${part}`};
                }
                for (let finding = start; finding <= end; finding += 1) {
                    addFinding(finding);
                    if (findings.length > TASK_APPLY_MAX_FINDINGS) {
                        return {error: `Cannot apply more than ${TASK_APPLY_MAX_FINDINGS} findings at once.`};
                    }
                }
                continue;
            }

            addFinding(Number(part));
            if (findings.length > TASK_APPLY_MAX_FINDINGS) {
                return {error: `Cannot apply more than ${TASK_APPLY_MAX_FINDINGS} findings at once.`};
            }
        }
    }

    if (findings.length === 0) {
        return {error: TASK_APPLY_USAGE};
    }

    const instruction = instructionStart === null ? "" : trimmed.slice(instructionStart).trim();
    return instruction ? {findings, instruction} : {findings};
}

export function buildTaskApplyPrompt(params: {finding: string; rootIssueMarkdown: string; instruction?: string}): string {
    const finding = params.finding.trim();
    const rootIssueMarkdown = params.rootIssueMarkdown.trimEnd();
    const instruction = params.instruction?.trim() ?? "";
    const instructionLines = instruction
        ? [
            "",
            "Additional user instruction for this apply operation:",
            "<apply-instruction>",
            instruction,
            "</apply-instruction>",
        ]
        : [];

    return [
        `You are applying finding ${finding} from the review findings immediately above into the task plan.`,
        "",
        "Critical:",
        "- The current root issue content below is authoritative.",
        "- Ignore older copies of the plan or manual test plan in the conversation.",
        `- Apply only finding ${finding}.`,
        ...instructionLines,
        "- Preserve all unrelated plan, manual-test, and description content.",
        "- Use exact root issue edits; prefer small, unique `oldText` blocks.",
        "- Do not replace a whole section unless most of a section changed.",
        "- Use `task_issue_edit_section` when an existing root workflow section needs changes.",
        "- Use `task_issue_insert_section` when a required root workflow section is missing.",
        "- Use `task_issue_edit_description` if the finding invalidates root issue description or design text; update that text instead of repeatedly raising the same finding.",
        "- If the root issue `## Plan` section exists:",
        "  - tool: `task_issue_edit_section`",
        "  - `target: \"root\"`",
        "  - `section: \"plan\"`",
        "  - `edits: <small unique replacements inside the plan section body; keep <subtasks>...</subtasks> valid>`",
        "- If the root issue `## Plan` section is missing:",
        "  - tool: `task_issue_insert_section`",
        "  - `target: \"root\"`",
        "  - `section: \"plan\"`",
        "  - `content: <plan section body only, including <subtasks>...</subtasks>>`",
        "- If the root issue `## Manual Test Plan` section exists:",
        "  - tool: `task_issue_edit_section`",
        "  - `target: \"root\"`",
        "  - `section: \"manual_test_plan\"`",
        "  - `edits: <small unique replacements inside the manual test plan section body>`",
        "- If the root issue `## Manual Test Plan` section is missing:",
        "  - tool: `task_issue_insert_section`",
        "  - `target: \"root\"`",
        "  - `section: \"manual_test_plan\"`",
        "  - `content: <manual test plan section body only>`",
        `- If finding ${finding} invalidates issue description or design text, use \`task_issue_edit_description\` with \`target: \"root\"\`.`,
        "- Do not include `##` headers in section or description content; use `###` or lower inside a section.",
        "- Do not include the `# Title` line from the current root issue content in any edit.",
        "- Do not emit any workflow transition.",
        "- If you emit any `<transition>...</transition>` tag, it will be ignored; this command only edits the root issue.",
        "- Do not implement code.",
        "",
        "## Current root issue content",
        "",
        "<root-issue-current>",
        rootIssueMarkdown,
        "</root-issue-current>",
    ].join("\n");
}

export function buildTaskIssueHandlingHeader(params: {
    workflowKind?: WorkflowKind;
    workflowVersion: number;
    workflowState: string;
    manualTestStatus?: ManualTestStatus;
    activeIssueId: string;
    activePathIds: string[];
}): string {
    const issueHandlingRules = params.workflowState === "refine"
        ? [
            "- In refine, replace the entire active issue body with the final standalone design using `gh issue edit`; do not use the targeted task issue editing tools for this rewrite.",
            "- Use the Active Issue ID above as the `gh issue edit` issue identifier. In refine, this is the root issue id from `.tasks/workflow.json`.",
            "- Safe form: write the final body to a temporary markdown file, then run `gh issue edit <Active Issue ID> --body-file <temp-file>`.",
            "- Do not include the `# Title` line from the issue context in the replacement body unless the user explicitly wants it in the body.",
            "- Do NOT ask the user to manually edit issue contents.",
            "- Do NOT manually perform issue lifecycle actions (close/reopen/in-progress markers); the extension controls workflow transitions.",
        ]
        : [
            "- For issue content updates, use the targeted tools: `task_issue_insert_section`, `task_issue_edit_section`, and `task_issue_edit_description`.",
            "- If a workflow section is missing, use `task_issue_insert_section`; if it exists, use `task_issue_edit_section` with small, unique `oldText` blocks.",
            "- If stale requirements or design text in the issue description need correction, use `task_issue_edit_description`.",
            "- Do not include `##` headers in section or description content; use `###` or lower inside a section.",
            "- Do NOT ask the user to manually edit issue contents.",
            "- Do NOT manually perform issue lifecycle actions (close/reopen/in-progress markers); the extension controls workflow transitions.",
        ];

    return [
        "## Issue Metadata",
        `- Workflow Kind: ${params.workflowKind ?? "task"}`,
        `- Workflow Version: ${params.workflowVersion}`,
        `- Workflow State: ${params.workflowState}`,
        ...(params.manualTestStatus ? [`- Manual Test Status: ${params.manualTestStatus}`] : []),
        `- Active Issue ID: ${params.activeIssueId}`,
        `- Active Path: ${params.activePathIds.join(" -> ")}`,
        "",
        "## Issue Handling Rules (critical)",
        ...issueHandlingRules,
        "",
        "## Issue Contents",
        "The following is the current issue context chain (root -> ... -> active):",
    ].join("\n");
}

export function validateTaskApplyAssistantMessage(message: string): {ok: true} | {error: string} {
    const transitionMatches = [...message.matchAll(/<transition>\s*([^<]+?)\s*<\/transition>/gi)];
    const lastTransition = transitionMatches.at(-1)?.[1]?.trim().toLowerCase();
    if (lastTransition) {
        return {error: `Unexpected workflow transition emitted during /task apply: ${lastTransition}`};
    }

    return {ok: true};
}

export function summarizeTaskApplyResults(params: {changed: string[]; unchanged: string[]}): {message: string; level: "info" | "warning"} {
    const changedLabel = `finding${params.changed.length === 1 ? "" : "s"}`;
    const unchangedLabel = `finding${params.unchanged.length === 1 ? "" : "s"}`;

    if (params.changed.length === 0) {
        return {
            level: "warning",
            message: `No root issue changes detected for ${unchangedLabel} ${params.unchanged.join(", ")}. Run /task to re-review the plan.`,
        };
    }

    if (params.unchanged.length === 0) {
        return {
            level: "warning",
            message: `Applied ${changedLabel} ${params.changed.join(", ")}. Run /task to re-review the plan.`,
        };
    }

    return {
        level: "warning",
        message: `Applied ${changedLabel} ${params.changed.join(", ")}; no root issue change detected for ${unchangedLabel} ${params.unchanged.join(", ")}. Run /task to re-review the plan.`,
    };
}

type TaskApplyNotifyLevel = "info" | "warning" | "error";

export interface TaskApplyIterationDeps {
    findings: string[];
    instruction?: string;
    baseLeafId: string;
    isIdle: () => boolean;
    waitForIdle: () => Promise<void>;
    navigateToBase: (baseLeafId: string, finding: string) => Promise<{cancelled: boolean}>;
    loadRootIssueMarkdown: () => Promise<{content: string} | {error: string}>;
    loadRootIssueBodyMarkdown?: () => Promise<{content: string} | {error: string}>;
    runPrompt: (prompt: string, finding: string) => Promise<{assistantMessage: string; assistantMessageId: string | null} | {error: string}>;
    consumeAssistantMessage: (assistantMessageId: string | null) => Promise<{ok: true} | {error: string}>;
    notify: (message: string, level: TaskApplyNotifyLevel) => void;
}

export async function runTaskApplyIterations(params: TaskApplyIterationDeps): Promise<boolean> {
    const changedFindings: string[] = [];
    const unchangedFindings: string[] = [];

    for (const finding of params.findings) {
        if (!params.isIdle()) {
            await params.waitForIdle();
        }

        let navigation;
        try {
            navigation = await params.navigateToBase(params.baseLeafId, finding);
        } catch (error) {
            params.notify(`Failed to navigate to apply base leaf ${params.baseLeafId}: ${error}`, "error");
            return false;
        }

        if (navigation.cancelled) {
            return false;
        }

        const beforeIssue = await params.loadRootIssueMarkdown();
        if ("error" in beforeIssue) {
            params.notify(beforeIssue.error, "error");
            return false;
        }

        const beforeIssueBody = params.loadRootIssueBodyMarkdown
            ? await params.loadRootIssueBodyMarkdown()
            : beforeIssue;
        if ("error" in beforeIssueBody) {
            params.notify(beforeIssueBody.error, "error");
            return false;
        }

        const promptResult = await params.runPrompt(buildTaskApplyPrompt({
            finding,
            instruction: params.instruction,
            rootIssueMarkdown: beforeIssue.content,
        }), finding);
        if ("error" in promptResult) {
            params.notify(promptResult.error, "error");
            return false;
        }

        const validation = validateTaskApplyAssistantMessage(promptResult.assistantMessage);
        if ("error" in validation) {
            const consumed = await params.consumeAssistantMessage(promptResult.assistantMessageId);
            if ("error" in consumed) {
                params.notify(consumed.error, "error");
                return false;
            }

            params.notify(`${validation.error}; ignored. Run /task to re-review the updated plan.`, "warning");
            return false;
        }

        const consumed = await params.consumeAssistantMessage(promptResult.assistantMessageId);
        if ("error" in consumed) {
            params.notify(consumed.error, "error");
            return false;
        }

        const afterIssueBody = params.loadRootIssueBodyMarkdown
            ? await params.loadRootIssueBodyMarkdown()
            : await params.loadRootIssueMarkdown();
        if ("error" in afterIssueBody) {
            params.notify(afterIssueBody.error, "error");
            return false;
        }

        if (afterIssueBody.content === beforeIssueBody.content) {
            unchangedFindings.push(finding);
            params.notify(`No root issue change detected after applying finding ${finding}.`, "warning");
        } else {
            changedFindings.push(finding);
        }
    }

    const summary = summarizeTaskApplyResults({
        changed: changedFindings,
        unchanged: unchangedFindings,
    });
    params.notify(summary.message, summary.level);
    return true;
}

function parseGitHubRepoFromRemoteUrl(remoteUrl: string): {owner: string; repo: string} | null {
    const trimmed = remoteUrl.trim();
    if (!trimmed) return null;

    const httpsMatch = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(trimmed);
    if (httpsMatch) {
        return {owner: httpsMatch[1], repo: httpsMatch[2]};
    }

    const sshMatch = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(trimmed);
    if (sshMatch) {
        return {owner: sshMatch[1], repo: sshMatch[2]};
    }

    const sshUrlMatch = /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(trimmed);
    if (sshUrlMatch) {
        return {owner: sshUrlMatch[1], repo: sshUrlMatch[2]};
    }

    return null;
}

export function parseOriginRemoteUrlFromJjGitRemoteListOutput(output: string): string | null {
    const normalized = output.trim();
    if (!normalized) {
        return null;
    }

    for (const line of normalized.split(/\r?\n/)) {
        const match = /^origin\s+(\S+)\s*$/.exec(line.trim());
        if (match) {
            return match[1];
        }
    }

    return null;
}

async function resolveGitHubClientConfig(
    pi: ExtensionAPI,
    root: string,
): Promise<{config: GitHubClientConfig} | {error: string}> {
    const cacheKey = path.resolve(root);
    const cached = githubConfigCache.get(cacheKey);
    if (cached) {
        return {config: cached};
    }

    const envRepo = (process.env.GITHUB_REPOSITORY ?? process.env.GH_REPO ?? "").trim();
    let owner = "";
    let repo = "";

    if (envRepo) {
        const envMatch = /^([^/]+)\/([^/]+)$/.exec(envRepo);
        if (!envMatch) {
            return {error: `Invalid repository override: ${envRepo}. Expected OWNER/REPO.`};
        }
        owner = envMatch[1];
        repo = envMatch[2];
    } else {
        let parsed: {owner: string; repo: string} | null = null;

        // Prefer jj as source of truth for remotes in this workflow.
        const jjRemotes = await pi.exec("jj", ["git", "remote", "list"], {cwd: root});
        if (jjRemotes.code === 0) {
            const originUrl = parseOriginRemoteUrlFromJjGitRemoteListOutput(jjRemotes.stdout);
            if (originUrl) {
                parsed = parseGitHubRepoFromRemoteUrl(originUrl);
            }
        }

        let gitRemoteStderr = "";
        if (!parsed) {
            const remote = await pi.exec("git", ["remote", "get-url", "origin"], {cwd: root});
            if (remote.code === 0) {
                parsed = parseGitHubRepoFromRemoteUrl(remote.stdout);
            } else {
                gitRemoteStderr = remote.stderr || "unknown error";
            }
        }

        if (!parsed) {
            const jjReason = jjRemotes.code !== 0
                ? `Failed to read jj remotes: ${jjRemotes.stderr || "unknown error"}`
                : "Failed to infer owner/repo from `jj git remote list` origin.";

            if (gitRemoteStderr) {
                return {
                    error: [
                        jjReason,
                        `Also failed to read git remote origin: ${gitRemoteStderr}`,
                        "Set GITHUB_REPOSITORY=OWNER/REPO.",
                    ].join(" "),
                };
            }

            return {
                error: `${jjReason} Unable to determine GitHub owner/repo from jj/git remotes. Set GITHUB_REPOSITORY=OWNER/REPO.`,
            };
        }

        owner = parsed.owner;
        repo = parsed.repo;
    }

    const envToken = (process.env.GITHUB_TOKEN ?? "").trim();
    let token = envToken;

    if (!token) {
        const ghToken = await pi.exec("gh", ["auth", "token"], {cwd: root});
        if (ghToken.code === 0) {
            const trimmed = ghToken.stdout.trim();
            if (trimmed) {
                token = trimmed;
            }
        }
    }

    if (!token) {
        try {
            const fileToken = fs.readFileSync(DEFAULT_GITHUB_TOKEN_PATH, "utf-8").trim();
            if (fileToken) {
                token = fileToken;
            }
        } catch {
            // Ignore read errors; handled by fallback checks below.
        }
    }

    if (!token) {
        return {
            error: [
                "Missing GitHub token.",
                "Set GITHUB_TOKEN, or create",
                `${DEFAULT_GITHUB_TOKEN_PATH}, or authenticate via 'gh auth login'.`,
            ].join(" "),
        };
    }

    const config = {
        owner,
        repo,
        token,
    };
    githubConfigCache.set(cacheKey, config);
    return {config};
}

function taskIssueSectionHeader(section: TaskIssueSection): string {
    return TASK_ISSUE_SECTION_HEADERS[section];
}

export function buildTaskBranchRevsetFromTaskHeadCommit(taskHeadCommitId: string): string {
    const commitId = taskHeadCommitId.trim();
    return `(::commit_id(${commitId}) ~ ::fork_point(commit_id(${commitId}) | @-)) & ~empty()`;
}

type TaskNode = {
    task_id: string;
    title: string;
    subtasks: TaskNode[];
};

type PendingEmptySubtaskCommit = {
    task_id: string;
    commit_message: string;
};

type PendingFixCommit = {
    commit_message: string;
    started_at: string;
};

type PendingPromptRun = {
    state: MachineWorkflowState;
    active_task_id: string;
    session_leaf_id: string;
    previous_assistant_id?: string | null;
    started_at: string;
};

export type ManualTestFollowupStatus = "open" | "in_progress" | "closed" | "unknown";

export type ManualTestFollowup = {
    issue_id: string;
    title: string;
    fingerprint: string;
    created_at: string;
    from_manual_test_version: number;
};

export type ManualTestFollowupWithStatus = ManualTestFollowup & {
    status: ManualTestFollowupStatus;
};

export type PersistedWorkflow = TaskNode & {
    schema_version: number;
    workflow_kind: WorkflowKind;
    manual_test_status?: ManualTestStatus;
    state: MachineWorkflowState;
    active_task_id: string;
    active_path_ids: string[];
    session_leaf_id: string;
    session_file_path?: string | null;
    last_consumed_assistant_id?: string | null;
    pending_prompt_run?: PendingPromptRun | null;
    pending_empty_subtask_commit?: PendingEmptySubtaskCommit | null;
    pending_fix_commit?: PendingFixCommit | null;
    pending_task_commit?: PendingFixCommit | null;
    manual_test_followups?: ManualTestFollowup[];
    version: number;
    updated_at: string;
    last_transition?: {
        event: string;
        from_state: MachineWorkflowState;
        to_state: MachineWorkflowState;
        from_active_task_id: string;
        to_active_task_id: string;
        at: string;
    };
};

type AvailableModel = ReturnType<ExtensionContext["modelRegistry"]["getAll"]>[number];

type AgentStartWaiter = {
    resolve: (started: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
};

let pendingAgentStart: AgentStartWaiter | null = null;
let activeTaskLoopCount = 0;

function isTaskLoopActive(): boolean {
    return activeTaskLoopCount > 0;
}

async function withTaskLoopGuard<T>(run: () => Promise<T>): Promise<T> {
    activeTaskLoopCount += 1;
    try {
        return await run();
    } finally {
        activeTaskLoopCount = Math.max(0, activeTaskLoopCount - 1);
    }
}

function resolveNextAgentStart(): void {
    if (!pendingAgentStart) return;
    const {resolve, timer} = pendingAgentStart;
    pendingAgentStart = null;
    clearTimeout(timer);
    resolve(true);
}

function waitForNextAgentStart(timeoutMs = DEFAULT_AGENT_START_TIMEOUT_MS): Promise<boolean> {
    if (pendingAgentStart) {
        throw new Error("Already waiting for agent_start");
    }
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            if (!pendingAgentStart) return;
            pendingAgentStart = null;
            resolve(false);
        }, timeoutMs);
        pendingAgentStart = {resolve, timer};
    });
}

function getWorkflowPath(root: string): string {
    return path.join(root, WORKFLOW_DIR_NAME, WORKFLOW_FILE_NAME);
}

function ensureWorkflowDirectory(root: string): void {
    fs.mkdirSync(path.join(root, WORKFLOW_DIR_NAME), {recursive: true});
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneTaskNode(node: TaskNode): TaskNode {
    return {
        task_id: node.task_id,
        title: node.title,
        subtasks: node.subtasks.map(cloneTaskNode),
    };
}

function cloneWorkflow(workflow: PersistedWorkflow): PersistedWorkflow {
    return {
        ...cloneTaskNode(workflow),
        schema_version: workflow.schema_version,
        workflow_kind: workflow.workflow_kind,
        manual_test_status: workflow.manual_test_status,
        state: workflow.state,
        active_task_id: workflow.active_task_id,
        active_path_ids: [...workflow.active_path_ids],
        session_leaf_id: workflow.session_leaf_id,
        session_file_path: workflow.session_file_path ?? null,
        last_consumed_assistant_id: workflow.last_consumed_assistant_id ?? null,
        pending_prompt_run: workflow.pending_prompt_run
            ? {...workflow.pending_prompt_run}
            : null,
        pending_empty_subtask_commit: workflow.pending_empty_subtask_commit
            ? {...workflow.pending_empty_subtask_commit}
            : null,
        pending_fix_commit: workflow.pending_fix_commit
            ? {...workflow.pending_fix_commit}
            : null,
        pending_task_commit: workflow.pending_task_commit
            ? {...workflow.pending_task_commit}
            : null,
        manual_test_followups: (workflow.manual_test_followups ?? []).map((followup) => ({...followup})),
        version: workflow.version,
        updated_at: workflow.updated_at,
        last_transition: workflow.last_transition ? {...workflow.last_transition} : undefined,
    };
}

function findNodeById(root: TaskNode, taskId: string): TaskNode | null {
    if (root.task_id === taskId) return root;
    for (const child of root.subtasks) {
        const found = findNodeById(child, taskId);
        if (found) return found;
    }
    return null;
}

function findParentById(root: TaskNode, taskId: string): TaskNode | null {
    for (const child of root.subtasks) {
        if (child.task_id === taskId) return root;
        const found = findParentById(child, taskId);
        if (found) return found;
    }
    return null;
}

function computePathToId(root: TaskNode, taskId: string): string[] | null {
    if (root.task_id === taskId) return [root.task_id];
    for (const child of root.subtasks) {
        const childPath = computePathToId(child, taskId);
        if (childPath) {
            return [root.task_id, ...childPath];
        }
    }
    return null;
}

function listChildren(node: TaskNode): TaskNode[] {
    return node.subtasks;
}

function nextSibling(root: TaskNode, taskId: string): TaskNode | null {
    const parent = findParentById(root, taskId);
    if (!parent) return null;
    const siblings = listChildren(parent);
    const index = siblings.findIndex((item) => item.task_id === taskId);
    if (index === -1) return null;
    return siblings[index + 1] ?? null;
}

function validateTaskTreeNode(
    node: TaskNode,
    depth: number,
    seen: Set<string>,
    maxDepth = 2,
): string | null {
    if (!node.task_id || typeof node.task_id !== "string") {
        return "workflow node is missing non-empty string task_id";
    }
    if (!node.title || typeof node.title !== "string") {
        return `workflow node ${node.task_id} is missing non-empty title`;
    }
    if (!Array.isArray(node.subtasks)) {
        return `workflow node ${node.task_id} has invalid subtasks`;
    }
    if (seen.has(node.task_id)) {
        return `duplicate task id in workflow tree: ${node.task_id}`;
    }
    seen.add(node.task_id);

    if (depth > maxDepth) {
        return `workflow tree depth exceeds ${maxDepth} at ${node.task_id}`;
    }

    for (const child of node.subtasks) {
        const err = validateTaskTreeNode(child, depth + 1, seen, maxDepth);
        if (err) return err;
    }

    return null;
}

function isWorkflowKind(value: unknown): value is WorkflowKind {
    return value === "task" || value === "fix";
}

function isManualTestStatus(value: unknown): value is ManualTestStatus {
    return value === "undecided" || value === "pending" || value === "passed";
}

function validateWorkflow(workflow: PersistedWorkflow): string | null {
    if (!Number.isInteger(workflow.schema_version)) {
        return "workflow.schema_version must be an integer";
    }
    if (workflow.schema_version !== WORKFLOW_SCHEMA_VERSION) {
        return `workflow schema mismatch (expected ${WORKFLOW_SCHEMA_VERSION}, found ${workflow.schema_version})`;
    }

    if (!isWorkflowKind(workflow.workflow_kind)) {
        return `workflow.workflow_kind is invalid: ${String(workflow.workflow_kind)}`;
    }

    if (workflow.workflow_kind === "fix") {
        if (!isManualTestStatus(workflow.manual_test_status)) {
            return `fix workflow.manual_test_status is invalid: ${String(workflow.manual_test_status)}`;
        }
    } else if (workflow.manual_test_status !== undefined) {
        return "task workflow must not contain manual_test_status";
    }

    if (workflow.workflow_kind === "fix") {
        if (workflow.state === "manual-test" && workflow.manual_test_status !== "pending") {
            return "fix manual-test requires manual_test_status pending";
        }
        if (workflow.manual_test_status === "passed" && workflow.state !== "commit" && workflow.state !== "complete") {
            return "fix manual_test_status passed is only valid in commit or complete";
        }
        if ((workflow.state === "commit" || workflow.state === "complete") && workflow.manual_test_status === "pending") {
            return "fix commit or complete cannot have manual_test_status pending";
        }
    }

    if (!Number.isInteger(workflow.version) || workflow.version < 1) {
        return "workflow.version must be an integer >= 1";
    }

    if (typeof workflow.session_leaf_id !== "string" || !workflow.session_leaf_id.trim()) {
        return "workflow.session_leaf_id must be a non-empty string";
    }

    if (
        workflow.session_file_path !== undefined
        && workflow.session_file_path !== null
        && (
            typeof workflow.session_file_path !== "string"
            || !workflow.session_file_path.trim()
        )
    ) {
        return "workflow.session_file_path must be null/undefined or a non-empty string";
    }

    if (
        workflow.last_consumed_assistant_id !== undefined
        && workflow.last_consumed_assistant_id !== null
        && (
            typeof workflow.last_consumed_assistant_id !== "string"
            || !workflow.last_consumed_assistant_id.trim()
        )
    ) {
        return "workflow.last_consumed_assistant_id must be null/undefined or a non-empty string";
    }

    if (
        workflow.pending_prompt_run !== undefined
        && workflow.pending_prompt_run !== null
        && (
            !isObject(workflow.pending_prompt_run)
            || !isWorkflowState(String(workflow.pending_prompt_run.state))
            || typeof workflow.pending_prompt_run.active_task_id !== "string"
            || !workflow.pending_prompt_run.active_task_id.trim()
            || typeof workflow.pending_prompt_run.session_leaf_id !== "string"
            || !workflow.pending_prompt_run.session_leaf_id.trim()
            || (
                workflow.pending_prompt_run.previous_assistant_id !== undefined
                && workflow.pending_prompt_run.previous_assistant_id !== null
                && (
                    typeof workflow.pending_prompt_run.previous_assistant_id !== "string"
                    || !workflow.pending_prompt_run.previous_assistant_id.trim()
                )
            )
            || typeof workflow.pending_prompt_run.started_at !== "string"
            || !workflow.pending_prompt_run.started_at.trim()
        )
    ) {
        return "workflow.pending_prompt_run must be null/undefined or {state, active_task_id, session_leaf_id, previous_assistant_id?, started_at}";
    }

    if (
        workflow.pending_empty_subtask_commit !== undefined
        && workflow.pending_empty_subtask_commit !== null
        && (
            !isObject(workflow.pending_empty_subtask_commit)
            || typeof workflow.pending_empty_subtask_commit.task_id !== "string"
            || !workflow.pending_empty_subtask_commit.task_id.trim()
            || typeof workflow.pending_empty_subtask_commit.commit_message !== "string"
            || !workflow.pending_empty_subtask_commit.commit_message.trim()
        )
    ) {
        return "workflow.pending_empty_subtask_commit must be null/undefined or {task_id, commit_message}";
    }

    if (
        workflow.pending_task_commit !== undefined
        && workflow.pending_task_commit !== null
        && (
            workflow.workflow_kind !== "task"
            || !isObject(workflow.pending_task_commit)
            || typeof workflow.pending_task_commit.commit_message !== "string"
            || !workflow.pending_task_commit.commit_message.trim()
            || typeof workflow.pending_task_commit.started_at !== "string"
            || !workflow.pending_task_commit.started_at.trim()
        )
    ) {
        return "workflow.pending_task_commit must be null/undefined or task {commit_message, started_at}";
    }

    if (
        workflow.pending_fix_commit !== undefined
        && workflow.pending_fix_commit !== null
        && (
            workflow.workflow_kind !== "fix"
            || !isObject(workflow.pending_fix_commit)
            || typeof workflow.pending_fix_commit.commit_message !== "string"
            || !workflow.pending_fix_commit.commit_message.trim()
            || typeof workflow.pending_fix_commit.started_at !== "string"
            || !workflow.pending_fix_commit.started_at.trim()
        )
    ) {
        return "workflow.pending_fix_commit must be null/undefined or fix {commit_message, started_at}";
    }

    if (workflow.manual_test_followups !== undefined) {
        if (!Array.isArray(workflow.manual_test_followups)) {
            return "workflow.manual_test_followups must be undefined or an array";
        }
        const seenFollowupIssueIds = new Set<string>();
        for (const followup of workflow.manual_test_followups) {
            if (
                !isObject(followup)
                || typeof followup.issue_id !== "string"
                || !followup.issue_id.trim()
                || typeof followup.title !== "string"
                || !followup.title.trim()
                || typeof followup.fingerprint !== "string"
                || !followup.fingerprint.trim()
                || typeof followup.created_at !== "string"
                || !followup.created_at.trim()
                || !Number.isInteger(followup.from_manual_test_version)
                || followup.from_manual_test_version < 1
            ) {
                return "workflow.manual_test_followups entries must contain issue_id, title, fingerprint, created_at, and from_manual_test_version";
            }
            if (seenFollowupIssueIds.has(followup.issue_id)) {
                return `duplicate manual_test_followups issue_id: ${followup.issue_id}`;
            }
            seenFollowupIssueIds.add(followup.issue_id);
        }
    }

    if (!isWorkflowState(workflow.state)) {
        return `workflow.state is invalid: ${String(workflow.state)}`;
    }

    const treeError = validateTaskTreeNode(workflow, 0, new Set<string>(), workflow.workflow_kind === "fix" ? 1 : 2);
    if (treeError) return treeError;

    const activeNode = findNodeById(workflow, workflow.active_task_id);
    if (!activeNode) {
        return `workflow.active_task_id not found in tree: ${workflow.active_task_id}`;
    }

    const expectedPath = computePathToId(workflow, workflow.active_task_id);
    if (!expectedPath) {
        return `failed computing path to active task: ${workflow.active_task_id}`;
    }

    if (workflow.active_path_ids.length !== expectedPath.length) {
        return `workflow.active_path_ids length mismatch for active task ${workflow.active_task_id}`;
    }

    for (let i = 0; i < expectedPath.length; i++) {
        if (workflow.active_path_ids[i] !== expectedPath[i]) {
            return `workflow.active_path_ids does not match root→active path for ${workflow.active_task_id}`;
        }
    }

    const activeDepth = workflow.active_path_ids.length - 1;
    if (!stateAllowsActiveDepthForKindMachine(workflow.workflow_kind, workflow.state, activeDepth)) {
        return workflow.workflow_kind === "fix"
            ? `state ${workflow.state} is not valid for fix workflow at active depth ${activeDepth}`
            : `state ${workflow.state} is incompatible with active depth ${activeDepth}`;
    }

    return null;
}

export function createInitialWorkflow(
    workflowKind: WorkflowKind,
    rootTaskId: string,
    rootTitle: string,
    sessionLeafId: string,
): PersistedWorkflow {
    const normalizedTitle = rootTitle.trim() || rootTaskId;
    const now = new Date().toISOString();
    const initialState: MachineWorkflowState = workflowKind === "fix" ? "implement" : "refine";
    return {
        schema_version: WORKFLOW_SCHEMA_VERSION,
        workflow_kind: workflowKind,
        ...(workflowKind === "fix" ? {manual_test_status: "undecided" as const} : {}),
        task_id: rootTaskId,
        title: normalizedTitle,
        subtasks: [],
        state: initialState,
        active_task_id: rootTaskId,
        active_path_ids: [rootTaskId],
        session_leaf_id: sessionLeafId,
        session_file_path: null,
        last_consumed_assistant_id: null,
        pending_prompt_run: null,
        pending_empty_subtask_commit: null,
        pending_fix_commit: null,
        pending_task_commit: null,
        manual_test_followups: [],
        version: 1,
        updated_at: now,
        last_transition: {
            event: "initialize",
            from_state: initialState,
            to_state: initialState,
            from_active_task_id: rootTaskId,
            to_active_task_id: rootTaskId,
            at: now,
        },
    };
}

function migrateWorkflowData(parsed: Record<string, unknown>): Record<string, unknown> | {error: string} {
    const schemaVersion = parsed.schema_version;
    if (schemaVersion === 1) {
        return {
            ...parsed,
            schema_version: WORKFLOW_SCHEMA_VERSION,
            workflow_kind: "task",
        };
    }
    if (schemaVersion === WORKFLOW_SCHEMA_VERSION) {
        return parsed;
    }
    return {error: `workflow schema mismatch (expected ${WORKFLOW_SCHEMA_VERSION}, found ${String(schemaVersion)})`};
}

function loadWorkflow(root: string): {workflow: PersistedWorkflow} | {error: string} {
    const workflowPath = getWorkflowPath(root);
    if (!fs.existsSync(workflowPath)) {
        return {
            error: `Missing workflow file: ${workflowPath}. Manual cleanup required: create a valid .tasks/workflow.json before running the matching /task or /fix command.`,
        };
    }

    let raw: string;
    try {
        raw = fs.readFileSync(workflowPath, "utf-8");
    } catch (error) {
        return {
            error: `Failed to read workflow file ${workflowPath}: ${error}. Manual cleanup required.`,
        };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        return {
            error: `Invalid JSON in ${workflowPath}: ${error}. Manual cleanup required.`,
        };
    }

    if (!isObject(parsed)) {
        return {
            error: `Invalid workflow schema in ${workflowPath}: root must be an object. Manual cleanup required.`,
        };
    }

    const migrated = migrateWorkflowData(parsed);
    if ("error" in migrated) {
        return {
            error: `Invalid workflow schema/invariants in ${workflowPath}: ${migrated.error}. Manual cleanup required.`,
        };
    }

    const workflow = migrated as PersistedWorkflow;
    const validationError = validateWorkflow(workflow);
    if (validationError) {
        return {
            error: `Invalid workflow schema/invariants in ${workflowPath}: ${validationError}. Manual cleanup required.`,
        };
    }

    if (parsed.schema_version === 1) {
        const saved = saveWorkflowAtomic(root, workflow);
        if (saved.ok === false) {
            return {error: `Failed to save migrated workflow: ${saved.error}`};
        }
    }

    return {workflow};
}

export function loadWorkflowForTest(root: string): {workflow: PersistedWorkflow} | {error: string} {
    return loadWorkflow(root);
}

export function validateWorkflowForTest(workflow: PersistedWorkflow): string | null {
    return validateWorkflow(workflow);
}

export function stateAllowsActiveDepthForKind(
    workflowKind: WorkflowKind,
    state: MachineWorkflowState,
    depth: number,
): boolean {
    return stateAllowsActiveDepthForKindMachine(workflowKind, state, depth);
}

function saveWorkflowAtomic(root: string, workflow: PersistedWorkflow): {ok: true} | {ok: false; error: string} {
    const validationError = validateWorkflow(workflow);
    if (validationError) {
        return {ok: false, error: `Refusing to save invalid workflow: ${validationError}`};
    }

    ensureWorkflowDirectory(root);

    const targetPath = getWorkflowPath(root);
    const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;

    try {
        const payload = `${JSON.stringify(workflow, null, 2)}\n`;
        fs.writeFileSync(tempPath, payload, "utf-8");
        fs.renameSync(tempPath, targetPath);
        return {ok: true};
    } catch (error) {
        try {
            if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
            }
        } catch {
            // Ignore cleanup failures.
        }
        return {ok: false, error: `Failed to save workflow atomically: ${error}`};
    }
}

type WorkflowIssueStatus = "open" | "in_progress" | "closed";

type WorkflowIssueSummary = {
    id: string;
    status: WorkflowIssueStatus;
    title: string;
    created: string;
    parent: string | null;
};

function toWorkflowIssueStatus(issue: Pick<GitHubIssueSummary, "state" | "labels">): WorkflowIssueStatus {
    if (issue.state === "CLOSED") return "closed";
    if (issue.labels.includes(IN_PROGRESS_LABEL)) return "in_progress";
    return "open";
}

function toWorkflowIssueSummary(issue: GitHubIssueSummary): WorkflowIssueSummary {
    return {
        id: String(issue.number),
        status: toWorkflowIssueStatus(issue),
        title: issue.title,
        created: issue.createdAt,
        parent: issue.parent ? String(issue.parent.number) : null,
    };
}

function toManualTestFollowupStatus(issue: Pick<GitHubIssueSummary, "state" | "labels">): ManualTestFollowupStatus {
    return toWorkflowIssueStatus(issue);
}

export function fingerprintManualTestFollowup(title: string): string {
    const normalized = title
        .trim()
        .toLowerCase()
        .replace(/[`'"“”‘’]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return normalized || "manual-test-followup";
}

export function recordManualTestFollowups(params: {
    existing?: ManualTestFollowup[] | null;
    createdIssues: Array<{issue_id: string; title: string}>;
    createdAt: string;
    fromManualTestVersion: number;
}): ManualTestFollowup[] {
    const next = (params.existing ?? []).map((followup) => ({...followup}));
    const seenIssueIds = new Set(next.map((followup) => followup.issue_id));

    for (const created of params.createdIssues) {
        const issueId = created.issue_id.trim();
        const title = created.title.trim();
        if (!issueId || !title) {
            continue;
        }
        const fingerprint = fingerprintManualTestFollowup(title);
        if (seenIssueIds.has(issueId)) {
            continue;
        }
        next.push({
            issue_id: issueId,
            title,
            fingerprint,
            created_at: params.createdAt,
            from_manual_test_version: params.fromManualTestVersion,
        });
        seenIssueIds.add(issueId);
    }

    return next;
}

function formatManualTestFollowupStatus(status: ManualTestFollowupStatus): string {
    return status.toUpperCase().replace(/_/g, "-");
}

export function buildManualTestFollowupPromptContext(followups: ManualTestFollowupWithStatus[]): string {
    if (followups.length === 0) {
        return "";
    }

    const lines = [
        "## Previous Manual-Test Follow-ups",
        "",
        ...followups.map((followup) => (
            `- #${followup.issue_id} ${formatManualTestFollowupStatus(followup.status)}: ${followup.title}`
        )),
        "",
    ];

    const hasOpen = followups.some((followup) => followup.status === "open" || followup.status === "in_progress" || followup.status === "unknown");
    const hasClosed = followups.some((followup) => followup.status === "closed");

    if (hasClosed) {
        lines.push(
            "Closed follow-ups indicate prior manual-test failures that already spawned implementation work.",
            "Treat their original failures as historical. Ask the user to rerun manual verification before creating any new follow-up work.",
        );
    }

    if (hasOpen) {
        lines.push(
            "Open or unknown-status follow-ups are already tracking manual-test failures.",
            "Do not create duplicate manual-test follow-ups for the same observed failure.",
        );
    }

    return `${lines.join("\n")}\n`;
}

async function resolveManualTestFollowupsWithStatus(
    pi: ExtensionAPI,
    root: string,
    followups: ManualTestFollowup[],
): Promise<ManualTestFollowupWithStatus[]> {
    if (followups.length === 0) {
        return [];
    }

    const configResult = await resolveGitHubClientConfig(pi, root);
    if ("error" in configResult) {
        return followups.map((followup) => ({...followup, status: "unknown"}));
    }

    const resolved: ManualTestFollowupWithStatus[] = [];
    for (const followup of followups) {
        const issueNumber = parseIssueNumberFromTaskId(followup.issue_id);
        if (!issueNumber) {
            resolved.push({...followup, status: "unknown"});
            continue;
        }

        try {
            const issue = await getIssueByNumber(configResult.config, issueNumber);
            resolved.push({
                ...followup,
                status: issue ? toManualTestFollowupStatus(issue) : "unknown",
            });
        } catch {
            resolved.push({...followup, status: "unknown"});
        }
    }

    return resolved;
}

async function buildManualTestFollowupContextMarkdown(
    pi: ExtensionAPI,
    root: string,
    workflow: PersistedWorkflow,
): Promise<string> {
    if (workflow.state !== "manual-test") {
        return "";
    }

    const resolved = await resolveManualTestFollowupsWithStatus(pi, root, workflow.manual_test_followups ?? []);
    return buildManualTestFollowupPromptContext(resolved);
}

async function listWorkflowIssueSummaries(
    pi: ExtensionAPI,
    cwd: string,
): Promise<{items: WorkflowIssueSummary[]} | {error: string}> {
    const configResult = await resolveGitHubClientConfig(pi, cwd);
    if ("error" in configResult) {
        return {error: configResult.error};
    }

    try {
        const issues = await listOpenRootIssues(configResult.config, {
            orderDirection: "ASC",
        });
        return {items: issues.map((issue) => toWorkflowIssueSummary(issue))};
    } catch (error) {
        return {error: `GitHub query failed: ${error}`};
    }
}

async function findChildIssueByParentAndTitle(
    pi: ExtensionAPI,
    cwd: string,
    parentTaskId: string,
    title: string,
): Promise<{item: WorkflowIssueSummary | null} | {error: string}> {
    const parentNumber = parseIssueNumberFromTaskId(parentTaskId);
    if (!parentNumber) {
        return {item: null};
    }

    const configResult = await resolveGitHubClientConfig(pi, cwd);
    if ("error" in configResult) {
        return {error: configResult.error};
    }

    try {
        const parentIssue = await getIssueByNumber(configResult.config, parentNumber);
        if (!parentIssue) {
            return {item: null};
        }

        const child = await findChildIssueByExactTitle(configResult.config, {
            parentIssueId: parentIssue.id,
            title,
        });

        return {item: child ? toWorkflowIssueSummary(child) : null};
    } catch (error) {
        return {error: `GitHub query failed: ${error}`};
    }
}

async function createChildIssue(
    pi: ExtensionAPI,
    cwd: string,
    title: string,
    description: string,
    tdd: boolean,
    parentId: string,
): Promise<{id: string} | {error: string}> {
    const parentNumber = parseIssueNumberFromTaskId(parentId);
    if (!parentNumber) {
        return {error: `Invalid parent issue id: ${parentId}`};
    }

    const configResult = await resolveGitHubClientConfig(pi, cwd);
    if ("error" in configResult) {
        return {error: configResult.error};
    }

    try {
        const parent = await getIssueByNumber(configResult.config, parentNumber);
        if (!parent) {
            return {error: `Parent issue #${parentNumber} not found`};
        }

        const created = await createIssueWithParent(configResult.config, {
            parentIssueId: parent.id,
            title,
            body: formatCreatedChildIssueBody(description, tdd),
        });

        return {id: String(created.number)};
    } catch (error) {
        if (error instanceof GitHubSubIssueLinkError) {
            const created = error.createdIssue;
            const createdUrl = `https://github.com/${configResult.config.owner}/${configResult.config.repo}/issues/${created.number}`;
            return {
                error: [
                    `Created child issue #${created.number} but failed to link it to parent #${parentNumber}.`,
                    `Created issue URL: ${createdUrl}`,
                    `Created issue node id: ${created.id}`,
                    `Parent issue node id: ${error.parentIssueId}`,
                    "Manual cleanup: either link this created issue as a sub-issue of the parent, or close/delete it before retrying /task.",
                    `GitHub error: ${error.message}`,
                ].join(" "),
            };
        }

        return {error: `Failed to create child issue ${title}: ${error}`};
    }
}

export function issueNeedsClose(state: "OPEN" | "CLOSED"): boolean {
    return state !== "CLOSED";
}

async function closeWorkflowIssue(
    pi: ExtensionAPI,
    cwd: string,
    taskId: string,
): Promise<{ok: true} | {ok: false; error: string}> {
    const issueNumber = parseIssueNumberFromTaskId(taskId);
    if (!issueNumber) {
        return {ok: false, error: `Invalid issue id: ${taskId}`};
    }

    const configResult = await resolveGitHubClientConfig(pi, cwd);
    if ("error" in configResult) {
        return {ok: false, error: configResult.error};
    }

    try {
        const issue = await getIssueByNumber(configResult.config, issueNumber);
        if (!issue) {
            return {ok: false, error: `Issue #${issueNumber} not found`};
        }
        if (!issueNeedsClose(issue.state)) {
            return {ok: true};
        }
        // The status:in-progress label is left in place when closing; GitHub's CLOSED
        // state is treated as the authoritative workflow status.
        await closeGitHubIssue(configResult.config, issue.id);
        return {ok: true};
    } catch (error) {
        return {ok: false, error: `Failed to close issue #${issueNumber}: ${error}`};
    }
}

async function markWorkflowIssueInProgress(
    pi: ExtensionAPI,
    cwd: string,
    taskId: string,
): Promise<{ok: true} | {ok: false; error: string}> {
    const issueNumber = parseIssueNumberFromTaskId(taskId);
    if (!issueNumber) {
        return {ok: false, error: `Invalid issue id: ${taskId}`};
    }

    const configResult = await resolveGitHubClientConfig(pi, cwd);
    if ("error" in configResult) {
        return {ok: false, error: configResult.error};
    }

    try {
        const issue = await getIssueByNumber(configResult.config, issueNumber);
        if (!issue) {
            return {ok: false, error: `Issue #${issueNumber} not found`};
        }
        await markIssueInProgressWithLabel(configResult.config, issue.id, IN_PROGRESS_LABEL);
        return {ok: true};
    } catch (error) {
        return {ok: false, error: `Failed to mark issue #${issueNumber} in progress: ${error}`};
    }
}

const TDD_FALSE_MARKER = "<!-- tdd: false -->";

export function formatCreatedChildIssueBody(description: string, tdd: boolean): string {
    return formatReusedChildIssueBody(description, description, tdd);
}

export function formatReusedChildIssueBody(existingBody: string, description: string, tdd: boolean): string {
    const bodyWithoutMarker = existingBody.split(TDD_FALSE_MARKER).join("").trim();
    const firstSection = bodyWithoutMarker.search(/^## /m);
    const sections = firstSection >= 0 ? bodyWithoutMarker.slice(firstSection).trim() : "";
    const body = [description.trim(), sections].filter(Boolean).join("\n\n");
    if (tdd) {
        return body;
    }
    return body ? `${body}\n\n${TDD_FALSE_MARKER}` : TDD_FALSE_MARKER;
}

export function formatWorkflowIssueBodyMarkdown(issue: {
    title: string;
    body: string;
}): string {
    const parts = [`# ${issue.title}`];
    const body = issue.body.trim();
    if (body) {
        parts.push("", body);
    }
    return `${parts.join("\n")}\n`;
}

export function formatWorkflowIssueMarkdown(issue: {
    title: string;
    body: string;
    comments?: Array<{body: string; authorLogin: string | null}>;
    commentsTruncated?: boolean;
}): string {
    const parts = [formatWorkflowIssueBodyMarkdown(issue).trimEnd()];

    for (const comment of issue.comments ?? []) {
        const commentBody = comment.body.trim();
        if (!commentBody) {
            continue;
        }

        const author = (comment.authorLogin?.trim() || "unknown author").replace(/\s+/g, " ");
        parts.push("", `## Comment from ${author}`, "", commentBody);
    }

    if (issue.commentsTruncated) {
        parts.push("", "## Comments truncated", "", "Additional GitHub comments were not loaded into this context.");
    }

    return `${parts.join("\n")}\n`;
}

async function loadWorkflowIssueMarkdown(
    pi: ExtensionAPI,
    cwd: string,
    taskId: string,
    includeComments: boolean,
): Promise<{content: string} | {error: string}> {
    const issueNumber = parseIssueNumberFromTaskId(taskId);
    if (!issueNumber) {
        return {error: `Invalid issue id: ${taskId}`};
    }

    const configResult = await resolveGitHubClientConfig(pi, cwd);
    if ("error" in configResult) {
        return {error: configResult.error};
    }

    try {
        const issue = await getIssueByNumber(configResult.config, issueNumber, {commentsFirst: 100});
        if (!issue) {
            return {error: `Issue #${issueNumber} not found`};
        }

        return {content: includeComments ? formatWorkflowIssueMarkdown(issue) : formatWorkflowIssueBodyMarkdown(issue)};
    } catch (error) {
        return {error: `Failed to show issue #${issueNumber}: ${error}`};
    }
}

async function addIssueCommentBestEffort(
    pi: ExtensionAPI,
    cwd: string,
    taskId: string,
    note: string,
): Promise<void> {
    const issueNumber = parseIssueNumberFromTaskId(taskId);
    if (!issueNumber) return;

    const configResult = await resolveGitHubClientConfig(pi, cwd);
    if ("error" in configResult) return;

    try {
        const issue = await getIssueByNumber(configResult.config, issueNumber);
        if (!issue) return;
        await addIssueComment(configResult.config, issue.id, note);
    } catch {
        // Best-effort only.
    }
}

/**
 * Shell helper: capture the newest assistant turn text (with debug diagnostics).
 */
function captureAssistantTurnMessage(
    ctx: ExtensionContext,
    previousAssistantId: string | null,
): {assistantMessage: string; assistantMessageId: string | null} | {error: string} {
    const latest = getLastAssistantMessage(ctx);
    if (!latest) {
        if (ENABLE_TRANSITION_DEBUG) {
            ctx.ui.notify(
                `transition-capture: previous=${previousAssistantId ?? "(none)"} latest=(none)`,
                "warning",
            );
        }
        return {error: "No assistant message found after task prompt."};
    }

    if (previousAssistantId && latest.id === previousAssistantId) {
        if (ENABLE_TRANSITION_DEBUG) {
            ctx.ui.notify(
                `transition-capture: previous=${previousAssistantId} latest=${latest.id ?? "(none)"} (unchanged)`,
                "warning",
            );
        }
        return {error: "No new assistant message was recorded after task prompt."};
    }

    const messageText = latest.text;

    if (ENABLE_TRANSITION_DEBUG) {
        const preview = messageText.replace(/\s+/g, " ").slice(0, 180);
        ctx.ui.notify(
            `transition-capture: previous=${previousAssistantId ?? "(none)"} latest=${latest.id ?? "(none)"}`,
            "info",
        );
        ctx.ui.notify(`transition-capture: assistant-preview: ${preview}`, "info");
    }

    return {assistantMessage: messageText, assistantMessageId: latest.id};
}

function persistConsumedAssistantMessageId(
    root: string,
    workflow: PersistedWorkflow,
    assistantMessageId: string | null,
): {workflow: PersistedWorkflow} | {error: string} {
    if (!assistantMessageId || !assistantMessageId.trim()) {
        return {workflow};
    }

    if (workflow.last_consumed_assistant_id === assistantMessageId) {
        return {workflow};
    }

    const updated = cloneWorkflow(workflow);
    updated.last_consumed_assistant_id = assistantMessageId;
    updated.updated_at = new Date().toISOString();

    const saved = saveWorkflowAtomic(root, updated);
    if (saved.ok === false) {
        return {error: saved.error};
    }

    return {workflow: updated};
}

function pendingPromptRunsEqual(a: PendingPromptRun | null | undefined, b: PendingPromptRun | null | undefined): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.state === b.state
        && a.active_task_id === b.active_task_id
        && a.session_leaf_id === b.session_leaf_id
        && (a.previous_assistant_id ?? null) === (b.previous_assistant_id ?? null)
        && a.started_at === b.started_at;
}

function persistPendingPromptRun(
    root: string,
    workflow: PersistedWorkflow,
    pendingPromptRun: PendingPromptRun | null,
): {workflow: PersistedWorkflow} | {error: string} {
    const normalized = pendingPromptRun
        ? {
            ...pendingPromptRun,
            previous_assistant_id: pendingPromptRun.previous_assistant_id ?? null,
        }
        : null;

    if (pendingPromptRunsEqual(workflow.pending_prompt_run ?? null, normalized)) {
        return {workflow};
    }

    const updated = cloneWorkflow(workflow);
    updated.pending_prompt_run = normalized;
    updated.updated_at = new Date().toISOString();

    const saved = saveWorkflowAtomic(root, updated);
    if (saved.ok === false) {
        return {error: saved.error};
    }

    return {workflow: updated};
}

function persistSessionFilePath(
    root: string,
    workflow: PersistedWorkflow,
    sessionFilePath: string | undefined,
): {workflow: PersistedWorkflow} | {error: string} {
    const normalized = normalizeSessionFilePath(sessionFilePath);
    if ((workflow.session_file_path ?? null) === normalized) {
        return {workflow};
    }

    const updated = cloneWorkflow(workflow);
    updated.session_file_path = normalized;
    updated.updated_at = new Date().toISOString();

    const saved = saveWorkflowAtomic(root, updated);
    if (saved.ok === false) {
        return {error: saved.error};
    }

    return {workflow: updated};
}

async function replayPendingAssistantTransition(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    root: string,
    workflow: PersistedWorkflow,
): Promise<{changed: boolean; workflow: PersistedWorkflow} | {error: string}> {
    const pendingCandidate = findPendingPromptRunCompletionCandidate({
        branch: ctx.sessionManager.getBranch(),
        pendingPromptRun: workflow.pending_prompt_run ?? null,
        workflowState: workflow.state,
        activeTaskId: workflow.active_task_id,
        sessionLeafId: workflow.session_leaf_id,
        lastConsumedAssistantId: workflow.last_consumed_assistant_id ?? null,
    });

    let assistantMessageId: string | null = pendingCandidate?.assistantMessageId ?? null;
    let assistantMessage = pendingCandidate?.assistantMessage ?? null;
    const replayingAfterErrors = pendingCandidate?.hadErrors === true;

    if (!assistantMessageId || assistantMessage === null) {
        const latest = getLastAssistantMessage(ctx);
        if (!latest || !latest.id) {
            return {changed: false, workflow};
        }

        if (workflow.last_consumed_assistant_id === latest.id) {
            return {changed: false, workflow};
        }

        if (!canReplayCompleteFromAssistantMessage(workflow.workflow_kind, workflow.state, latest.text)) {
            return {changed: false, workflow};
        }

        assistantMessageId = latest.id;
        assistantMessage = latest.text;
    }

    if (replayingAfterErrors) {
        ctx.ui.notify(replayAfterErrorsNotice(workflow.workflow_kind), "warning");
    }

    if (ENABLE_TRANSITION_DEBUG) {
        const preview = assistantMessage.replace(/\s+/g, " ").slice(0, 180);
        ctx.ui.notify(
            `transition-replay: attempting COMPLETE from assistant ${assistantMessageId} in state ${workflow.state}`,
            "info",
        );
        ctx.ui.notify(`transition-replay: assistant-preview: ${preview}`, "info");
    }

    const transition = await dispatchWorkflowEvent(
        pi,
        ctx,
        root,
        workflow,
        {
            type: "COMPLETE",
            completedState: workflow.state,
            assistantMessage,
            rootIssueMarkdown: "",
        },
    );

    if ("error" in transition) {
        return {error: transition.error};
    }

    const consumed = persistConsumedAssistantMessageId(root, transition.workflow, assistantMessageId);
    if ("error" in consumed) {
        return {error: consumed.error};
    }

    const clearedPending = persistPendingPromptRun(root, consumed.workflow, null);
    if ("error" in clearedPending) {
        return {error: clearedPending.error};
    }

    const completionNotice = completionReadyToMergeNotice({
        changed: transition.changed,
        nextState: clearedPending.workflow.state,
        workflowKind: clearedPending.workflow.workflow_kind,
    });
    if (completionNotice) {
        ctx.ui.notify(completionNotice, "info");
    }

    if (ENABLE_TRANSITION_DEBUG) {
        ctx.ui.notify(
            `transition-replay: result changed=${transition.changed ? "yes" : "no"}`,
            "info",
        );
    }

    return {
        changed: transition.changed,
        workflow: clearedPending.workflow,
    };
}

function buildTransitionedWorkflow(
    workflow: PersistedWorkflow,
    params: {
        toState: MachineWorkflowState;
        manualTestStatus?: ManualTestStatus;
        activeTaskId?: string;
        event: string;
        mutateTree?: (draft: PersistedWorkflow) => void;
    },
): {workflow: PersistedWorkflow} | {error: string} {
    const draft = cloneWorkflow(workflow);

    if (params.mutateTree) {
        try {
            params.mutateTree(draft);
        } catch (error) {
            return {error: `Failed to apply tree mutation: ${error}`};
        }
    }

    const nextActiveTaskId = params.activeTaskId ?? draft.active_task_id;
    const nextPath = computePathToId(draft, nextActiveTaskId);
    if (!nextPath) {
        return {error: `Transition produced invalid active task id: ${nextActiveTaskId}`};
    }

    draft.state = params.toState;
    if (draft.workflow_kind === "fix" && params.manualTestStatus) {
        draft.manual_test_status = params.manualTestStatus;
    }
    draft.active_task_id = nextActiveTaskId;
    draft.active_path_ids = nextPath;
    draft.pending_empty_subtask_commit = null;
    if (params.toState === "complete") {
        if (draft.workflow_kind === "fix") draft.pending_fix_commit = null;
        else draft.pending_task_commit = null;
    }
    draft.version = workflow.version + 1;
    draft.updated_at = new Date().toISOString();
    draft.last_transition = {
        event: params.event,
        from_state: workflow.state,
        to_state: draft.state,
        from_active_task_id: workflow.active_task_id,
        to_active_task_id: draft.active_task_id,
        at: draft.updated_at,
    };

    const error = validateWorkflow(draft);
    if (error) {
        return {error: `Transition violates workflow invariants: ${error}`};
    }

    return {workflow: draft};
}

async function reconcileReusedChildIssueBody(
    pi: ExtensionAPI,
    root: string,
    childTaskId: string,
    description: string,
    tdd: boolean,
): Promise<{ok: true} | {error: string}> {
    const issueNumber = parseIssueNumberFromTaskId(childTaskId);
    if (!issueNumber) {
        return {error: `Invalid child issue id: ${childTaskId}`};
    }

    const configResult = await resolveGitHubClientConfig(pi, root);
    if ("error" in configResult) {
        return {error: configResult.error};
    }

    try {
        const issue = await getIssueByNumber(configResult.config, issueNumber);
        if (!issue) {
            return {error: `Issue #${issueNumber} not found`};
        }

        const nextBody = formatReusedChildIssueBody(issue.body, description, tdd);
        if (nextBody !== issue.body) {
            await updateIssueBody(configResult.config, issue.id, nextBody);
        }
        return {ok: true};
    } catch (error) {
        return {error: `Failed to update reused child issue #${issueNumber}: ${error}`};
    }
}

export function resolveChildLookupForCreateOrReuse(
    existingResult: {item: {id: string} | null} | {error: string},
): {id: string} | {create: true} | {error: string} {
    if ("error" in existingResult) {
        return {error: existingResult.error};
    }
    if (existingResult.item) {
        return {id: existingResult.item.id};
    }
    return {create: true};
}

async function createOrReuseChildTask(
    pi: ExtensionAPI,
    root: string,
    parentId: string,
    title: string,
    description: string,
    tdd: boolean,
): Promise<{id: string} | {error: string}> {
    const existingResult = await findChildIssueByParentAndTitle(pi, root, parentId, title);
    const existingDecision = resolveChildLookupForCreateOrReuse(existingResult);
    if ("error" in existingDecision) {
        return {error: existingDecision.error};
    }
    if ("id" in existingDecision) {
        const marked = await reconcileReusedChildIssueBody(pi, root, existingDecision.id, description, tdd);
        if ("error" in marked) {
            return {error: marked.error};
        }
        return {id: existingDecision.id};
    }

    const created = await createChildIssue(pi, root, title, description, tdd, parentId);
    if ("error" in created) {
        return {error: `Failed to create child task \"${title}\": ${created.error}`};
    }

    return {id: created.id};
}

async function workingCopyHasChanges(
    pi: ExtensionAPI,
    root: string,
): Promise<{hasChanges: boolean} | {error: string}> {
    const diff = await pi.exec("jj", ["diff", "--git", "--color=never"], {cwd: root});
    if (diff.code !== 0) {
        return {error: `Failed to check working copy diff: ${diff.stderr}`};
    }

    return {hasChanges: diff.stdout.trim().length > 0};
}

export function fixCommitPreflightAction(params: {
    hasChanges: boolean;
    requestedMessage: string;
    pendingMessage: string | null;
    parentMessage: string | null;
}): "commit" | "already-committed" | "block" {
    if (params.hasChanges) return "commit";
    const normalize = (value: string | null) => value?.replace(/\r\n?/g, "\n").trim() ?? null;
    const requested = normalize(params.requestedMessage);
    if (
        requested
        && normalize(params.pendingMessage) === requested
        && normalize(params.parentMessage) === requested
    ) {
        return "already-committed";
    }
    return "block";
}

export function finalCommitActionForWorkingCopy(
    workflowKind: WorkflowKind,
    hasChanges: boolean,
): "commit" | "describe-parent" | "block" {
    if (hasChanges) return "commit";
    return workflowKind === "fix" ? "block" : "describe-parent";
}

async function runJjCommitWithCleanCheck(
    pi: ExtensionAPI,
    root: string,
    commitMessage: string,
): Promise<{ok: true} | {ok: false; error: string}> {
    const before = await workingCopyHasChanges(pi, root);
    if ("error" in before) {
        return {ok: false, error: before.error};
    }
    if (!before.hasChanges) {
        return {ok: false, error: "Working copy has no changes to commit."};
    }

    const commit = await pi.exec("jj", ["commit", "-m", commitMessage], {cwd: root});
    if (commit.code !== 0) {
        return {ok: false, error: `jj commit failed: ${commit.stderr}`};
    }

    const diffAfter = await pi.exec("jj", ["diff", "--git", "--color=never"], {cwd: root});
    if (diffAfter.code !== 0) {
        return {ok: false, error: `Failed to check working copy diff: ${diffAfter.stderr}`};
    }

    if (diffAfter.stdout.trim().length > 0) {
        return {ok: false, error: "Working copy still has uncommitted changes after commit."};
    }

    return {ok: true};
}

async function readJjParentCommitDescription(
    pi: ExtensionAPI,
    root: string,
): Promise<{description: string} | {error: string}> {
    const result = await pi.exec("jj", ["log", "-r", "@-", "-T", "description", "--no-graph", "--limit", "1"], {cwd: root});
    if (result.code !== 0) {
        return {error: `Failed to read parent commit description: ${result.stderr}`};
    }
    return {description: result.stdout.trim()};
}

async function runJjDescribeParentCommit(
    pi: ExtensionAPI,
    root: string,
    message: string,
): Promise<{ok: true} | {ok: false; error: string}> {
    const described = await pi.exec("jj", ["desc", "-r", "@-", "-m", message], {cwd: root});
    if (described.code !== 0) {
        return {ok: false, error: `jj desc failed: ${described.stderr}`};
    }
    return {ok: true};
}

function workflowsHaveSamePendingEmptySubtaskCommit(
    left: PendingEmptySubtaskCommit | null | undefined,
    right: PendingEmptySubtaskCommit | null | undefined,
): boolean {
    if (!left && !right) return true;
    if (!left || !right) return false;
    return left.task_id === right.task_id && left.commit_message === right.commit_message;
}

function setPendingEmptySubtaskCommit(
    workflow: PersistedWorkflow,
    pending: PendingEmptySubtaskCommit | null,
): PersistedWorkflow {
    const normalizedPending = pending ? {
        task_id: pending.task_id.trim(),
        commit_message: pending.commit_message.trim(),
    } : null;

    if (workflowsHaveSamePendingEmptySubtaskCommit(workflow.pending_empty_subtask_commit, normalizedPending)) {
        return workflow;
    }

    const updated = cloneWorkflow(workflow);
    updated.pending_empty_subtask_commit = normalizedPending;
    updated.updated_at = new Date().toISOString();
    return updated;
}

async function prepareFinalCommit(
    pi: ExtensionAPI,
    root: string,
    workflow: PersistedWorkflow,
    effects: MachineWorkflowEffect[],
): Promise<{workflow: PersistedWorkflow} | {error: string}> {
    if (workflow.state !== "commit") return {workflow};
    const commitMessage = runJjCommitMessageFromEffects(effects);
    if (!commitMessage) return {workflow};

    const diff = await workingCopyHasChanges(pi, root);
    if ("error" in diff) return {error: diff.error};

    let parentMessage: string | null = null;
    if (!diff.hasChanges) {
        const parent = await readJjParentCommitDescription(pi, root);
        if ("error" in parent) return {error: parent.error};
        parentMessage = parent.description;
    }

    const pendingCommit = workflow.workflow_kind === "fix"
        ? workflow.pending_fix_commit
        : workflow.pending_task_commit;
    const action = fixCommitPreflightAction({
        hasChanges: diff.hasChanges,
        requestedMessage: commitMessage,
        pendingMessage: pendingCommit?.commit_message ?? null,
        parentMessage,
    });
    if (action === "block" && workflow.workflow_kind === "fix") {
        return {error: "Fix working copy has no changes to commit; root issue was not closed."};
    }
    if (action === "block" && pendingCommit) {
        return {error: "Previously successful task commit is no longer the parent; refusing to rewrite an unrelated commit."};
    }
    if (action === "already-committed" || !diff.hasChanges || pendingCommit?.commit_message === commitMessage) {
        return {workflow};
    }

    const updated = cloneWorkflow(workflow);
    const marker = {commit_message: commitMessage, started_at: new Date().toISOString()};
    if (workflow.workflow_kind === "fix") updated.pending_fix_commit = marker;
    else updated.pending_task_commit = marker;
    updated.updated_at = new Date().toISOString();
    const saved = saveWorkflowAtomic(root, updated);
    if (saved.ok === false) return {error: saved.error};
    return {workflow: updated};
}

function notifyTransition(ctx: ExtensionContext, before: PersistedWorkflow, after: PersistedWorkflow): void {
    const from = `${before.workflow_kind}:${before.state}/${before.active_task_id}`;
    const to = `${after.workflow_kind}:${after.state}/${after.active_task_id}`;
    const versionInfo = `v${before.version}→v${after.version}`;
    ctx.ui.notify(`workflow transition ${versionInfo}: ${from} -> ${to}`, "info");
}

/**
 * Write a projection of the current workflow state to the per-session state file
 * at ~/.pi/agent/session-state/<session-id>.json, under extensions.task.
 * Best-effort — failures are silently ignored.
 */
function writeTaskStateProjection(ctx: ExtensionContext, workflow: PersistedWorkflow): void {
    try {
        const sessionId = ctx.sessionManager.getSessionId();
        if (!sessionId) return;

        const stateDir = path.join(getAgentDir(), "session-state");
        fs.mkdirSync(stateDir, {recursive: true});
        const statePath = path.join(stateDir, `${sessionId}.json`);

        let state: Record<string, unknown> = {};
        try {
            state = JSON.parse(fs.readFileSync(statePath, "utf8"));
        } catch {
            // File doesn't exist or is invalid — start fresh.
        }

        state.sessionId = sessionId;

        const extensions = (state.extensions ?? {}) as Record<string, unknown>;
        const activeNode = findNodeById(workflow, workflow.active_task_id);
        extensions.task = {
            workflowKind: workflow.workflow_kind,
            workflowState: workflow.state,
            manualTestStatus: workflow.manual_test_status ?? null,
            rootTaskId: workflow.task_id,
            rootTitle: workflow.title,
            activeTaskId: workflow.active_task_id,
            activeTaskTitle: activeNode?.title ?? workflow.active_task_id,
            updatedAt: workflow.updated_at,
        };
        state.extensions = extensions;

        const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf8");
        fs.renameSync(tmpPath, statePath);
    } catch {
        // Best-effort.
    }
}

// ---------------------------------------------------------------------------
// Functional core / imperative shell boundary
// ---------------------------------------------------------------------------

/**
 * Functional-core adapter: map persisted workflow state into the pure machine snapshot.
 */
function buildMachineSnapshot(workflow: PersistedWorkflow): MachineWorkflowSnapshot {
    const parent = findParentById(workflow, workflow.active_task_id);
    const sibling = nextSibling(workflow, workflow.active_task_id);

    return {
        workflowKind: workflow.workflow_kind,
        manualTestStatus: workflow.manual_test_status,
        state: workflow.state,
        rootTaskId: workflow.task_id,
        activeTaskId: workflow.active_task_id,
        activeTaskParentId: parent ? parent.task_id : null,
        activeTaskNextSiblingId: sibling ? sibling.task_id : null,
    };
}

/**
 * Enrich machine events with root issue markdown when required by the pure transition logic.
 */
async function withRequiredRootIssueMarkdown(
    pi: ExtensionAPI,
    root: string,
    workflow: PersistedWorkflow,
    snapshot: MachineWorkflowSnapshot,
    event: MachineWorkflowEvent,
): Promise<{event: MachineWorkflowEvent} | {error: string}> {
    if (!eventNeedsRootIssueMarkdown(snapshot, event)) {
        return {event};
    }

    if (event.type === "COMPLETE" && event.rootIssueMarkdown.trim()) {
        return {event};
    }

    if (event.type === "FORCE_LGTM" && event.rootIssueMarkdown?.trim()) {
        return {event};
    }

    const loaded = await loadIssueBodyMarkdown(pi, root, workflow.task_id);
    if ("error" in loaded) {
        return {error: loaded.error};
    }

    if (event.type === "COMPLETE") {
        return {
            event: {
                ...event,
                rootIssueMarkdown: loaded.content,
            },
        };
    }

    if (event.type === "FORCE_LGTM") {
        return {
            event: {
                ...event,
                rootIssueMarkdown: loaded.content,
            },
        };
    }

    return {event};
}

function applyCreatedChildrenToTree(workflow: PersistedWorkflow, createdChildrenByParent: Map<string, TaskNode[]>): void {
    for (const [parentTaskId, children] of createdChildrenByParent.entries()) {
        const parentNode = findNodeById(workflow, parentTaskId);
        if (!parentNode) {
            throw new Error(`Parent task not found while applying CREATE_ISSUE effects: ${parentTaskId}`);
        }
        // CREATE_ISSUE effects represent the machine-approved child list for this transition.
        // Replace, do not append, so retries remain deterministic and do not preserve stale children.
        parentNode.subtasks = children.map(cloneTaskNode);
    }
}

type SubtaskCommitEmptyWorkingCopyGuardResult =
    | {kind: "proceed"; workflow: PersistedWorkflow; decision: MachineAppliedTransitionDecision}
    | {kind: "blocked"; workflow: PersistedWorkflow}
    | {kind: "error"; error: string};

function runJjCommitMessageFromEffects(effects: MachineWorkflowEffect[]): string | null {
    for (const effect of effects) {
        if (effect.type === "RUN_JJ_COMMIT") {
            return effect.message;
        }
    }
    return null;
}

async function guardSubtaskCommitAgainstEmptyWorkingCopy(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    root: string,
    workflow: PersistedWorkflow,
    decision: MachineAppliedTransitionDecision,
): Promise<SubtaskCommitEmptyWorkingCopyGuardResult> {
    if (workflow.state !== "subtask-commit") {
        return {kind: "proceed", workflow, decision};
    }

    const commitMessage = runJjCommitMessageFromEffects(decision.effects);
    if (!commitMessage) {
        return {kind: "proceed", workflow, decision};
    }

    const diff = await workingCopyHasChanges(pi, root);
    if ("error" in diff) {
        return {kind: "error", error: diff.error};
    }

    if (diff.hasChanges) {
        return {
            kind: "proceed",
            workflow: setPendingEmptySubtaskCommit(workflow, null),
            decision,
        };
    }

    const pending = workflow.pending_empty_subtask_commit;
    const isConfirmed = Boolean(
        pending
        && pending.task_id === workflow.active_task_id,
    );

    if (!isConfirmed) {
        const blockedWorkflow = setPendingEmptySubtaskCommit(workflow, {
            task_id: workflow.active_task_id,
            commit_message: commitMessage,
        });

        const saved = saveWorkflowAtomic(root, blockedWorkflow);
        if (saved.ok === false) {
            return {kind: "error", error: saved.error};
        }

        ctx.ui.notify(
            [
                "Subtask working copy is empty at subtask-commit.",
                "No transition was applied so you can verify state manually.",
                "If everything looks correct, run /task again to continue without creating a subtask commit.",
            ].join(" "),
            "warning",
        );

        return {kind: "blocked", workflow: blockedWorkflow};
    }

    ctx.ui.notify(
        "Subtask working copy is still empty; continuing without creating a subtask commit.",
        "warning",
    );

    return {
        kind: "proceed",
        workflow: setPendingEmptySubtaskCommit(workflow, null),
        decision: {
            ...decision,
            effects: decision.effects.filter((effect) => effect.type !== "RUN_JJ_COMMIT"),
        },
    };
}

type InterpretedMachineEffectsResult = {
    createdChildrenByParent: Map<string, TaskNode[]>;
    createdIssues: Array<{parentTaskId: string; issue_id: string; title: string}>;
};

type MachineEffectDependencies = {
    closeWorkflowIssue: typeof closeWorkflowIssue;
};

const defaultMachineEffectDependencies: MachineEffectDependencies = {
    closeWorkflowIssue,
};

/**
 * Imperative shell: execute machine-emitted effects against GitHub/jj.
 */
async function interpretMachineEffects(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    root: string,
    workflow: PersistedWorkflow,
    effects: MachineWorkflowEffect[],
    dependencies: MachineEffectDependencies = defaultMachineEffectDependencies,
): Promise<InterpretedMachineEffectsResult | {error: string}> {
    const createdChildrenByParent = new Map<string, TaskNode[]>();
    const createdIssues: Array<{parentTaskId: string; issue_id: string; title: string}> = [];

    let handledFinalCommit = false;
    if (workflow.state === "commit") {
        const commitMessage = runJjCommitMessageFromEffects(effects);
        if (commitMessage) {
            const preflight = await workingCopyHasChanges(pi, root);
            if ("error" in preflight) {
                return {error: preflight.error};
            }
            const commitSubject = commitMessage.split("\n")[0]?.trim() || "(empty subject)";

            if (workflow.workflow_kind === "fix") {
                let parentMessage: string | null = null;
                if (!preflight.hasChanges) {
                    const parent = await readJjParentCommitDescription(pi, root);
                    if ("error" in parent) return {error: parent.error};
                    parentMessage = parent.description;
                }
                const action = fixCommitPreflightAction({
                    hasChanges: preflight.hasChanges,
                    requestedMessage: commitMessage,
                    pendingMessage: workflow.pending_fix_commit?.commit_message ?? null,
                    parentMessage,
                });
                if (action === "block") {
                    return {error: "Fix working copy has no changes to commit; root issue was not closed."};
                }
                if (action === "commit") {
                    ctx.ui.notify(`workflow effect: running jj commit (${commitSubject})`, "info");
                    const committed = await runJjCommitWithCleanCheck(pi, root, commitMessage);
                    if (committed.ok === false) return {error: committed.error};
                    ctx.ui.notify(`workflow effect: jj commit succeeded (${commitSubject})`, "info");
                } else {
                    ctx.ui.notify(`workflow effect: previously successful jj commit detected (${commitSubject})`, "warning");
                }
            } else if (!preflight.hasChanges && workflow.pending_task_commit) {
                ctx.ui.notify(`workflow effect: previously successful jj commit detected (${commitSubject})`, "warning");
            } else if (!preflight.hasChanges) {
                ctx.ui.notify(
                    "workflow effect: final working copy is empty; updating parent commit message instead of creating an empty commit",
                    "warning",
                );
                const described = await runJjDescribeParentCommit(pi, root, commitMessage);
                if (described.ok === false) return {error: described.error};
                ctx.ui.notify(`workflow effect: jj desc succeeded (${commitSubject})`, "info");
            } else {
                ctx.ui.notify(`workflow effect: running jj commit (${commitSubject})`, "info");
                const committed = await runJjCommitWithCleanCheck(pi, root, commitMessage);
                if (committed.ok === false) return {error: committed.error};
                ctx.ui.notify(`workflow effect: jj commit succeeded (${commitSubject})`, "info");
            }
            handledFinalCommit = true;
        }
    }

    for (const effect of effects) {
        if (effect.type === "CREATE_ISSUE") {
            const created = await createOrReuseChildTask(
                pi,
                root,
                effect.parentTaskId,
                effect.title,
                effect.description,
                effect.tdd,
            );
            if ("error" in created) {
                return {error: created.error};
            }

            const existing = createdChildrenByParent.get(effect.parentTaskId) ?? [];
            existing.push({
                task_id: created.id,
                title: effect.title,
                subtasks: [],
            });
            createdChildrenByParent.set(effect.parentTaskId, existing);
            createdIssues.push({
                parentTaskId: effect.parentTaskId,
                issue_id: created.id,
                title: effect.title,
            });
            ctx.ui.notify(`workflow effect: created/reused task ${created.id} (${effect.title})`, "info");
            continue;
        }

        if (effect.type === "ADD_NOTE") {
            await addIssueCommentBestEffort(pi, root, effect.taskId, effect.note);
            continue;
        }

        if (effect.type === "CLOSE_ISSUE") {
            const closed = await dependencies.closeWorkflowIssue(pi, root, effect.taskId);
            if (closed.ok === false) {
                return {error: `Failed to close task ${effect.taskId}: ${closed.error}`};
            }
            continue;
        }

        if (effect.type === "RUN_JJ_COMMIT") {
            if (handledFinalCommit) {
                continue;
            }
            const commitSubject = effect.message.split("\n")[0]?.trim() || "(empty subject)";

            ctx.ui.notify(`workflow effect: running jj commit (${commitSubject})`, "info");
            const committed = await runJjCommitWithCleanCheck(pi, root, effect.message);
            if (committed.ok === false) {
                return {error: committed.error};
            }
            ctx.ui.notify(`workflow effect: jj commit succeeded (${commitSubject})`, "info");
            continue;
        }
    }

    return {createdChildrenByParent, createdIssues};
}

/**
 * Resolve machine-selected active task target against the (possibly mutated) workflow tree.
 */
function resolveNextActiveTaskId(
    workflow: PersistedWorkflow,
    currentActiveTaskId: string,
    target: MachineActiveTaskTarget,
): {activeTaskId: string} | {error: string} {
    if (target.type === "current") {
        return {activeTaskId: currentActiveTaskId};
    }

    if (target.type === "root") {
        return {activeTaskId: workflow.task_id};
    }

    if (target.type === "parent") {
        const parent = findParentById(workflow, currentActiveTaskId);
        if (!parent) {
            return {error: `No parent found for active task ${currentActiveTaskId}`};
        }
        return {activeTaskId: parent.task_id};
    }

    if (target.type === "next-sibling") {
        const sibling = nextSibling(workflow, currentActiveTaskId);
        if (!sibling) {
            return {error: `No next sibling found for active task ${currentActiveTaskId}`};
        }
        return {activeTaskId: sibling.task_id};
    }

    const parentNode = findNodeById(workflow, target.parentTaskId);
    if (!parentNode) {
        return {error: `Parent task not found for first-created-child target: ${target.parentTaskId}`};
    }

    const firstChild = parentNode.subtasks[0];
    if (!firstChild) {
        return {error: `No children found under parent ${target.parentTaskId} for first-created-child target`};
    }

    return {activeTaskId: firstChild.task_id};
}

function machineEventAuditLabel(event: MachineWorkflowEvent): string {
    if (event.type === "COMPLETE") {
        return `machine:complete:${event.completedState}`;
    }
    if (event.type === "FORCE_LGTM") {
        return `machine:force-lgtm:${event.completedState}`;
    }
    return `machine:manual-done:${event.completedState}`;
}

async function dispatchWorkflowEvent(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    root: string,
    workflow: PersistedWorkflow,
    event: MachineWorkflowEvent,
    effectDependencies: MachineEffectDependencies = defaultMachineEffectDependencies,
): Promise<{changed: boolean; workflow: PersistedWorkflow} | {error: string}> {
    const transitionError = (message: string): {error: string} => ({
        error: `${message}. Manual cleanup required in ${getWorkflowPath(root)}.`,
    });

    const beforeError = validateWorkflow(workflow);
    if (beforeError) {
        return transitionError(`Workflow invariant failure before transition: ${beforeError}.`);
    }

    // 1) Build pure-machine inputs.
    const snapshot = buildMachineSnapshot(workflow);
    const enriched = await withRequiredRootIssueMarkdown(pi, root, workflow, snapshot, event);
    if ("error" in enriched) {
        return {error: enriched.error};
    }

    const machineEvent = enriched.event;

    // 2) Run pure transition logic.
    const decision: MachineTransitionDecision = runWorkflowTransition(snapshot, machineEvent);

    if (decision.kind === "ignored") {
        if (ENABLE_TRANSITION_DEBUG && decision.reason) {
            ctx.ui.notify(`workflow transition ignored: ${decision.reason}`, "info");
        }
        return {changed: false, workflow};
    }

    if (decision.kind === "rejected") {
        ctx.ui.notify(`workflow transition rejected: ${decision.reason}`, "warning");
        return {changed: false, workflow};
    }

    const guarded = await guardSubtaskCommitAgainstEmptyWorkingCopy(pi, ctx, root, workflow, decision);
    if (guarded.kind === "error") {
        return {error: guarded.error};
    }
    if (guarded.kind === "blocked") {
        return {changed: false, workflow: guarded.workflow};
    }

    let workflowForTransition = guarded.workflow;
    const decisionToApply = guarded.decision;

    const preparedFixCommit = await prepareFinalCommit(pi, root, workflowForTransition, decisionToApply.effects);
    if ("error" in preparedFixCommit) {
        return {error: preparedFixCommit.error};
    }
    workflowForTransition = preparedFixCommit.workflow;

    // 3) Interpret side effects.
    const interpreted = await interpretMachineEffects(
        pi,
        ctx,
        root,
        workflowForTransition,
        decisionToApply.effects,
        effectDependencies,
    );
    if ("error" in interpreted) {
        return {error: interpreted.error};
    }

    const manualTestCreatedFollowups = workflowForTransition.state === "manual-test"
        ? interpreted.createdIssues.filter((created) => created.parentTaskId === workflowForTransition.task_id)
        : [];
    const manualTestFollowupCreatedAt = new Date().toISOString();
    const shouldMutateTree = interpreted.createdChildrenByParent.size > 0 || manualTestCreatedFollowups.length > 0;
    const mutateTree = shouldMutateTree
        ? (draft: PersistedWorkflow) => {
            if (interpreted.createdChildrenByParent.size > 0) {
                applyCreatedChildrenToTree(draft, interpreted.createdChildrenByParent);
            }
            if (manualTestCreatedFollowups.length > 0) {
                draft.manual_test_followups = recordManualTestFollowups({
                    existing: draft.manual_test_followups ?? [],
                    createdIssues: manualTestCreatedFollowups,
                    createdAt: manualTestFollowupCreatedAt,
                    fromManualTestVersion: workflowForTransition.version,
                });
            }
        }
        : undefined;

    const preview = cloneWorkflow(workflowForTransition);
    if (mutateTree) {
        try {
            mutateTree(preview);
        } catch (error) {
            return transitionError(`Failed to apply tree mutation preview: ${error}`);
        }
    }

    const resolvedTarget = resolveNextActiveTaskId(
        preview,
        workflowForTransition.active_task_id,
        decisionToApply.activeTaskTarget,
    );
    if ("error" in resolvedTarget) {
        return transitionError(resolvedTarget.error);
    }

    // 4) Persist new workflow state with validated invariants.
    const transitioned = buildTransitionedWorkflow(workflowForTransition, {
        toState: decisionToApply.state,
        manualTestStatus: decisionToApply.manualTestStatus,
        activeTaskId: resolvedTarget.activeTaskId,
        event: machineEventAuditLabel(machineEvent),
        mutateTree,
    });
    if ("error" in transitioned) {
        return transitionError(transitioned.error);
    }

    const saved = saveWorkflowAtomic(root, transitioned.workflow);
    if (saved.ok === false) {
        return {error: saved.error};
    }

    notifyTransition(ctx, workflowForTransition, transitioned.workflow);
    writeTaskStateProjection(ctx, transitioned.workflow);
    return {
        changed: true,
        workflow: transitioned.workflow,
    };
}

export const dispatchWorkflowEventForTest = dispatchWorkflowEvent;

function clearTaskUi(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("task", undefined);
}

async function updateTaskUiDisplay(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    workflow: PersistedWorkflow,
): Promise<void> {
    const rootBase = `${workflow.task_id} - ${workflow.title}`;
    const activeNode = findNodeById(workflow, workflow.active_task_id);
    const activeTitle = activeNode?.title ?? workflow.active_task_id;

    if (ctx.hasUI) {
        const footerLine = workflow.active_task_id === workflow.task_id
            ? `${rootBase} (${workflow.state})`
            : `${rootBase} | ${workflow.active_task_id} - ${activeTitle} (${workflow.state})`;
        ctx.ui.setStatus("task", footerLine);
    }

    const desiredSessionName = `${workflow.task_id} - ${workflow.title}`;
    const currentSessionName = pi.getSessionName()?.trim() ?? "";
    if (desiredSessionName.trim() && desiredSessionName.trim() !== currentSessionName) {
        pi.setSessionName(desiredSessionName);
    }
}

async function maybeNotifyPendingTransitionOutsideTaskLoop(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
): Promise<void> {
    if (isTaskLoopActive()) {
        return;
    }

    const cwd = ctx.sessionManager.getCwd();
    if (!isUnderTaskWorkspacesDirectory(cwd)) {
        return;
    }

    const jjRootResult = await pi.exec("jj", ["root"], {cwd});
    if (jjRootResult.code !== 0) {
        return;
    }

    const root = jjRootResult.stdout.trim();
    if (!root || !isTaskWorkspace(root)) {
        return;
    }

    const loaded = loadWorkflow(root);
    if ("error" in loaded) {
        return;
    }

    const workflow = loaded.workflow;
    const latest = getLastAssistantMessage(ctx);
    const pendingCandidate = findPendingPromptRunCompletionCandidate({
        branch: ctx.sessionManager.getBranch(),
        pendingPromptRun: workflow.pending_prompt_run ?? null,
        workflowState: workflow.state,
        activeTaskId: workflow.active_task_id,
        sessionLeafId: workflow.session_leaf_id,
        lastConsumedAssistantId: workflow.last_consumed_assistant_id ?? null,
    });

    const shouldNotify = pendingCandidate !== null || shouldNotifyPendingTransitionOutsideTaskLoop({
        workflowKind: workflow.workflow_kind,
        workflowState: workflow.state,
        latestAssistantMessageId: latest?.id ?? null,
        latestAssistantMessageText: latest?.text ?? "",
        lastConsumedAssistantId: workflow.last_consumed_assistant_id ?? null,
        taskLoopActive: isTaskLoopActive(),
    });

    if (!shouldNotify) {
        return;
    }

    ctx.ui.notify(
        `The agent has requested a transition outside the tool loop, please run /${workflow.workflow_kind} to continue.`,
        "warning",
    );
}

function taskIssueEditError(reason: string, extraDetails?: Record<string, unknown>): Error {
    if (!extraDetails || Object.keys(extraDetails).length === 0) {
        return new Error(reason);
    }

    return new Error(`${reason} Details: ${JSON.stringify(extraDetails)}`);
}

async function executeTaskIssueBodyEditTool(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    tool: TaskIssueBodyEditInput["tool"],
    input: TaskIssueToolInput,
) {
    const jjRootResult = await pi.exec("jj", ["root"], {cwd: ctx.cwd});
    if (jjRootResult.code !== 0) {
        throw taskIssueEditError("Not in a jj workspace (jj root failed)", {
            stderr: jjRootResult.stderr,
        });
    }

    const root = jjRootResult.stdout.trim();
    if (!root || !isTaskWorkspace(root)) {
        throw taskIssueEditError(`${tool} can only be used inside a task workspace (~/.workspaces/<task-id>/<repo>).`, {
            root,
        });
    }

    const loadedWorkflow = loadWorkflow(root);
    if ("error" in loadedWorkflow) {
        throw taskIssueEditError(loadedWorkflow.error);
    }

    const workflow = loadedWorkflow.workflow;
    const taskId = input.target === "root" ? workflow.task_id : workflow.active_task_id;
    const issueNumber = parseIssueNumberFromTaskId(taskId);
    if (!issueNumber) {
        throw taskIssueEditError(
            `Cannot map workflow task id "${taskId}" to a GitHub issue number. ` +
            "Supported forms: 123, #123, owner/repo#123, or GitHub issue URL.",
            {taskId},
        );
    }

    const githubConfigResult = await resolveGitHubClientConfig(pi, root);
    if ("error" in githubConfigResult) {
        throw taskIssueEditError(githubConfigResult.error);
    }

    const config = githubConfigResult.config;

    try {
        const issue = await getIssueByNumber(config, issueNumber);
        if (!issue) {
            throw taskIssueEditError(`Issue #${issueNumber} not found in ${config.owner}/${config.repo}.`, {
                target: input.target,
                issueNumber,
            });
        }

        const bodyEditInput = tool === "task_issue_insert_section"
            ? {tool, section: (input as TaskIssueInsertSectionToolInput).section, content: (input as TaskIssueInsertSectionToolInput).content}
            : tool === "task_issue_edit_section"
                ? {tool, section: (input as TaskIssueEditSectionToolInput).section, edits: (input as TaskIssueEditSectionToolInput).edits}
                : {tool, edits: (input as TaskIssueEditDescriptionToolInput).edits};
        const nextBody = computeTaskIssueEditBody(issue.body, bodyEditInput);

        if (nextBody === issue.body) {
            return {
                content: [{type: "text" as const, text: `No changes needed for issue #${issue.number}.`}],
                details: {
                    ok: true,
                    target: input.target,
                    issueNumber: issue.number,
                    issueId: issue.id,
                    issueUrl: `https://github.com/${config.owner}/${config.repo}/issues/${issue.number}`,
                    tool,
                    sectionHeader: "section" in input ? taskIssueSectionHeader(input.section) : undefined,
                    changed: false,
                    updatedAt: new Date().toISOString(),
                },
            };
        }

        const updated = await updateIssueBody(config, issue.id, nextBody);
        const sectionHeader = "section" in input ? taskIssueSectionHeader(input.section) : undefined;
        const targetLabel = input.target === "root" ? "root" : "active";
        const operationLabel = tool === "task_issue_edit_description"
            ? "description"
            : `section ${sectionHeader}`;

        return {
            content: [{type: "text" as const, text: `Updated ${targetLabel} issue #${updated.number}: ${operationLabel}.`}],
            details: {
                ok: true,
                target: input.target,
                issueNumber: updated.number,
                issueId: updated.id,
                issueUrl: `https://github.com/${config.owner}/${config.repo}/issues/${updated.number}`,
                tool,
                sectionHeader,
                changed: true,
                updatedAt: new Date().toISOString(),
            },
        };
    } catch (error) {
        throw taskIssueEditError(`${tool} failed: ${error}`);
    }
}

export default function (pi: ExtensionAPI) {
    pi.on("agent_start", () => {
        resolveNextAgentStart();
    });

    pi.on("agent_end", async (_event, ctx) => {
        await maybeNotifyPendingTransitionOutsideTaskLoop(pi, ctx);
    });

    pi.registerTool({
        name: "task_issue_insert_section",
        label: "Task Issue Insert Section",
        description: [
            "Insert a missing workflow issue section for the active or root issue.",
            "Fails if the section already exists.",
            "Use section bodies only, without `##` headers.",
        ].join(" "),
        parameters: TaskIssueInsertSectionToolParams,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const input = params as TaskIssueInsertSectionToolInput;
            return executeTaskIssueBodyEditTool(pi, ctx, "task_issue_insert_section", input);
        },
    });

    pi.registerTool({
        name: "task_issue_edit_section",
        label: "Task Issue Edit Section",
        description: [
            "Edit a workflow issue section using exact text replacement.",
            "Every edits[].oldText must match a unique, non-overlapping region of the section body.",
            "Use section bodies only, without `##` headers.",
        ].join(" "),
        parameters: TaskIssueEditSectionToolParams,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const input = params as TaskIssueEditSectionToolInput;
            return executeTaskIssueBodyEditTool(pi, ctx, "task_issue_edit_section", input);
        },
    });

    pi.registerTool({
        name: "task_issue_edit_description",
        label: "Task Issue Edit Description",
        description: [
            "Edit a workflow issue description using exact text replacement.",
            "Every edits[].oldText must match a unique, non-overlapping region of the description before the first `##` section.",
            "Do not include `##` headers in replacement text.",
        ].join(" "),
        parameters: TaskIssueEditDescriptionToolParams,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const input = params as TaskIssueEditDescriptionToolInput;
            return executeTaskIssueBodyEditTool(pi, ctx, "task_issue_edit_description", input);
        },
    });

    pi.registerCommand("task", {
        description: "Run the deterministic task workflow",
        handler: async (args, ctx) => {
            const trimmedArgs = (args ?? "").trim();
            const subcommand = trimmedArgs.split(/\s+/).filter(Boolean)[0]?.toLowerCase() ?? "";
            const subcommandArgs = subcommand ? trimmedArgs.slice(subcommand.length).trim() : "";

            // Check required commands
            for (const cmd of ["jj", "git"]) {
                const result = await pi.exec("which", [cmd]);
                if (result.code !== 0) {
                    ctx.ui.notify(`Missing required command: ${cmd}`, "error");
                    return;
                }
            }

            // Check if we're in a jj workspace
            const jjRootResult = await pi.exec("jj", ["root"]);
            if (jjRootResult.code !== 0) {
                ctx.ui.notify("Not in a jj workspace (jj root failed)", "error");
                return;
            }
            const root = jjRootResult.stdout.trim();

            // Determine workspace type and run appropriate flow
            if (isTaskWorkspace(root)) {
                const loadedKind = loadWorkflow(root);
                if ("error" in loadedKind) {
                    ctx.ui.notify(loadedKind.error, "error");
                    return;
                }
                const commandKind = validateWorkflowCommandKind("task", loadedKind.workflow.workflow_kind);
                if ("error" in commandKind) {
                    ctx.ui.notify(commandKind.error, "error");
                    return;
                }
                if (subcommand === "lgtm") {
                    const forced = await forceLGTM(pi, ctx, root, "task");
                    if (!forced) {
                        return;
                    }
                } else if (subcommand === "done") {
                    const advanced = await markImplementationDone(pi, ctx, root, "task");
                    if (!advanced) {
                        return;
                    }
                } else if (subcommand === "apply") {
                    await withTaskLoopGuard(() => applyReviewPlanFindings(pi, ctx, root, subcommandArgs));
                    return;
                } else if (subcommand === "delete") {
                    ctx.ui.notify("/task delete can only be used from the main workspace.", "error");
                    return;
                } else if (subcommand) {
                    ctx.ui.notify(`Unknown /task subcommand: ${subcommand}. Supported: lgtm, done, apply`, "error");
                    return;
                }

                await withTaskLoopGuard(() => runTaskWorkspace(pi, ctx, root));
            } else {
                if (subcommand === "lgtm") {
                    ctx.ui.notify("/task lgtm can only be used inside a per-task workspace (~/.workspaces/<task-id>/<repo>).", "error");
                    return;
                }
                if (subcommand === "done") {
                    ctx.ui.notify("/task done can only be used inside a per-task workspace (~/.workspaces/<task-id>/<repo>).", "error");
                    return;
                }
                if (subcommand === "delete") {
                    await deleteTaskWorkspaceFromMain(pi, ctx, root);
                    return;
                }
                if (subcommand === "apply") {
                    ctx.ui.notify("/task apply can only be used inside a per-task workspace (~/.workspaces/<task-id>/<repo>).", "error");
                    return;
                }
                if (subcommand) {
                    ctx.ui.notify(`Unknown /task subcommand: ${subcommand}. Supported: delete`, "error");
                    return;
                }
                await runMainWorkspace(pi, ctx, root, "task");
            }
        },
    });

    pi.registerCommand("fix", {
        description: "Run the streamlined fix workflow",
        handler: async (args, ctx) => {
            const subcommand = (args ?? "").trim().split(/\s+/).filter(Boolean)[0]?.toLowerCase() ?? "";
            for (const cmd of ["jj", "git"]) {
                const result = await pi.exec("which", [cmd]);
                if (result.code !== 0) {
                    ctx.ui.notify(`Missing required command: ${cmd}`, "error");
                    return;
                }
            }
            const jjRootResult = await pi.exec("jj", ["root"]);
            if (jjRootResult.code !== 0) {
                ctx.ui.notify("Not in a jj workspace (jj root failed)", "error");
                return;
            }
            const root = jjRootResult.stdout.trim();
            if (isTaskWorkspace(root)) {
                const loaded = loadWorkflow(root);
                if ("error" in loaded) {
                    ctx.ui.notify(loaded.error, "error");
                    return;
                }
                const commandKind = validateWorkflowCommandKind("fix", loaded.workflow.workflow_kind);
                if ("error" in commandKind) {
                    ctx.ui.notify(commandKind.error, "error");
                    return;
                }
                if (subcommand === "lgtm") {
                    if (!await forceLGTM(pi, ctx, root, "fix")) return;
                } else if (subcommand === "done") {
                    if (!await markImplementationDone(pi, ctx, root, "fix")) return;
                } else if (subcommand) {
                    ctx.ui.notify(`Unknown /fix subcommand: ${subcommand}. Supported: lgtm, done`, "error");
                    return;
                }
                await withTaskLoopGuard(() => runTaskWorkspace(pi, ctx, root));
                return;
            }
            if (subcommand) {
                ctx.ui.notify(`Unknown /fix subcommand: ${subcommand}. /fix has no apply or delete subcommand.`, "error");
                return;
            }
            await runMainWorkspace(pi, ctx, root, "fix");
        },
    });
}

function agentEndLooksLikeErrorFromSession(ctx: ExtensionContext): boolean {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry.type !== "message") continue;
        const message = entry.message as {
            role?: unknown;
            stopReason?: unknown;
            errorMessage?: unknown;
            isError?: unknown;
        };

        if (message.role === "assistant") {
            return (
                message.stopReason === "error" ||
                message.stopReason === "aborted" ||
                typeof message.errorMessage === "string"
            );
        }

        if (message.role === "toolResult") {
            return message.isError === true;
        }

        return false;
    }

    return false;
}

/**
 * Manual escape hatch for when a review loop is being too strict.
 *
 * Usage: /task lgtm
 *
 * Validity is enforced by the state machine (currently review-plan/review only).
 */
async function forceLGTM(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    root: string,
    commandKind: WorkflowKind,
): Promise<boolean> {
    if (!isTaskWorkspace(root)) {
        ctx.ui.notify(`/${commandKind} lgtm is only supported in a workflow workspace.`, "error");
        return false;
    }

    const loaded = loadWorkflow(root);
    if ("error" in loaded) {
        ctx.ui.notify(loaded.error, "error");
        return false;
    }

    const workflow = loaded.workflow;

    const result = await dispatchWorkflowEvent(pi, ctx, root, workflow, {
        type: "FORCE_LGTM",
        completedState: workflow.state,
    });
    if ("error" in result) {
        ctx.ui.notify(result.error, "error");
        return false;
    }

    if (!result.changed) {
        return false;
    }

    ctx.ui.notify(`/${commandKind} lgtm applied in ${workflow.state}.`, "info");
    return true;
}

async function markImplementationDone(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    root: string,
    commandKind: WorkflowKind,
): Promise<boolean> {
    if (!isTaskWorkspace(root)) {
        ctx.ui.notify(`/${commandKind} done is only supported in a workflow workspace.`, "error");
        return false;
    }

    const loaded = loadWorkflow(root);
    if ("error" in loaded) {
        ctx.ui.notify(loaded.error, "error");
        return false;
    }

    const workflow = loaded.workflow;
    const latestAssistantMessageId = getLastAssistantMessage(ctx)?.id ?? null;
    const result = await dispatchWorkflowEvent(pi, ctx, root, workflow, {
        type: "MANUAL_DONE",
        completedState: workflow.state,
    });
    if ("error" in result) {
        ctx.ui.notify(result.error, "error");
        return false;
    }

    if (!result.changed) {
        return false;
    }

    const consumed = persistConsumedAssistantMessageId(root, result.workflow, latestAssistantMessageId);
    if ("error" in consumed) {
        ctx.ui.notify(consumed.error, "error");
        return false;
    }

    const clearedPending = persistPendingPromptRun(root, consumed.workflow, null);
    if ("error" in clearedPending) {
        ctx.ui.notify(clearedPending.error, "error");
        return false;
    }

    ctx.ui.notify(`/${commandKind} done applied in ${workflow.state}.`, "info");
    return true;
}

async function applyReviewPlanFindings(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    root: string,
    args: string,
): Promise<boolean> {
    const parsedArgs = parseTaskApplyArgs(args);
    if ("error" in parsedArgs) {
        ctx.ui.notify(parsedArgs.error, "error");
        return false;
    }

    const loaded = loadWorkflow(root);
    if ("error" in loaded) {
        ctx.ui.notify(loaded.error, "error");
        return false;
    }

    const workflow = loaded.workflow;
    if (workflow.state !== "review-plan") {
        ctx.ui.notify(`/task apply is only valid in review-plan; current state is ${workflow.state}.`, "error");
        return false;
    }

    const baseLeafId = ctx.sessionManager.getLeafId();
    if (!baseLeafId) {
        ctx.ui.notify("No session leaf ID available for /task apply", "error");
        return false;
    }

    return runTaskApplyIterations({
        findings: parsedArgs.findings,
        instruction: parsedArgs.instruction,
        baseLeafId,
        isIdle: () => ctx.isIdle(),
        waitForIdle: () => ctx.waitForIdle(),
        navigateToBase: async (targetLeafId, finding) => ctx.navigateTree(targetLeafId, {
            summarize: false,
            label: `task-apply-${finding}`,
        }),
        loadRootIssueMarkdown: () => loadIssueMarkdown(pi, root, workflow.task_id),
        loadRootIssueBodyMarkdown: () => loadIssueBodyMarkdown(pi, root, workflow.task_id),
        runPrompt: async (prompt) => {
            const previousAssistantId = getLastAssistantMessage(ctx)?.id ?? null;
            const ran = await runTaskPrompt(pi, ctx, prompt);
            if (!ran) {
                return {error: "Task apply prompt did not start."};
            }

            await waitForNewAssistantMessage(ctx, previousAssistantId);

            if (agentEndLooksLikeErrorFromSession(ctx)) {
                return {error: "Task apply prompt ended with an agent error."};
            }

            const captured = captureAssistantTurnMessage(ctx, previousAssistantId);
            if ("error" in captured) {
                return {error: captured.error};
            }

            return captured;
        },
        consumeAssistantMessage: async (assistantMessageId) => {
            const latestWorkflow = loadWorkflow(root);
            if ("error" in latestWorkflow) {
                return {error: latestWorkflow.error};
            }

            const consumed = persistConsumedAssistantMessageId(root, latestWorkflow.workflow, assistantMessageId);
            if ("error" in consumed) {
                return {error: consumed.error};
            }

            return {ok: true};
        },
        notify: (message, level) => ctx.ui.notify(message, level),
    });
}

function getLastAssistantMessage(ctx: ExtensionContext): {id: string | null; text: string} | null {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i] as {type?: string; id?: unknown; message?: unknown};
        if (entry.type !== "message") continue;
        const message = entry.message as { role?: string; content?: unknown };
        if (message.role !== "assistant") continue;

        const id = typeof entry.id === "string" ? entry.id : null;
        return {id, text: extractMessageText(message.content)};
    }
    return null;
}

async function waitForNewAssistantMessage(
    ctx: ExtensionContext,
    previousAssistantId: string | null,
    timeoutMs = 1500,
    pollMs = 50,
): Promise<void> {
    if (!previousAssistantId) {
        if (ENABLE_TRANSITION_DEBUG) {
            ctx.ui.notify("transition-capture: no previous assistant id; skipping new-message wait", "info");
        }
        return;
    }

    if (ENABLE_TRANSITION_DEBUG) {
        ctx.ui.notify(`transition-capture: waiting for new assistant message after ${previousAssistantId}`, "info");
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const latest = getLastAssistantMessage(ctx);
        if (latest && latest.id && latest.id !== previousAssistantId) {
            if (ENABLE_TRANSITION_DEBUG) {
                ctx.ui.notify(`transition-capture: detected new assistant message ${latest.id}`, "info");
            }
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    if (ENABLE_TRANSITION_DEBUG) {
        const latest = getLastAssistantMessage(ctx);
        ctx.ui.notify(
            `transition-capture: timed out waiting for new assistant message; latest=${latest?.id ?? "(none)"}`,
            "warning",
        );
    }
}

function extractMessageText(content: unknown): string {
    const seen = new Set<unknown>();

    const walk = (value: unknown): string[] => {
        if (typeof value === "string") {
            return [value];
        }

        if (!value || typeof value !== "object") {
            return [];
        }

        if (seen.has(value)) {
            return [];
        }
        seen.add(value);

        if (Array.isArray(value)) {
            return value.flatMap((item) => walk(item));
        }

        const obj = value as Record<string, unknown>;
        const parts: string[] = [];

        if (typeof obj.text === "string") {
            parts.push(obj.text);
        }

        for (const key of ["content", "parts", "messages", "items", "output", "result"]) {
            if (key in obj) {
                parts.push(...walk(obj[key]));
            }
        }

        return parts;
    };

    return walk(content).join("");
}

/**
 * Main workspace flow:
 * 1. Check for completed task workspaces and offer to merge
 * 2. Select a root GitHub issue to start
 * 3. Create task workspace
 */
async function runMainWorkspace(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    root: string,
    workflowKind: WorkflowKind,
): Promise<void> {
    clearTaskUi(ctx);

    // Loop: merge completed workspaces
    while (await maybeMergeCompletedWorkspace(pi, ctx, root)) {
        // Continue merging until none left or user skips
    }

    // Select and start a new task
    await selectAndStartTask(pi, ctx, root, workflowKind);
}

async function deleteTaskWorkspaceFromMain(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    root: string,
): Promise<void> {
    clearTaskUi(ctx);

    const workspaceNames = await listWorkspaceNames(pi, ctx);
    if (workspaceNames.length === 0) {
        ctx.ui.notify("No task workspaces found.", "info");
        return;
    }

    const repo = path.basename(root);
    const taskWorkspaces: Array<{ name: string; wsPath: string }> = [];

    for (const name of workspaceNames) {
        if (name === "default") {
            continue;
        }

        const wsPath = path.join(os.homedir(), ".workspaces", name, repo);
        if (!fs.existsSync(wsPath)) {
            continue;
        }

        taskWorkspaces.push({name, wsPath});
    }

    if (taskWorkspaces.length === 0) {
        ctx.ui.notify("No task workspaces found for this repository.", "info");
        return;
    }

    taskWorkspaces.sort((a, b) => a.name.localeCompare(b.name));

    const choices = taskWorkspaces.map((workspace) => workspace.name);
    choices.push("Cancel");

    const selection = await ctx.ui.select("Select a task workspace to delete:", choices);
    if (!selection || selection === "Cancel") {
        return;
    }

    const selected = taskWorkspaces.find((workspace) => workspace.name === selection);
    if (!selected) {
        ctx.ui.notify(`Workspace not found: ${selection}`, "error");
        return;
    }

    const confirmDelete = await ctx.ui.confirm(
        "Delete workspace?",
        `Delete jj workspace "${selected.name}" and remove ${path.dirname(selected.wsPath)}?`,
    );
    if (!confirmDelete) {
        return;
    }

    const deleted = await deleteTaskWorkspace(pi, ctx, root, selected.name, selected.wsPath);
    if (!deleted) {
        return;
    }

    ctx.ui.notify(`Deleted workspace: ${selected.name}`, "info");
}

/**
 * Task workspace flow
 */
async function runTaskWorkspace(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    root: string,
): Promise<void> {
    const agentDir = getAgentDir();

    while (true) {
        if (!ctx.isIdle()) {
            await ctx.waitForIdle();
        }

        const loaded = loadWorkflow(root);
        if ("error" in loaded) {
            ctx.ui.notify(loaded.error, "error");
            return;
        }

        let workflow = loaded.workflow;

        const leafId = ctx.sessionManager.getLeafId();
        if (!leafId) {
            ctx.ui.notify("No session leaf ID available", "error");
            return;
        }

        if (workflow.session_leaf_id === UNBOUND_SESSION_LEAF_ID) {
            const updated = cloneWorkflow(workflow);
            updated.session_leaf_id = leafId;
            updated.updated_at = new Date().toISOString();
            const saved = saveWorkflowAtomic(root, updated);
            if (saved.ok === false) {
                ctx.ui.notify(`Failed to bind workflow session leaf id: ${saved.error}`, "error");
                return;
            }
            workflow = updated;
            ctx.ui.notify(`workflow: bound session_leaf_id to current session leaf ${leafId}`, "info");
        } else if (
            workflow.session_leaf_id !== leafId
            && workflow.version === 1
            && workflow.state === "refine"
            && workflow.active_task_id === workflow.task_id
            && workflow.last_transition?.event === "initialize"
        ) {
            // Compatibility path for workspaces initialized before session_leaf_id was set to "unbound".
            const updated = cloneWorkflow(workflow);
            updated.session_leaf_id = leafId;
            updated.updated_at = new Date().toISOString();
            const saved = saveWorkflowAtomic(root, updated);
            if (saved.ok === false) {
                ctx.ui.notify(`Failed to rebind initial workflow session leaf id: ${saved.error}`, "error");
                return;
            }
            workflow = updated;
            ctx.ui.notify(`workflow: rebound initial session_leaf_id to current session leaf ${leafId}`, "info");
        } else if (workflow.session_leaf_id !== leafId) {
            ctx.ui.notify(
                `workflow: current session leaf is ${leafId}; resuming from stored workflow leaf ${workflow.session_leaf_id}`,
                "info",
            );
        }

        const withSessionFile = persistSessionFilePath(root, workflow, ctx.sessionManager.getSessionFile());
        if ("error" in withSessionFile) {
            ctx.ui.notify(`Failed to update workflow session file path: ${withSessionFile.error}`, "error");
            return;
        }
        workflow = withSessionFile.workflow;

        await updateTaskUiDisplay(pi, ctx, workflow);
        writeTaskStateProjection(ctx, workflow);

        if (workflow.state === "complete") {
            ctx.ui.notify(`${workflow.workflow_kind === "fix" ? "Fix" : "Task"} workflow already complete. Workspace is ready to merge.`, "info");
            return;
        }

        const replayed = await replayPendingAssistantTransition(pi, ctx, root, workflow);
        if ("error" in replayed) {
            ctx.ui.notify(replayed.error, "error");
            return;
        }
        workflow = replayed.workflow;
        if (replayed.changed) {
            continue;
        }

        const taskLoad = loadWorkflowPrompt(workflow.workflow_kind, workflow.state, root, agentDir);
        if ("error" in taskLoad) {
            ctx.ui.notify(`${taskLoad.error}\nSearched:\n${taskLoad.searched.join("\n")}`, "error");
            return;
        }

        const {frontmatter, body} = parseFrontmatter<Record<string, unknown>>(taskLoad.content);
        const trimmedBody = body.trim();
        if (!trimmedBody) {
            ctx.ui.notify(`Task prompt ${taskLoad.path} is empty`, "error");
            return;
        }

        await applyTaskFrontmatter(pi, ctx, frontmatter, taskLoad.path);

        let navigation;
        try {
            navigation = await ctx.navigateTree(workflow.session_leaf_id, {summarize: false});
        } catch (error) {
            const currentLeafId = ctx.sessionManager.getLeafId();
            if (currentLeafId && currentLeafId !== workflow.session_leaf_id) {
                const confirm = await ctx.ui.confirm(
                    "Update workflow leaf ID?",
                    `Failed to navigate to stored workflow leaf ${workflow.session_leaf_id}.\n\nThis usually means the workflow was resumed in a different Pi session.\n\nUpdate workflow.session_leaf_id to current session leaf ${currentLeafId} so the workflow can continue?`,
                );

                if (confirm) {
                    const updated = cloneWorkflow(workflow);
                    updated.session_leaf_id = currentLeafId;
                    updated.updated_at = new Date().toISOString();
                    const saved = saveWorkflowAtomic(root, updated);
                    if (saved.ok === false) {
                        ctx.ui.notify(`Failed to update workflow session leaf id: ${saved.error}`, "error");
                        return;
                    }
                    ctx.ui.notify(
                        `workflow: updated session_leaf_id ${workflow.session_leaf_id} -> ${currentLeafId}`,
                        "info",
                    );
                    continue;
                }
            }

            ctx.ui.notify(`Failed to navigate to workflow leaf ${workflow.session_leaf_id}: ${error}`, "error");
            return;
        }

        if (navigation.cancelled) {
            return;
        }

        const issueContext = await buildIssueContextMarkdownFromIds(pi, ctx, root, workflow.active_path_ids);
        if (issueContext === null) {
            return;
        }

        const header = buildTaskIssueHandlingHeader({
            workflowKind: workflow.workflow_kind,
            workflowVersion: workflow.version,
            workflowState: workflow.state,
            manualTestStatus: workflow.manual_test_status,
            activeIssueId: workflow.active_task_id,
            activePathIds: workflow.active_path_ids,
        });
        const manualTestFollowupContext = await buildManualTestFollowupContextMarkdown(pi, root, workflow);
        const issueContextWithWorkflowMetadata = manualTestFollowupContext
            ? `${issueContext}\n\n---\n\n${manualTestFollowupContext.trimEnd()}`
            : issueContext;
        const fullMessage = `${header}\n\n${issueContextWithWorkflowMetadata}\n\n---\n\n${trimmedBody}`;

        const previousAssistantId = getLastAssistantMessage(ctx)?.id ?? null;
        if (ENABLE_TRANSITION_DEBUG) {
            ctx.ui.notify(
                `transition-capture: state=${workflow.state} version=${workflow.version} previous-assistant=${previousAssistantId ?? "(none)"}`,
                "info",
            );
        }

        const withPendingPromptRun = persistPendingPromptRun(root, workflow, {
            state: workflow.state,
            active_task_id: workflow.active_task_id,
            session_leaf_id: workflow.session_leaf_id,
            previous_assistant_id: previousAssistantId,
            started_at: new Date().toISOString(),
        });
        if ("error" in withPendingPromptRun) {
            ctx.ui.notify(withPendingPromptRun.error, "error");
            return;
        }
        workflow = withPendingPromptRun.workflow;

        applyTaskPromptFastMode(
            pi,
            (message, level) => ctx.ui.notify(message, level),
            frontmatter,
            taskLoad.path,
        );

        const ran = await runTaskPrompt(pi, ctx, fullMessage);
        if (!ran) {
            return;
        }

        await waitForNewAssistantMessage(ctx, previousAssistantId);

        if (agentEndLooksLikeErrorFromSession(ctx)) {
            ctx.ui.notify(`Agent turn ended with an error; fix the issue and run /${workflow.workflow_kind} to resume.`, "warning");
            return;
        }

        const captured = captureAssistantTurnMessage(ctx, previousAssistantId);
        if ("error" in captured) {
            ctx.ui.notify(captured.error, "error");
            return;
        }

        const transition = await dispatchWorkflowEvent(
            pi,
            ctx,
            root,
            workflow,
            {
                type: "COMPLETE",
                completedState: workflow.state,
                assistantMessage: captured.assistantMessage,
                rootIssueMarkdown: "",
            },
        );

        if ("error" in transition) {
            ctx.ui.notify(transition.error, "error");
            return;
        }

        const consumed = persistConsumedAssistantMessageId(root, transition.workflow, captured.assistantMessageId);
        if ("error" in consumed) {
            ctx.ui.notify(consumed.error, "error");
            return;
        }

        const clearedPending = persistPendingPromptRun(root, consumed.workflow, null);
        if ("error" in clearedPending) {
            ctx.ui.notify(clearedPending.error, "error");
            return;
        }

        const completionNotice = completionReadyToMergeNotice({
            changed: transition.changed,
            nextState: clearedPending.workflow.state,
            workflowKind: clearedPending.workflow.workflow_kind,
        });
        if (completionNotice) {
            ctx.ui.notify(completionNotice, "info");
        }

        const shouldContinue = transition.changed && clearedPending.workflow.state !== "complete";

        if (ENABLE_TRANSITION_DEBUG) {
            ctx.ui.notify(
                `transition-capture: dispatch result changed=${transition.changed ? "yes" : "no"} continue=${shouldContinue ? "yes" : "no"}`,
                "info",
            );
        }

        if (!shouldContinue) {
            if (clearedPending.workflow.state === "manual-test") {
                ctx.ui.notify(`Manual verification is still in progress. When it is complete, have the agent emit <transition>commit</transition> and then run /${workflow.workflow_kind} again.`, "info");
            }
            return;
        }
    }
}

async function runTaskPrompt(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    fullMessage: string
): Promise<boolean> {
    let startPromise: Promise<boolean>;
    try {
        startPromise = waitForNextAgentStart();
    } catch (error) {
        ctx.ui.notify(`Failed to wait for agent_start: ${error}`, "error");
        return false;
    }

    pi.sendUserMessage(fullMessage);

    const started = await startPromise;
    if (!started) {
        ctx.ui.notify("Timed out waiting for agent_start", "error");
        return false;
    }

    await ctx.waitForIdle();
    return true;
}

/**
 * Check for completed task workspaces and offer to merge one
 * Returns true if a merge happened (so caller can loop)
 */
async function workspaceReadyToMergeFromWorkflow(
    wsPath: string,
    githubConfig: GitHubClientConfig,
): Promise<boolean> {
    const loaded = loadWorkflow(wsPath);
    if ("error" in loaded) {
        return false;
    }

    const workflow = loaded.workflow;
    if (workflow.state !== "complete") {
        return false;
    }

    const issueNumber = parseIssueNumberFromTaskId(workflow.task_id);
    if (!issueNumber) {
        return false;
    }

    try {
        const issue = await getIssueByNumber(githubConfig, issueNumber);
        return issue?.state === "CLOSED";
    } catch {
        return false;
    }
}

async function maybeMergeCompletedWorkspace(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    root: string
): Promise<boolean> {
    const workspaceNames = await listWorkspaceNames(pi, ctx);
    if (workspaceNames.length === 0) {
        return false;
    }

    const repo = path.basename(root);
    const mainCommitId = await getMainWorkspaceCommitId(pi, ctx);
    if (!mainCommitId) {
        return false;
    }

    const githubConfigResult = await resolveGitHubClientConfig(pi, root);
    if ("error" in githubConfigResult) {
        ctx.ui.notify(`Failed to verify merge readiness from GitHub: ${githubConfigResult.error}`, "error");
        return false;
    }

    const mergeableWorkspaces: Array<{ name: string; wsPath: string }> = [];
    for (const name of workspaceNames) {
        if (name === "default") {
            continue;
        }

        const wsPath = path.join(os.homedir(), ".workspaces", name, repo);
        if (!fs.existsSync(wsPath)) {
            continue;
        }

        const workflowReady = await workspaceReadyToMergeFromWorkflow(wsPath, githubConfigResult.config);
        if (!workflowReady) {
            continue;
        }

        const hasUnmerged = await workspaceHasUnmergedCommits(pi, ctx, wsPath, mainCommitId);
        if (!hasUnmerged) {
            continue;
        }

        mergeableWorkspaces.push({name, wsPath});
    }

    if (mergeableWorkspaces.length === 0) {
        return false;
    }

    const choices = mergeableWorkspaces.map((ws) => ws.name);
    choices.push("Skip merge");

    const selection = await ctx.ui.select(
        "Task workspaces ready to merge:",
        choices
    );

    if (!selection || selection === "Skip merge") {
        return false;
    }

    const selected = mergeableWorkspaces.find((ws) => ws.name === selection);
    if (!selected) {
        return false;
    }

    const confirmMerge = await ctx.ui.confirm(
        "Merge workspace?",
        `Merge "${selected.name}" into main?`
    );

    if (!confirmMerge) {
        return false;
    }

    const mergeSuccess = await mergeDoneTaskWorkspace(pi, ctx, root, selected.name, selected.wsPath);
    if (!mergeSuccess) {
        return false;
    }

    ctx.ui.notify(`Merged workspace: ${selected.name}`, "info");

    const confirmDelete = await ctx.ui.confirm(
        "Delete workspace?",
        `Delete jj workspace "${selected.name}"?`
    );

    if (confirmDelete) {
        const deleted = await deleteTaskWorkspace(pi, ctx, root, selected.name, selected.wsPath);
        if (deleted) {
            ctx.ui.notify(`Deleted workspace: ${selected.name}`, "info");
        }
    }

    return true;
}

/**
 * Merge a completed task workspace into main
 */
async function mergeDoneTaskWorkspace(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    root: string,
    name: string,
    wsPath: string
): Promise<boolean> {
    // Refuse to merge if the main workspace has pending changes.
    const mainDiff = await pi.exec("jj", ["diff"], {cwd: root});
    if (mainDiff.code !== 0) {
        ctx.ui.notify(`Failed to check main workspace diff: ${mainDiff.stderr}`, "error");
        return false;
    }
    if (mainDiff.stdout.trim().length > 0) {
        ctx.ui.notify("Main workspace has uncommitted changes; commit or discard them before merging a task workspace.", "error");
        return false;
    }

    // Find the latest non-empty commit in the task workspace.
    const taskHeadResult = await pi.exec(
        "jj",
        [
            "log",
            "-R",
            wsPath,
            "--ignore-working-copy",
            "-r",
            "latest(::@ & ~empty(), 1)",
            "-T",
            "commit_id",
            "--no-graph",
            "--limit",
            "1",
        ],
        {cwd: root},
    );

    const taskHeadCommitId = taskHeadResult.stdout.trim();
    if (taskHeadResult.code !== 0 || !taskHeadCommitId) {
        ctx.ui.notify(`Failed to find task head commit for ${name}`, "error");
        return false;
    }

    // Revset of all non-empty commits that are part of the task branch relative to current main @-.
    // Use commit_id() (not change_id()) so we only follow the selected task-head lineage
    // and avoid pulling in divergent rewrites of the same change id.
    const taskBranchRevset = buildTaskBranchRevsetFromTaskHeadCommit(taskHeadCommitId);

    const hasTaskCommits = await pi.exec(
        "jj",
        ["log", "-r", taskBranchRevset, "-T", "change_id", "--no-graph", "--limit", "1"],
        {cwd: root},
    );
    if (hasTaskCommits.code !== 0) {
        ctx.ui.notify(`Failed to inspect task commits for ${name}: ${hasTaskCommits.stderr}`, "error");
        return false;
    }
    if (!hasTaskCommits.stdout.trim()) {
        ctx.ui.notify(`No non-empty task commits found to merge for ${name}`, "warning");
        return false;
    }

    // Default squash message to the description of the latest non-empty task commit.
    let defaultMessage = `Merge ${name}`;

    const descResult = await pi.exec(
        "jj",
        [
            "log",
            "-R",
            wsPath,
            "--ignore-working-copy",
            "-r",
            `commit_id(${taskHeadCommitId})`,
            "-T",
            "description",
            "--no-graph",
            "--limit",
            "1",
        ],
        {cwd: root},
    );

    if (descResult.code === 0) {
        const desc = descResult.stdout.trimEnd();
        if (desc.trim().length > 0) {
            defaultMessage = desc;
        }
    }

    const messageInput = await ctx.ui.editor("Squash merge commit message:", defaultMessage);
    const messageResult = resolveEditorDialogValue(messageInput, defaultMessage);
    if (messageResult.cancelled) {
        ctx.ui.notify("Squash merge cancelled.", "info");
        return false;
    }
    const message = messageResult.value;

    // Create a single squashed commit after @- containing all task changes.
    // `-A @-` also rebases children of @- (including @) onto the new squashed commit,
    // so we don't need a separate rebase step.
    ctx.ui.notify("squash-merge: creating squashed commit on main (insert-after @-)", "info");
    const squashResult = await pi.exec(
        "jj",
        ["squash", "-A", "@-", "-m", message, "--from", taskBranchRevset],
        {cwd: root},
    );
    if (squashResult.code !== 0) {
        ctx.ui.notify(`Squash merge failed: ${squashResult.stderr}`, "error");
        return false;
    }

    return true;
}

async function listWorkspaceNames(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext
): Promise<string[]> {
    const wsListResult = await pi.exec("jj", ["workspace", "list"]);
    if (wsListResult.code !== 0) {
        ctx.ui.notify("Failed to list workspaces", "error");
        return [];
    }

    return wsListResult.stdout
        .split("\n")
        .map((line) => line.replace(/:.*$/, "").trim())
        .filter((name) => name.length > 0);
}

async function getMainWorkspaceCommitId(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext
): Promise<string> {
    const result = await pi.exec("jj", [
        "log",
        "-r",
        "@-",
        "-T",
        "commit_id",
        "--no-graph",
        "--limit",
        "1",
    ]);
    if (result.code !== 0 || !result.stdout.trim()) {
        ctx.ui.notify("Failed to read main workspace head", "error");
        return "";
    }

    return result.stdout.trim();
}

async function workspaceHasUnmergedCommits(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    wsPath: string,
    mainCommitId: string
): Promise<boolean> {
    // Look for any non-empty commits in the task workspace that are not ancestors of the main head.
    // We inspect the whole ancestry of @ because @ itself is often an empty post-commit change.
    const revset = `::@ & ~ancestors(${mainCommitId}) & ~empty()`;
    const result = await pi.exec("jj", [
        "log",
        "-R",
        wsPath,
        "--ignore-working-copy",
        "-r",
        revset,
        "-T",
        "change_id",
        "--no-graph",
        "--limit",
        "1",
    ]);

    if (result.code !== 0) {
        ctx.ui.notify(`Failed to check workspace commits: ${wsPath}`, "error");
        return false;
    }

    return result.stdout.trim().length > 0;
}

async function listInProgressRootTaskIdsAcrossWorkspaces(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    root: string
): Promise<Set<string>> {
    const workspaceNames = await listWorkspaceNames(pi, ctx);
    const repo = path.basename(root);
    const ids = new Set<string>();

    // Workspaces created by /task live under: ~/.workspaces/<workspace-name>/<repo>
    // and each task workspace has .tasks/workflow.json as source of truth.
    const baseDir = path.join(os.homedir(), ".workspaces");

    for (const name of workspaceNames) {
        if (name === "default") {
            continue;
        }

        const wsPath = path.join(baseDir, name, repo);
        if (!fs.existsSync(wsPath)) {
            continue;
        }

        const loaded = loadWorkflow(wsPath);
        if ("error" in loaded) {
            continue;
        }

        const workflow = loaded.workflow;
        const inProgressRootIssueId = inProgressRootIssueIdFromWorkflow({
            workflowState: workflow.state,
            rootTaskId: workflow.task_id,
        });

        if (!inProgressRootIssueId) {
            if (workflow.state !== "complete") {
                ctx.ui.notify(`Warning: ignoring workspace ${name}; invalid workflow root issue id: ${workflow.task_id}`, "warning");
            }
            continue;
        }

        ids.add(inProgressRootIssueId);
    }

    return ids;
}

type ReadyIssue = WorkflowIssueSummary;

async function listReadyIssues(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    root: string
): Promise<ReadyIssue[] | null> {
    const result = await listWorkflowIssueSummaries(pi, root);
    if ("error" in result) {
        ctx.ui.notify(`Failed to get ready issues: ${result.error}`, "error");
        return null;
    }

    const issues = result.items;
    if (issues.length === 0) {
        return [];
    }

    return issues.filter((issue) => {
        if (issue.parent && issue.parent.trim()) {
            return false;
        }
        return issue.status === "open" || issue.status === "in_progress";
    });
}

function parseCreatedTimestamp(created?: string): number {
    if (!created) return 0;
    const parsed = Date.parse(created);
    return Number.isFinite(parsed) ? parsed : 0;
}

function formatReadyIssueLine(issue: ReadyIssue): string {
    const paddedId = issue.id.padEnd(8, " ");
    return `${paddedId} [${issue.status}] - ${issue.title}`;
}

async function loadIssueMarkdown(pi: ExtensionAPI, cwd: string, id: string): Promise<{ content: string } | {
    error: string
}> {
    const showResult = await loadWorkflowIssueMarkdown(pi, cwd, id, true);
    if ("error" in showResult) {
        return {error: `Failed to read issue ${id}: ${showResult.error}`};
    }
    return {content: showResult.content};
}

async function loadIssueBodyMarkdown(pi: ExtensionAPI, cwd: string, id: string): Promise<{ content: string } | {
    error: string
}> {
    const showResult = await loadWorkflowIssueMarkdown(pi, cwd, id, false);
    if ("error" in showResult) {
        return {error: `Failed to read issue ${id}: ${showResult.error}`};
    }
    return {content: showResult.content};
}

async function buildIssueContextMarkdownFromIds(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    cwd: string,
    pathIds: string[],
): Promise<string | null> {
    if (pathIds.length === 0) {
        ctx.ui.notify("Workflow active path is empty", "error");
        return null;
    }

    const chunks: string[] = [];
    for (const id of pathIds) {
        const load = await loadIssueMarkdown(pi, cwd, id);
        if ("error" in load) {
            ctx.ui.notify(load.error, "warning");
            return null;
        }
        chunks.push(load.content.trim());
    }

    return chunks.join("\n\n---\n\n");
}

async function applyTaskFrontmatter(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    frontmatter: Record<string, unknown>,
    sourcePath: string
): Promise<void> {
    const modelName = frontmatter.model;
    if (typeof modelName === "string" && modelName) {
        const resolved = resolveModelPattern(modelName, ctx.modelRegistry.getAll());
        if (!resolved) {
            ctx.ui.notify(`Unknown model "${modelName}" in ${sourcePath}`, "error");
        } else {
            const success = await pi.setModel(resolved);
            if (!success) {
                ctx.ui.notify(`No API key available for model "${modelName}"`, "error");
            }
        }
    }

    const thinking = frontmatter.thinking;
    if (typeof thinking === "string" && thinking) {
        const normalized = thinking.trim().toLowerCase();
        const allowed = new Set(["off", "minimal", "low", "medium", "high"]);
        if (!allowed.has(normalized)) {
            ctx.ui.notify(`Invalid thinking level "${thinking}" in ${sourcePath}`, "error");
        } else {
            pi.setThinkingLevel(normalized as "off" | "minimal" | "low" | "medium" | "high");
        }
    }
}

type TaskPromptFastModePi = {
    events?: {
        emit: (event: string, payload: unknown) => void;
    };
};

type TaskPromptFastModeNotify = (message: string, level: "info" | "warning" | "error") => void;

function parseTaskPromptFastValue(value: unknown): {enabled: boolean} | {error: string} {
    if (value === true || value === false) {
        return {enabled: value};
    }

    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true") {
            return {enabled: true};
        }
        if (normalized === "false") {
            return {enabled: false};
        }
    }

    return {error: `Invalid fast value "${String(value)}"`};
}

export function applyTaskPromptFastMode(
    pi: TaskPromptFastModePi,
    notify: TaskPromptFastModeNotify,
    frontmatter: Record<string, unknown>,
    sourcePath: string,
): void {
    if (!Object.prototype.hasOwnProperty.call(frontmatter, "fast")) {
        return;
    }

    const parsed = parseTaskPromptFastValue(frontmatter.fast);
    if ("error" in parsed) {
        notify(`${parsed.error} in ${sourcePath}; expected true or false`, "error");
        return;
    }

    pi.events?.emit("pi-codex:fast:set", {
        enabled: parsed.enabled,
        source: "pi-task",
        notify: true,
    });
}

function resolveModelPattern(modelName: string, models: AvailableModel[]): AvailableModel | undefined {
    const normalized = modelName.trim();
    if (!normalized) return undefined;

    const slashIndex = normalized.indexOf("/");
    if (slashIndex !== -1) {
        const provider = normalized.slice(0, slashIndex).toLowerCase();
        const modelId = normalized.slice(slashIndex + 1).toLowerCase();
        const match = models.find(
            (model) => model.provider.toLowerCase() === provider && model.id.toLowerCase() === modelId,
        );
        if (match) return match;
    }

    const exact = models.find((model) => model.id.toLowerCase() === normalized.toLowerCase());
    if (exact) return exact;

    const matches = models.filter(
        (model) =>
            model.id.toLowerCase().includes(normalized.toLowerCase()) ||
            (model.name && model.name.toLowerCase().includes(normalized.toLowerCase())),
    );
    if (matches.length === 0) return undefined;

    const isAlias = (id: string) => id.endsWith("-latest") || !/-\d{8}$/.test(id);
    const aliases = matches.filter((model) => isAlias(model.id));
    if (aliases.length > 0) {
        return aliases.sort((a, b) => b.id.localeCompare(a.id))[0];
    }

    return matches.sort((a, b) => b.id.localeCompare(a.id))[0];
}

/**
 * Delete a task workspace (jj forget + rm directory)
 */
async function deleteTaskWorkspace(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    root: string,
    name: string,
    wsPath: string
): Promise<boolean> {
    // Forget the workspace in jj
    const forgetResult = await pi.exec("jj", ["workspace", "forget", name]);
    if (forgetResult.code !== 0) {
        ctx.ui.notify(`Failed to forget workspace ${name}: ${forgetResult.stderr}`, "error");
        return false;
    }

    // Safety check: ensure wsPath is under ~/.workspaces/<task-id>/<repo>
    const repo = path.basename(root);
    const normalizedPath = stripPrivatePrefix(wsPath);
    const normalizedHome = stripPrivatePrefix(os.homedir());
    const base = path.join(normalizedHome, ".workspaces");
    const rel = path.relative(base, normalizedPath);
    const parts = rel.split(path.sep).filter(Boolean);

    if (rel.startsWith("..") || path.isAbsolute(rel) || parts.length !== 2 || parts[1] !== repo) {
        ctx.ui.notify(`Refusing to delete non-workspace path: ${wsPath}`, "error");
        return false;
    }

    // Delete the task ID directory (parent of wsPath)
    const taskIdDir = path.dirname(wsPath);
    if (fs.existsSync(taskIdDir)) {
        fs.rmSync(taskIdDir, {recursive: true, force: true});
    }

    return true;
}

/**
 * Select an open root GitHub issue and create a workspace for it
 */
async function selectAndStartTask(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    root: string,
    workflowKind: WorkflowKind,
): Promise<void> {
    const readyIssues = await listReadyIssues(pi, ctx, root);
    if (!readyIssues) {
        return;
    }

    const openReadyIssues = readyIssues.filter((issue) => issue.status === "open");
    if (openReadyIssues.length === 0) {
        ctx.ui.notify("No open root issues available to start.", "info");
        return;
    }

    const inProgressTaskIds = await listInProgressRootTaskIdsAcrossWorkspaces(pi, ctx, root);

    const selectableIssues = openReadyIssues.filter((issue) => !inProgressTaskIds.has(issue.id));
    if (selectableIssues.length === 0) {
        ctx.ui.notify("No open root issues available to start.", "info");
        return;
    }

    selectableIssues.sort((a, b) => {
        const aCreated = parseCreatedTimestamp(a.created);
        const bCreated = parseCreatedTimestamp(b.created);
        if (aCreated !== bCreated) {
            return bCreated - aCreated;
        }
        return a.id.localeCompare(b.id);
    });

    const readyLines = selectableIssues.map((issue) => formatReadyIssueLine(issue));

    // Let user select a task
    const selection = await ctx.ui.select(`Select a ${workflowKind} to start:`, readyLines);
    if (!selection) {
        return;
    }

    // Parse the issue ID and title from the selection (format: "123      [open] - Title")
    const issueId = selection.split(/\s+/)[0];
    if (!issueId) {
        ctx.ui.notify("Failed to parse issue ID", "error");
        return;
    }

    // Extract title from the selection line (after " - ")
    const titleMatch = selection.match(/ - (.+)$/);
    const issueTitle = titleMatch ? titleMatch[1] : issueId;

    // Create slug from title
    const slugDefault = slugify(issueTitle);
    const slugInput = await ctx.ui.editor(`${workflowKind === "fix" ? "Fix" : "Task"} slug:`, slugDefault);
    const slugResult = resolveEditorDialogValue(slugInput, slugDefault, {singleLine: true});
    if (slugResult.cancelled) {
        ctx.ui.notify("Task start cancelled.", "info");
        return;
    }
    const slug = slugResult.value;

    // Create task ID with timestamp (needed for commit message)
    const taskId = `${formatTaskIdTimestamp(new Date())}-${slug}`;

    // Create workspace path
    const repo = path.basename(root);
    const wsPath = path.join(os.homedir(), ".workspaces", taskId, repo);

    // Mark the issue before creating local workspace state, so GitHub failures do not leave
    // a half-initialized jj workspace behind.
    const startResult = await markWorkflowIssueInProgress(pi, root, issueId);
    if (startResult.ok === false) {
        ctx.ui.notify(`Failed to set issue to in_progress: ${startResult.error}`, "error");
        return;
    }

    const parentDirectory = createTaskWorkspaceParentDirectory(wsPath);
    if (parentDirectory.ok === false) {
        ctx.ui.notify(formatWorkspaceCreationFailureMessage(parentDirectory.error), "error");
        return;
    }

    // Create jj workspace from the current working copy commit.
    const wsAddResult = await pi.exec("jj", [
        "workspace", "add",
        "--name", taskId,
        "-r", "@",
        wsPath,
    ]);

    if (wsAddResult.code !== 0) {
        ctx.ui.notify(formatWorkspaceCreationFailureMessage(wsAddResult.stderr), "error");
        return;
    }

    // Symlink .reference directory if it exists in the main workspace
    const referenceDir = path.join(root, ".reference");
    if (fs.existsSync(referenceDir)) {
        const targetLink = path.join(wsPath, ".reference");
        try {
            fs.symlinkSync(referenceDir, targetLink);
        } catch (err) {
            ctx.ui.notify(`Warning: Failed to symlink .reference: ${err}`, "warning");
        }
    }

    // Symlink .issues directory if it exists in the main workspace
    const issuesDir = path.join(root, ".issues");
    if (fs.existsSync(issuesDir)) {
        const targetLink = path.join(wsPath, ".issues");
        try {
            fs.symlinkSync(issuesDir, targetLink);
        } catch (err) {
            ctx.ui.notify(`Warning: Failed to symlink .issues: ${err}`, "warning");
        }
    }

    // Symlink sdks directory if it exists in the main workspace (often itself a symlink to ~/.sdks)
    const sdksDir = path.join(root, "sdks");
    if (fs.existsSync(sdksDir)) {
        const targetLink = path.join(wsPath, "sdks");
        try {
            fs.symlinkSync(sdksDir, targetLink);
        } catch (err) {
            ctx.ui.notify(`Warning: Failed to symlink sdks: ${err}`, "warning");
        }
    }

    const initialWorkflow = createInitialWorkflow(
        workflowKind,
        issueId,
        issueTitle,
        UNBOUND_SESSION_LEAF_ID,
    );
    const savedWorkflow = saveWorkflowAtomic(wsPath, initialWorkflow);
    if (savedWorkflow.ok === false) {
        ctx.ui.notify(`Failed to initialize workflow file: ${savedWorkflow.error}. Remove the partial workspace with /task delete.`, "error");
        return;
    }
    ctx.ui.notify(`Initialized workflow file: ${getWorkflowPath(wsPath)}`, "info");

    // Display success message
    ctx.ui.notify(`${workflowKind === "fix" ? "Fix" : "Task"} workspace created: ${wsPath}`, "info");

    await launchTaskWorkspace({
        workspacePath: wsPath,
        slug,
        env: process.env,
        exec: (command, args) => pi.exec(command, args),
        notify: (message, level) => ctx.ui.notify(message, level),
    });
}

export function formatWorkspaceCreationFailureMessage(stderr: string): string {
    const details = stderr.trim() || "unknown error";
    return `Failed to create workspace: ${details}. If a partial task workspace exists, remove it with /task delete. The GitHub issue may still have the ${IN_PROGRESS_LABEL} label; remove that label manually before retrying if no workspace was created.`;
}

export function createTaskWorkspaceParentDirectory(wsPath: string): {ok: true} | {ok: false; error: string} {
    try {
        fs.mkdirSync(path.dirname(wsPath), {recursive: true});
        return {ok: true};
    } catch (error) {
        return {ok: false, error: `Failed to create workspace parent directory: ${error}`};
    }
}

function isUnderTaskWorkspacesDirectory(cwd: string): boolean {
    const normalizedCwd = stripPrivatePrefix(path.resolve(cwd));
    const normalizedHome = stripPrivatePrefix(os.homedir());
    const base = path.join(normalizedHome, ".workspaces");
    const rel = path.relative(base, normalizedCwd);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Check if we're in a task workspace (under ~/.workspaces/<task-id>/<repo-name>)
 */
function isTaskWorkspace(root: string): boolean {
    const repo = path.basename(root);
    const normalizedRoot = stripPrivatePrefix(path.resolve(root));
    const normalizedHome = stripPrivatePrefix(os.homedir());
    const base = path.join(normalizedHome, ".workspaces");
    const rel = path.relative(base, normalizedRoot);

    // If rel starts with ".." or is absolute, we're not under .workspaces
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return false;
    }

    // Check structure: should be <task-id>/<repo-name>
    const parts = rel.split(path.sep).filter(Boolean);
    return parts.length === 2 && parts[1] === repo;
}

/**
 * Strip /private prefix (macOS symlink resolution)
 */
function stripPrivatePrefix(value: string): string {
    if (value.startsWith("/private")) {
        return value.slice("/private".length) || "/";
    }
    return value;
}

/**
 * Create a URL-friendly slug from a title
 */
function slugify(title: string): string {
    let value = title.toLowerCase();
    value = value.replace(/[^a-z0-9]+/g, "-");
    value = value.replace(/^-+|-+$/g, "");
    value = value.replace(/-+/g, "-");
    return value || "task";
}

/**
 * Format a date as YYYYMMDD-HHMMSS for task IDs
 */
function formatTaskIdTimestamp(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());
    return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

interface TaskLoadResult {
    content: string;
    path: string;
    source: "project" | "user" | "extension";
}

interface TaskLoadError {
    error: string;
    searched: string[];
}

function workflowPromptLocations(
    workflowKind: WorkflowKind,
    filename: string,
    cwd: string,
    agentDir: string,
    extensionModuleUrl = import.meta.url,
) {
    const extensionPromptPath = workflowKind === "fix" ? `./prompts/fix/${filename}` : `./prompts/${filename}`;
    return [
        {path: path.join(cwd, ".pi", workflowKind, filename), source: "project" as const},
        {path: path.join(agentDir, workflowKind, filename), source: "user" as const},
        {path: fileURLToPath(new URL(extensionPromptPath, extensionModuleUrl)), source: "extension" as const},
    ];
}

function joinTaskPromptChunks(chunks: string[]): string {
    return chunks.map((chunk) => chunk.trimEnd()).join("\n\n");
}

export function loadWorkflowPrompt(
    workflowKind: WorkflowKind,
    name: string,
    cwd: string,
    agentDir: string,
    extensionModuleUrl = import.meta.url,
): TaskLoadResult | TaskLoadError {
    const filename = name.endsWith(".md") ? name : `${name}.md`;
    const locations = workflowPromptLocations(workflowKind, filename, cwd, agentDir, extensionModuleUrl);
    const searched: string[] = [];

    for (const loc of locations) {
        searched.push(loc.path);
        if (!fs.existsSync(loc.path)) {
            continue;
        }

        let baseContent: string;
        try {
            baseContent = fs.readFileSync(loc.path, "utf-8");
        } catch (e) {
            return {error: `Failed to read ${loc.path}: ${e}`, searched};
        }

        const appendFilename = filename.replace(/\.md$/, "-append.md");
        const appendContents: string[] = [];

        for (const appendLoc of workflowPromptLocations(workflowKind, appendFilename, cwd, agentDir, extensionModuleUrl)) {
            searched.push(appendLoc.path);
            if (!fs.existsSync(appendLoc.path)) {
                continue;
            }

            try {
                appendContents.push(fs.readFileSync(appendLoc.path, "utf-8"));
            } catch (e) {
                return {error: `Failed to read ${appendLoc.path}: ${e}`, searched};
            }
        }

        return {
            content: joinTaskPromptChunks([baseContent, ...appendContents]),
            path: loc.path,
            source: loc.source,
        };
    }

    return {error: `${workflowKind === "fix" ? "Fix" : "Task"} "${name}" not found`, searched};
}

export function loadTaskPrompt(
    name: string,
    cwd: string,
    agentDir: string,
    extensionModuleUrl = import.meta.url,
): TaskLoadResult | TaskLoadError {
    return loadWorkflowPrompt("task", name, cwd, agentDir, extensionModuleUrl);
}
