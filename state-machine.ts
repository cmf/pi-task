import {parse as parseYaml} from "yaml";

/**
 * Explicit task workflow state machine used by the task extension shell (index.ts).
 *
 * Design notes:
 * - Transitions are pure and deterministic.
 * - Assistant output parsing happens in the functional core.
 * - The shell interprets emitted effects (tk/jj operations).
 */

export type WorkflowKind = "task" | "fix";
export type ManualTestStatus = "undecided" | "pending" | "passed";

export type WorkflowState =
    | "refine"
    | "plan"
    | "review-plan"
    | "implement"
    | "review"
    | "implement-review"
    | "subtask-commit"
    | "manual-test"
    | "commit"
    | "complete";

export const WORKFLOW_STATES: readonly WorkflowState[] = [
    "refine",
    "plan",
    "review-plan",
    "implement",
    "review",
    "implement-review",
    "subtask-commit",
    "manual-test",
    "commit",
    "complete",
] as const;

export type WorkflowEvent =
    | {
    type: "COMPLETE";
    completedState: WorkflowState;
    rootIssueMarkdown: string;
    assistantMessage: string;
}
    | {
    type: "FORCE_LGTM";
    completedState: WorkflowState;
    /**
     * Root issue markdown at time of force. Required in review-plan.
     */
    rootIssueMarkdown?: string;
}
    | {
    type: "MANUAL_DONE";
    completedState: WorkflowState;
};

export type WorkflowEffect =
    | {
    type: "CREATE_ISSUE";
    parentTaskId: string;
    title: string;
    description: string;
    tdd: boolean;
    /**
     * Idempotency key used by the shell/interpreter to avoid duplicate issues.
     * Suggested semantics: unique on (parentTaskId, title).
     */
    idempotencyKey: string;
}
    | {
    type: "ADD_NOTE";
    taskId: string;
    note: string;
}
    | {
    type: "CLOSE_ISSUE";
    taskId: string;
}
    | {
    type: "RUN_JJ_COMMIT";
    message: string;
};

export type ActiveTaskTarget =
    | { type: "current" }
    | { type: "root" }
    | { type: "parent" }
    | { type: "next-sibling" }
    | { type: "first-created-child"; parentTaskId: string };

export type IssueDraft = {
    title: string;
    description: string;
    tdd: boolean;
};

/**
 * Minimal context the pure machine needs to make deterministic decisions.
 *
 * Notes:
 * - activeTaskParentId / activeTaskNextSiblingId are derived by the shell from the current workflow tree.
 */
export interface WorkflowSnapshot {
    workflowKind?: WorkflowKind;
    manualTestStatus?: ManualTestStatus;
    state: WorkflowState;
    rootTaskId: string;
    activeTaskId: string;
    activeTaskParentId: string | null;
    activeTaskNextSiblingId: string | null;
}

/**
 * Outcome model for callers:
 * - applied: valid transition accepted (including state stays with side effects)
 * - ignored: valid no-op (e.g. interactive turn with no transition tag yet)
 * - rejected: invalid event/state combination or malformed required payload
 */
export type AppliedTransitionDecision = {
    kind: "applied";
    state: WorkflowState;
    activeTaskTarget: ActiveTaskTarget;
    effects: WorkflowEffect[];
    manualTestStatus?: ManualTestStatus;
    reason?: string;
};

export type IgnoredTransitionDecision = {
    kind: "ignored";
    state: WorkflowState;
    activeTaskTarget: ActiveTaskTarget;
    effects: WorkflowEffect[];
    reason?: string;
};

export type RejectedTransitionDecision = {
    kind: "rejected";
    state: WorkflowState;
    activeTaskTarget: ActiveTaskTarget;
    effects: WorkflowEffect[];
    reason: string;
};

export type TransitionDecision =
    | AppliedTransitionDecision
    | IgnoredTransitionDecision
    | RejectedTransitionDecision;

export interface ParsedAssistantOutput {
    requestedState: WorkflowState | null;
    reviewFindings: IssueDraft[];
    manualTestSubtasks: IssueDraft[];
    commitMessage: string | null;
}

export type ParsedAssistantOutputResult =
    | { parsed: ParsedAssistantOutput }
    | { error: string };

