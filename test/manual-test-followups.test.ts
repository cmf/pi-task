import test from "node:test";
import assert from "node:assert/strict";

import {
    buildManualTestFollowupPromptContext,
    fingerprintManualTestFollowup,
    recordManualTestFollowups,
    type ManualTestFollowup,
} from "../index.js";

test("fingerprintManualTestFollowup normalizes title text", () => {
    assert.equal(
        fingerprintManualTestFollowup("  Fix `/title` dispatch blocked by automatic typing acknowledgement  "),
        "fix-title-dispatch-blocked-by-automatic-typing-acknowledgement",
    );
});

test("recordManualTestFollowups appends created manual-test issues without duplicating issue IDs", () => {
    const existing: ManualTestFollowup[] = [
        {
            issue_id: "239",
            title: "Fix `/title` dispatch blocked by automatic typing acknowledgement",
            fingerprint: fingerprintManualTestFollowup("Fix `/title` dispatch blocked by automatic typing acknowledgement"),
            created_at: "2026-04-26T11:25:44.000Z",
            from_manual_test_version: 64,
        },
    ];

    const recorded = recordManualTestFollowups({
        existing,
        createdAt: "2026-04-26T11:30:40.000Z",
        fromManualTestVersion: 66,
        createdIssues: [
            {
                issue_id: "239",
                title: "Fix `/title` dispatch blocked by automatic typing acknowledgement",
            },
            {
                issue_id: "240",
                title: "Verify mention-prefixed `/title` command behavior",
            },
        ],
    });

    assert.deepEqual(recorded, [
        existing[0],
        {
            issue_id: "240",
            title: "Verify mention-prefixed `/title` command behavior",
            fingerprint: "verify-mention-prefixed-title-command-behavior",
            created_at: "2026-04-26T11:30:40.000Z",
            from_manual_test_version: 66,
        },
    ]);
});

test("recordManualTestFollowups preserves a new issue when a closed followup repeats its title", () => {
    const title = "Fix `/title` dispatch blocked by automatic typing acknowledgement";
    const recorded = recordManualTestFollowups({
        existing: [
            {
                issue_id: "239",
                title,
                fingerprint: fingerprintManualTestFollowup(title),
                created_at: "2026-04-26T11:25:44.000Z",
                from_manual_test_version: 64,
            },
        ],
        createdAt: "2026-04-26T11:30:40.000Z",
        fromManualTestVersion: 66,
        createdIssues: [{issue_id: "242", title}],
    });

    assert.deepEqual(recorded.map((followup) => followup.issue_id), ["239", "242"]);

    const context = buildManualTestFollowupPromptContext([
        {...recorded[0], status: "closed"},
        {...recorded[1], status: "open"},
    ]);
    assert.match(context, /#239 CLOSED:/);
    assert.match(context, /#242 OPEN:/);
});

test("buildManualTestFollowupPromptContext tells manual-test that closed followups are historical", () => {
    const context = buildManualTestFollowupPromptContext([
        {
            issue_id: "239",
            title: "Fix `/title` dispatch blocked by typing acknowledgement",
            fingerprint: fingerprintManualTestFollowup("Fix `/title` dispatch blocked by typing acknowledgement"),
            created_at: "2026-04-26T11:25:44.000Z",
            from_manual_test_version: 64,
            status: "closed",
        },
        {
            issue_id: "240",
            title: "Verify mention-prefixed `/title` command behavior",
            fingerprint: fingerprintManualTestFollowup("Verify mention-prefixed `/title` command behavior"),
            created_at: "2026-04-26T11:25:44.000Z",
            from_manual_test_version: 64,
            status: "closed",
        },
    ]);

    assert.match(context, /## Previous Manual-Test Follow-ups/);
    assert.match(context, /#239 CLOSED: Fix `\/title` dispatch blocked by typing acknowledgement/);
    assert.match(context, /#240 CLOSED: Verify mention-prefixed `\/title` command behavior/);
    assert.match(context, /Treat their original failures as historical/);
    assert.match(context, /Ask the user to rerun manual verification/);
});

test("buildManualTestFollowupPromptContext calls out open followups", () => {
    const context = buildManualTestFollowupPromptContext([
        {
            issue_id: "242",
            title: "Fix `/title` dispatch blocked by automatic typing acknowledgement",
            fingerprint: fingerprintManualTestFollowup("Fix `/title` dispatch blocked by automatic typing acknowledgement"),
            created_at: "2026-04-26T11:30:40.000Z",
            from_manual_test_version: 66,
            status: "open",
        },
    ]);

    assert.match(context, /#242 OPEN: Fix `\/title` dispatch blocked by automatic typing acknowledgement/);
    assert.match(context, /Do not create duplicate manual-test follow-ups/);
});