export function parseAssistantOutput(
    message: string,
    state?: WorkflowState,
): ParsedAssistantOutputResult {
    const shouldParseReviewFindings = state === undefined || state === "review";
    const reviewFindingsResult = shouldParseReviewFindings
        ? parseIssueDraftListFromTag(message, "review-findings")
        : null;
    const shouldParseManualTestSubtasks = state === "manual-test";
    const manualTestSubtasksResult = shouldParseManualTestSubtasks
        ? parseIssueDraftListFromTag(message, "manual-test-subtasks")
        : null;

    if (reviewFindingsResult && "error" in reviewFindingsResult) {
        return {error: reviewFindingsResult.error};
    }

    if (manualTestSubtasksResult && "error" in manualTestSubtasksResult) {
        return {error: manualTestSubtasksResult.error};
    }

    const requestedStateResult = parseRequestedStateFromAssistantMessage(message);
    if ("error" in requestedStateResult) {
        return {error: requestedStateResult.error};
    }

    return {
        parsed: {
            requestedState: requestedStateResult.state,
            reviewFindings: reviewFindingsResult ? reviewFindingsResult.drafts : [],
            manualTestSubtasks: manualTestSubtasksResult ? manualTestSubtasksResult.drafts : [],
            commitMessage: parseCommitMessageFromAssistantMessage(message),
        },
    };
}

export function canReplayCompleteFromAssistantMessage(
    state: WorkflowState,
    assistantMessage: string,
): boolean;
export function canReplayCompleteFromAssistantMessage(
    workflowKind: WorkflowKind,
    state: WorkflowState,
    assistantMessage: string,
): boolean;
export function canReplayCompleteFromAssistantMessage(
    kindOrState: WorkflowKind | WorkflowState,
    stateOrMessage: WorkflowState | string,
    maybeMessage?: string,
): boolean {
    const workflowKind: WorkflowKind = maybeMessage === undefined ? "task" : kindOrState as WorkflowKind;
    const state: WorkflowState = maybeMessage === undefined ? kindOrState as WorkflowState : stateOrMessage as WorkflowState;
    const assistantMessage = maybeMessage === undefined ? stateOrMessage : maybeMessage;
    const parsedResult = parseAssistantOutput(assistantMessage, state);
    if ("error" in parsedResult) {
        return false;
    }

    const parsed = parsedResult.parsed;

    if (workflowKind === "fix") {
        switch (state) {
            case "review":
                return parsed.requestedState === "commit"
                    || parsed.requestedState === "manual-test"
                    || (parsed.requestedState === "implement-review" && parsed.reviewFindings.length > 0);
            case "manual-test":
                return parsed.requestedState === "commit"
                    || (parsed.requestedState === "implement-review" && parsed.manualTestSubtasks.length > 0);
            case "commit":
                return Boolean(parsed.commitMessage);
            default:
                return false;
        }
    }

    switch (state) {
        case "refine":
            return parsed.requestedState === "plan";

        case "plan":
            return parsed.requestedState === "review-plan";

        case "review-plan":
            return parsed.requestedState === "review-plan" || parsed.requestedState === "implement";

        case "review":
            return parsed.requestedState === "subtask-commit"
                || (parsed.requestedState === "implement-review" && parsed.reviewFindings.length > 0);

        case "manual-test":
            return parsed.requestedState === "commit"
                || (parsed.requestedState === "implement" && parsed.manualTestSubtasks.length > 0);

        case "subtask-commit":
        case "commit":
            return Boolean(parsed.commitMessage);

        default:
            return false;
    }
}

export function isWorkflowState(value: string): value is WorkflowState {
    return WORKFLOW_STATES.includes(value as WorkflowState);
}

/**
 * Validates persisted active-path depth against a workflow state.
 * Depth semantics:
 * - 0 => root issue
 * - 1 => root child (subtask)
 * - 2 => root child child (review-finding implementation)
 */
export function stateAllowsActiveDepth(state: WorkflowState, depth: number): boolean {
    return stateAllowsActiveDepthForKind("task", state, depth);
}

export function stateAllowsActiveDepthForKind(
    workflowKind: WorkflowKind,
    state: WorkflowState,
    depth: number,
): boolean {
    if (workflowKind === "fix") {
        if (depth < 0) return false;
        if (state === "implement-review") return depth === 1;
        if (state === "implement" || state === "review" || state === "manual-test" || state === "commit" || state === "complete") {
            return depth === 0;
        }
        return false;
    }
    if (depth < 0) return false;

    if (
        state === "refine"
        || state === "plan"
        || state === "review-plan"
        || state === "manual-test"
        || state === "commit"
        || state === "complete"
    ) {
        return depth === 0;
    }

    if (state === "implement" || state === "review" || state === "subtask-commit") {
        return depth === 1;
    }

    if (state === "implement-review") {
        return depth === 2;
    }

    return false;
}

/**
 * Indicates whether the shell should enrich an event with root issue markdown
 * before passing it through `transition`.
 */
export function eventNeedsRootIssueMarkdown(
    snapshot: WorkflowSnapshot,
    event: WorkflowEvent,
): boolean {
    if (event.type === "COMPLETE") {
        return event.completedState === snapshot.state
            && (
                snapshot.state === "plan"
                || snapshot.state === "review-plan"
                || snapshot.state === "commit"
            );
    }

    if (event.type === "FORCE_LGTM") {
        return event.completedState === snapshot.state && snapshot.state === "review-plan";
    }

    return false;
}

export function transition(snapshot: WorkflowSnapshot, event: WorkflowEvent): TransitionDecision {
    if ((snapshot.workflowKind ?? "task") === "fix") {
        return transitionFix(snapshot, event);
    }
    return transitionTask(snapshot, event);
}

function transitionTask(snapshot: WorkflowSnapshot, event: WorkflowEvent): TransitionDecision {
    if (event.type === "MANUAL_DONE") {
        if (event.completedState !== snapshot.state) {
            return error(snapshot, event, "Stale MANUAL_DONE event for a different state");
        }

        switch (snapshot.state) {
            case "implement":
                return move(snapshot, "review", {type: "current"});

            case "implement-review":
                return completeImplementReview(snapshot, event);

            default:
                return error(snapshot, event, "MANUAL_DONE is only valid in implement or implement-review");
        }
    }

    if (event.type === "FORCE_LGTM") {
        if (event.completedState !== snapshot.state) {
            return error(snapshot, event, "Stale FORCE_LGTM event for a different state");
        }

        switch (snapshot.state) {
            case "review-plan": {
                const planSubtasksResult = parsePlanSubtasksFromRootIssueMarkdown(event.rootIssueMarkdown);
                if ("error" in planSubtasksResult) {
                    return error(snapshot, event, `Cannot force approval: ${planSubtasksResult.error}`);
                }

                if (planSubtasksResult.drafts.length === 0) {
                    return error(snapshot, event, "Cannot force approval: no plan subtasks found in root issue markdown");
                }

                return move(
                    snapshot,
                    "implement",
                    {type: "first-created-child", parentTaskId: snapshot.rootTaskId},
                    [
                        ...toCreateIssueEffects(snapshot.rootTaskId, planSubtasksResult.drafts),
                        {
                            type: "ADD_NOTE",
                            taskId: snapshot.activeTaskId,
                            note: "Forced LGTM via /task lgtm (skipping plan review findings).",
                        },
                    ],
                );
            }

            case "review":
                return move(snapshot, "subtask-commit", {type: "current"}, [
                    {
                        type: "ADD_NOTE",
                        taskId: snapshot.activeTaskId,
                        note: "Forced LGTM via /task lgtm (skipping review findings).",
                    },
                ]);

            default:
                return error(snapshot, event, "FORCE_LGTM is only valid in review-plan or review");
        }
    }

    // COMPLETE event
    if (event.completedState !== snapshot.state) {
        return error(snapshot, event, "Stale COMPLETE event for a different state");
    }

    const parsedResult = parseAssistantOutput(event.assistantMessage, snapshot.state);
    if ("error" in parsedResult) {
        return error(snapshot, event, parsedResult.error);
    }

    const parsed = parsedResult.parsed;

    switch (snapshot.state) {
        case "refine": {
            switch (parsed.requestedState) {
                case null:
                    return ignored(snapshot, event) // Interactive turns
                case "plan":
                    return move(snapshot, "plan", {type: "root"});
                default:
                    return error(snapshot, event, "Expected <transition>plan</transition>");
            }
        }

        case "plan": {
            switch (parsed.requestedState) {
                case null:
                    return ignored(snapshot, event) // Interactive turns
                case "review-plan": {
                    const planSubtasksResult = parsePlanSubtasksFromRootIssueMarkdown(event.rootIssueMarkdown);
                    if ("error" in planSubtasksResult) {
                        return error(snapshot, event, `Cannot move to review-plan: ${planSubtasksResult.error}`);
                    }

                    if (planSubtasksResult.drafts.length === 0) {
                        return error(
                            snapshot,
                            event,
                            "Expected non-empty ## Plan/<subtasks>...</subtasks> in root issue before moving to review-plan",
                        );
                    }

                    return move(snapshot, "review-plan", {type: "root"});
                }
                default:
                    return error(snapshot, event, "Expected <transition>review-plan</transition>");
            }
        }

        case "review-plan": {
            switch (parsed.requestedState) {
                case null:
                    return ignored(snapshot, event) // Interactive turns

                case "review-plan": {
                    const planSubtasksResult = parsePlanSubtasksFromRootIssueMarkdown(event.rootIssueMarkdown);
                    if ("error" in planSubtasksResult) {
                        return error(snapshot, event, `Cannot re-review: ${planSubtasksResult.error}`);
                    }

                    if (planSubtasksResult.drafts.length === 0) {
                        return error(snapshot, event, "Cannot re-review: no plan subtasks found in root issue markdown");
                    }
                    return stay(snapshot);
                }

                case "implement": {
                    const planSubtasksResult = parsePlanSubtasksFromRootIssueMarkdown(event.rootIssueMarkdown);
                    if ("error" in planSubtasksResult) {
                        return error(snapshot, event, `Cannot approve plan: ${planSubtasksResult.error}`);
                    }

                    if (planSubtasksResult.drafts.length === 0) {
                        return error(snapshot, event, "Cannot approve plan: no plan subtasks found in root issue markdown");
                    }

                    return move(
                        snapshot,
                        "implement",
                        {type: "first-created-child", parentTaskId: snapshot.rootTaskId},
                        toCreateIssueEffects(snapshot.rootTaskId, planSubtasksResult.drafts),
                    );
                }

                default:
                    return error(
                        snapshot,
                        event,
                        "Expected <transition>implement</transition> or <transition>review-plan</transition>",
                    );
            }
        }

        case "implement": {
            return move(snapshot, "review", {type: "current"});
        }

        case "review": {
            switch (parsed.requestedState) {
                case null:
                    return ignored(snapshot, event); // Clarifying-question turns

                case "subtask-commit":
                    return move(snapshot, "subtask-commit", {type: "current"});

                case "implement-review": {
                    if (parsed.reviewFindings.length === 0) {
                        return error(
                            snapshot,
                            event,
                            "Got <transition>implement-review</transition> but no <review-findings> block",
                        );
                    }

                    return move(
                        snapshot,
                        "implement-review",
                        {type: "first-created-child", parentTaskId: snapshot.activeTaskId},
                        toCreateIssueEffects(snapshot.activeTaskId, parsed.reviewFindings),
                    );
                }

                default:
                    return error(
                        snapshot,
                        event,
                        "Expected <transition>subtask-commit</transition> or findings + <transition>implement-review</transition>",
                    );
            }
        }

        case "implement-review":
            return completeImplementReview(snapshot, event);

        case "subtask-commit": {
            if (!parsed.commitMessage) {
                return error(snapshot, event, "Expected <commit-message>...</commit-message>");
            }

            const effects: WorkflowEffect[] = [
                {type: "CLOSE_ISSUE", taskId: snapshot.activeTaskId},
                {type: "RUN_JJ_COMMIT", message: parsed.commitMessage},
            ];

            if (snapshot.activeTaskNextSiblingId) {
                return move(snapshot, "implement", {type: "next-sibling"}, effects);
            }

            return move(snapshot, "manual-test", {type: "root"}, effects);
        }

        case "manual-test": {
            switch (parsed.requestedState) {
                case null:
                    return ignored(snapshot, event); // Interactive manual verification turns

                case "commit":
                    return move(snapshot, "commit", {type: "root"});

                case "implement":
                    if (parsed.manualTestSubtasks.length === 0) {
                        return error(
                            snapshot,
                            event,
                            "Got <transition>implement</transition> but no <manual-test-subtasks> block",
                        );
                    }

                    return move(
                        snapshot,
                        "implement",
                        {type: "first-created-child", parentTaskId: snapshot.rootTaskId},
                        toCreateIssueEffects(snapshot.rootTaskId, parsed.manualTestSubtasks),
                    );

                default:
                    return error(
                        snapshot,
                        event,
                        "Expected <transition>commit</transition> or manual-test subtasks + <transition>implement</transition>",
                    );
            }
        }

        case "commit": {
            if (!parsed.commitMessage) {
                return error(snapshot, event, "Expected <commit-message>...</commit-message>");
            }

            const finalCommitMessage = appendFixesLineFromRootDescription(
                parsed.commitMessage,
                event.rootIssueMarkdown,
            );

            return move(snapshot, "complete", {type: "root"}, [
                {type: "CLOSE_ISSUE", taskId: snapshot.rootTaskId},
                {type: "RUN_JJ_COMMIT", message: finalCommitMessage},
            ]);
        }

        case "complete": {
            return ignored(snapshot, event, "Workflow is complete");
        }

        default: {
            return assertNever(snapshot.state);
        }
    }
}

function transitionFix(snapshot: WorkflowSnapshot, event: WorkflowEvent): TransitionDecision {
    if (snapshot.manualTestStatus === undefined) {
        return error(snapshot, event, "Fix workflow snapshot is missing manualTestStatus");
    }
    const status = snapshot.manualTestStatus;
    const validStates: WorkflowState[] = ["implement", "review", "implement-review", "manual-test", "commit", "complete"];
    if (!validStates.includes(snapshot.state)) {
        return error(snapshot, event, `State ${snapshot.state} is not valid for fix workflow`);
    }

    if (event.completedState !== snapshot.state) {
        return error(snapshot, event, `Stale ${event.type} event for a different state`);
    }

    if (event.type === "MANUAL_DONE") {
        if (snapshot.state === "implement") {
            return moveFix(snapshot, "review", {type: "root"}, status);
        }
        if (snapshot.state === "implement-review") {
            return completeFixImplementReview(snapshot, event, status);
        }
        return error(snapshot, event, "MANUAL_DONE is only valid in implement or implement-review");
    }

    if (event.type === "FORCE_LGTM") {
        if (snapshot.state !== "review") {
            return error(snapshot, event, "FORCE_LGTM is only valid in review for fix workflow");
        }
        if (status === "passed") {
            return error(snapshot, event, "Cannot force approval from review after manual testing has already passed");
        }
        const nextState = status === "pending" ? "manual-test" : "commit";
        return moveFix(snapshot, nextState, {type: "root"}, status, [{
            type: "ADD_NOTE",
            taskId: snapshot.rootTaskId,
            note: "Forced LGTM via /fix lgtm (skipping review findings).",
        }]);
    }

    const parsedResult = parseAssistantOutput(event.assistantMessage, snapshot.state);
    if ("error" in parsedResult) {
        return error(snapshot, event, parsedResult.error);
    }
    const parsed = parsedResult.parsed;

    switch (snapshot.state) {
        case "implement":
            return moveFix(snapshot, "review", {type: "root"}, status);

        case "review":
            switch (parsed.requestedState) {
                case null:
                    return ignored(snapshot, event);
                case "implement-review":
                    if (parsed.reviewFindings.length === 0) {
                        return error(snapshot, event, "Got <transition>implement-review</transition> but no <review-findings> block");
                    }
                    return moveFix(
                        snapshot,
                        "implement-review",
                        {type: "first-created-child", parentTaskId: snapshot.rootTaskId},
                        status,
                        toCreateIssueEffects(snapshot.rootTaskId, parsed.reviewFindings),
                    );
                case "manual-test":
                    return moveFix(snapshot, "manual-test", {type: "root"}, "pending");
                case "commit":
                    if (status === "pending") {
                        return error(snapshot, event, "Cannot transition directly to commit while manual testing is pending");
                    }
                    if (status !== "undecided") {
                        return error(snapshot, event, "Direct review to commit is only allowed while manual testing is undecided");
                    }
                    return moveFix(snapshot, "commit", {type: "root"}, status);
                default:
                    return error(snapshot, event, "Expected findings + <transition>implement-review</transition>, <transition>manual-test</transition>, or <transition>commit</transition>");
            }

        case "implement-review":
            return completeFixImplementReview(snapshot, event, status);

        case "manual-test":
            switch (parsed.requestedState) {
                case null:
                    return ignored(snapshot, event);
                case "commit":
                    return moveFix(snapshot, "commit", {type: "root"}, "passed");
                case "implement-review":
                    if (parsed.manualTestSubtasks.length === 0) {
                        return error(snapshot, event, "Got <transition>implement-review</transition> but no <manual-test-subtasks> block");
                    }
                    return moveFix(
                        snapshot,
                        "implement-review",
                        {type: "first-created-child", parentTaskId: snapshot.rootTaskId},
                        "pending",
                        toCreateIssueEffects(snapshot.rootTaskId, parsed.manualTestSubtasks),
                    );
                default:
                    return error(snapshot, event, "Expected <transition>commit</transition> or manual-test subtasks + <transition>implement-review</transition>");
            }

        case "commit":
            if (!parsed.commitMessage) {
                return error(snapshot, event, "Expected <commit-message>...</commit-message>");
            }
            return moveFix(snapshot, "complete", {type: "root"}, status, [
                {type: "CLOSE_ISSUE", taskId: snapshot.rootTaskId},
                {
                    type: "RUN_JJ_COMMIT",
                    message: appendFixesLineFromRootDescription(parsed.commitMessage, event.rootIssueMarkdown),
                },
            ]);

        case "complete":
            return ignored(snapshot, event, "Workflow is complete");

        default:
            return error(snapshot, event, `State ${snapshot.state} is not valid for fix workflow`);
    }
}

function completeFixImplementReview(
    snapshot: WorkflowSnapshot,
    event: WorkflowEvent,
    status: ManualTestStatus,
): TransitionDecision {
    if (snapshot.activeTaskParentId !== snapshot.rootTaskId) {
        return error(snapshot, event, "fix implement-review requires a root child as the active issue");
    }
    const effects: WorkflowEffect[] = [{type: "CLOSE_ISSUE", taskId: snapshot.activeTaskId}];
    if (snapshot.activeTaskNextSiblingId) {
        return moveFix(snapshot, "implement-review", {type: "next-sibling"}, status, effects);
    }
    return moveFix(snapshot, "review", {type: "root"}, status, effects);
}

function completeImplementReview(snapshot: WorkflowSnapshot, event: WorkflowEvent): TransitionDecision {
    if (!snapshot.activeTaskParentId) {
        return error(snapshot, event, "implement-review requires activeTaskParentId in snapshot");
    }

    const effects: WorkflowEffect[] = [{type: "CLOSE_ISSUE", taskId: snapshot.activeTaskId}];

    if (snapshot.activeTaskNextSiblingId) {
        return move(snapshot, "implement-review", {type: "next-sibling"}, effects);
    }

    return move(snapshot, "review", {type: "parent"}, effects);
}

function move(
    snapshot: WorkflowSnapshot,
    state: WorkflowState,
    activeTaskTarget: ActiveTaskTarget,
    effects: WorkflowEffect[] = [],
): TransitionDecision {
    return {
        kind: "applied",
        state,
        activeTaskTarget,
        effects,
    };
}

function moveFix(
    snapshot: WorkflowSnapshot,
    state: WorkflowState,
    activeTaskTarget: ActiveTaskTarget,
    manualTestStatus: ManualTestStatus,
    effects: WorkflowEffect[] = [],
): TransitionDecision {
    return {
        kind: "applied",
        state,
        activeTaskTarget,
        effects,
        manualTestStatus,
    };
}

function stay(snapshot: WorkflowSnapshot, effects: WorkflowEffect[] = []): TransitionDecision {
    return {
        kind: "applied",
        state: snapshot.state,
        activeTaskTarget: {type: "current"},
        effects,
    };
}

function ignored(snapshot: WorkflowSnapshot, event: WorkflowEvent, reason?: string): TransitionDecision {
    return {
        kind: "ignored",
        state: snapshot.state,
        activeTaskTarget: {type: "current"},
        effects: [],
        reason: reason,
    };
}

function error(snapshot: WorkflowSnapshot, event: WorkflowEvent, reason?: string): TransitionDecision {
    return {
        kind: "rejected",
        state: snapshot.state,
        activeTaskTarget: {type: "current"},
        effects: [],
        reason: reason ?? `Event ${event.type} is not handled in state ${snapshot.state}`,
    };
}

function toCreateIssueEffects(parentTaskId: string, drafts: IssueDraft[]): WorkflowEffect[] {
    return drafts.map((draft) => ({
        type: "CREATE_ISSUE" as const,
        parentTaskId,
        title: draft.title,
        description: draft.description,
        tdd: draft.tdd,
        idempotencyKey: `${parentTaskId}::${draft.title}`,
    }));
}

function parseRequestedStateFromAssistantMessage(
    messageText: string,
): {state: WorkflowState | null} | {error: string} {
    const explicitMatches = [...messageText.matchAll(/<transition>\s*([a-z-]+)\s*<\/transition>/gi)];
    for (let i = explicitMatches.length - 1; i >= 0; i--) {
        const raw = explicitMatches[i]?.[1];
        if (!raw) continue;
        const normalized = raw.trim().toLowerCase();
        if (isWorkflowState(normalized)) return {state: normalized};
        if (i === explicitMatches.length - 1) {
            return {
                error: `Unknown workflow transition '${normalized}'. Expected a valid workflow state in <transition>...</transition>.`,
            };
        }
    }
    return {state: null};
}

type DraftListParseResult =
    | { drafts: IssueDraft[] }
    | { error: string };

function parsePlanSubtasksFromRootIssueMarkdown(rootIssueMarkdown?: string): DraftListParseResult {
    if (!rootIssueMarkdown) {
        return {error: "Root issue markdown is required."};
    }

    const yaml = extractYamlPlanBlock(rootIssueMarkdown);
    if (!yaml) {
        return {error: "Could not find a `## Plan` section with a <subtasks>...</subtasks> block."};
    }

    return parseYamlIssueList(yaml, "Subtask");
}

function parseIssueDraftListFromTag(
    text: string,
    tagName: "review-findings" | "manual-test-subtasks",
): DraftListParseResult | null {
    const yamlString = extractTaggedYamlBlock(text, tagName);
    if (!yamlString) return null;

    return parseYamlIssueList(yamlString, tagName === "review-findings" ? "Finding" : "Subtask");
}

function parseYamlIssueList(yamlString: string, label: string): DraftListParseResult {
    let parsed: unknown;
    try {
        parsed = parseYamlDocument(yamlString);
    } catch (e) {
        return {error: `Failed to parse ${label} YAML block: ${e}`};
    }

    if (!parsed) {
        return {drafts: []};
    }

    if (!Array.isArray(parsed)) {
        return {error: `${label} YAML block must be a list (a YAML sequence).`};
    }

    const drafts: IssueDraft[] = [];
    const seenTitles = new Set<string>();

    for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        if (!item || typeof item !== "object") {
            return {error: `${label} ${i + 1} is not an object.`};
        }

        const title = typeof (item as { title?: unknown }).title === "string"
            ? (item as { title: string }).title.trim()
            : "";

        if (!title) {
            return {error: `${label} ${i + 1} is missing a non-empty string 'title'.`};
        }

        if (seenTitles.has(title)) {
            return {error: `${label} titles must be unique; duplicate title: ${title}`};
        }
        seenTitles.add(title);

        const description = typeof (item as { description?: unknown }).description === "string"
            ? (item as { description: string }).description
            : "";

        const tddValue = (item as { tdd?: unknown }).tdd;
        const tdd = typeof tddValue === "boolean" ? tddValue : true;

        drafts.push({title, description, tdd});
    }

    return {drafts};
}

/**
 * Extract YAML inside <subtasks>...</subtasks> under the first ## Plan section.
 */
function extractYamlPlanBlock(issueMarkdown: string): string | null {
    const normalized = normalizeNewlines(issueMarkdown);

    const planHeaderMatch = /^## Plan\s*$/m.exec(normalized);
    if (!planHeaderMatch) return null;

    const afterPlanHeader = normalized.slice(planHeaderMatch.index + planHeaderMatch[0].length);

    const startMatch = /^\s*<subtasks>\s*$/m.exec(afterPlanHeader);
    if (startMatch) {
        const afterStartLine = afterPlanHeader.slice(startMatch.index + startMatch[0].length);
        const firstNewline = afterStartLine.indexOf("\n");
        const body = firstNewline === -1 ? "" : afterStartLine.slice(firstNewline + 1);

        const endMatch = /^\s*<\/subtasks>\s*$/m.exec(body);
        if (!endMatch) return null;
        return body.slice(0, endMatch.index).trim();
    }

    const startIdx = afterPlanHeader.indexOf("<subtasks>");
    if (startIdx === -1) return null;
    const endIdx = afterPlanHeader.indexOf("</subtasks>", startIdx + "<subtasks>".length);
    if (endIdx === -1) return null;
    return afterPlanHeader.slice(startIdx + "<subtasks>".length, endIdx).trim();
}

function parseCommitMessageFromAssistantMessage(messageText: string): string | null {
    const raw = extractTaggedYamlBlock(messageText, "commit-message");
    if (!raw) return null;
    const normalized = normalizeNewlines(raw).trim();
    return normalized.length > 0 ? normalized : null;
}

function appendFixesLineFromRootDescription(commitMessage: string, rootIssueMarkdown: string): string {
    const normalizedCommitMessage = normalizeNewlines(commitMessage).trim();
    const fixesReference = extractFixesReferenceFromRootDescription(rootIssueMarkdown);
    if (!fixesReference) {
        return normalizedCommitMessage;
    }

    if (commitMessageAlreadyContainsFixesReference(normalizedCommitMessage, fixesReference)) {
        return normalizedCommitMessage;
    }

    return `${normalizedCommitMessage}\n\nFixes: ${fixesReference}`;
}

function extractFixesReferenceFromRootDescription(rootIssueMarkdown: string): string | null {
    const description = extractRootIssueDescription(rootIssueMarkdown);
    if (!description) {
        return null;
    }

    for (const line of description.split("\n")) {
        const match = /^\s*fixes:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+)\s*$/i.exec(line);
        if (match) {
            return match[1];
        }
    }

    return null;
}

function extractRootIssueDescription(rootIssueMarkdown: string): string {
    const normalized = normalizeNewlines(rootIssueMarkdown ?? "").trim();
    if (!normalized) {
        return "";
    }

    let content = normalized;
    const firstLineEnd = content.indexOf("\n");
    const firstLine = firstLineEnd === -1 ? content : content.slice(0, firstLineEnd);
    if (/^#\s+/.test(firstLine.trim())) {
        content = firstLineEnd === -1 ? "" : content.slice(firstLineEnd + 1).trimStart();
    }

    const firstSection = /^##\s+/m.exec(content);
    if (!firstSection) {
        return content.trim();
    }

    return content.slice(0, firstSection.index).trim();
}

function commitMessageAlreadyContainsFixesReference(commitMessage: string, fixesReference: string): boolean {
    const escaped = escapeRegExp(fixesReference);
    const regex = new RegExp(`^\\s*fixes:\\s*${escaped}\\s*$`, "im");
    return regex.test(commitMessage);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractTaggedYamlBlock(text: string, tagName: string): string | null {
    const normalized = normalizeNewlines(text);

    const startMatch = new RegExp(`^\\s*<${tagName}>\\s*$`, "m").exec(normalized);
    if (startMatch) {
        const afterStart = normalized.slice(startMatch.index + startMatch[0].length);
        const firstNewline = afterStart.indexOf("\n");
        const body = firstNewline === -1 ? "" : afterStart.slice(firstNewline + 1);

        const endMatch = new RegExp(`^\\s*</${tagName}>\\s*$`, "m").exec(body);
        if (!endMatch) return null;
        return body.slice(0, endMatch.index).trim();
    }

    const startIdx = normalized.indexOf(`<${tagName}>`);
    if (startIdx === -1) return null;
    const endIdx = normalized.indexOf(`</${tagName}>`, startIdx + tagName.length + 2);
    if (endIdx === -1) return null;
    return normalized.slice(startIdx + tagName.length + 2, endIdx).trim();
}

function parseYamlDocument(yamlString: string): unknown {
    return parseYaml(yamlString) as unknown;
}

function normalizeNewlines(value: string): string {
    return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function assertNever(value: never): never {
    throw new Error(`Unhandled value: ${String(value)}`);
}
