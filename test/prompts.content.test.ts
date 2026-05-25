import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

function readPrompt(name: string): string {
    return fs.readFileSync(path.join(repoRoot, "prompts", name), "utf8");
}

test("plan prompt places user-facing integration testing in manual-test stage", () => {
    const prompt = readPrompt("plan.md");

    assert.match(prompt, /Do not put user-facing integration or manual-style test execution or verification inside implementation subtasks/i);
    assert.match(prompt, /Playwright/i);
    assert.match(prompt, /Swing/i);
    assert.match(prompt, /`## Manual Test Plan`/);
    assert.match(prompt, /manual-test stage/i);
});

test("plan prompt excludes user-facing automation from implementation-stage TDD", () => {
    const prompt = readPrompt("plan.md");

    assert.match(prompt, /User-facing browser\/desktop\/end-to-end automation is not an acceptable implementation-stage TDD test/i);
    assert.match(prompt, /Playwright/i);
    assert.match(prompt, /Swing/i);
    assert.match(prompt, /Prefer lower-level automated tests/i);
    assert.match(prompt, /unit, component, model, service, or API/i);
    assert.match(prompt, /tdd: false/i);
    assert.match(prompt, /Manual Test Plan/i);
});

test("plan prompt disambiguates Swing TDD exception from user-flow automation", () => {
    const prompt = readPrompt("plan.md");

    assert.doesNotMatch(prompt, /Swing code which is unreasonably difficult to test with automation/i);
    assert.match(prompt, /Swing\/UI code may use lower-level automated tests where practical/i);
    assert.match(prompt, /user-flow Swing automation belongs in the root `## Manual Test Plan`/i);
});

test("manual-test prompt assigns user-facing integration checks to the user", () => {
    const prompt = readPrompt("manual-test.md");

    assert.match(prompt, /User-facing integration and manual-style checks must be performed by the user/i);
    assert.match(prompt, /Playwright/i);
    assert.match(prompt, /Swing/i);
    assert.match(prompt, /do not run them yourself/i);
    assert.match(prompt, /set up the environment/i);
});

test("manual-test automated-only path excludes browser and GUI automation", () => {
    const prompt = readPrompt("manual-test.md");

    assert.match(prompt, /If task only contains non-user-facing automated tests/i);
    assert.match(prompt, /Do not treat browser, Playwright, Swing, desktop GUI, or end-to-end user-flow automation as automated-only/i);
});

test("implement prompt broadly defers user-facing integration testing", () => {
    const prompt = readPrompt("implement.md");

    assert.match(prompt, /During implementation, run code-level automated tests and repo checks as needed/i);
    assert.match(prompt, /If the wider suite or repo.?s standard checks include user-facing browser\/GUI\/end-to-end checks, skip or defer those checks to `manual-test`/i);
    assert.match(prompt, /Do \*\*not\*\* run, drive, use, or check user-facing integration\/manual-style tests before the/i);
    assert.match(prompt, /debugging, exploration, smoke testing, automated test execution, and final verification/i);
    assert.match(prompt, /Playwright/i);
    assert.match(prompt, /Swing/i);
    assert.match(prompt, /root\s+`## Manual Test Plan`/i);
    assert.match(prompt, /concrete user-run steps/i);
});

test("review prompt rejects pre-manual-stage user-facing integration testing", () => {
    const prompt = readPrompt("review.md");

    assert.match(prompt, /Reviewers must not run, drive, use, or check user-facing integration\/manual-style tests before/i);
    assert.match(prompt, /Do not require implementation-stage completion of user-facing integration or manual-style testing/i);
    assert.match(prompt, /running, driving, using, or checking these flows/i);
    assert.match(prompt, /debugging, exploration, smoke testing, automated test execution, and final verification/i);
    assert.match(prompt, /Playwright/i);
    assert.match(prompt, /Swing/i);
    assert.match(prompt, /root `## Manual Test Plan`/i);
    assert.match(prompt, /Flag an important finding if the subtask ran, drove, used, checked, or relied on pre-manual-stage/i);
    assert.match(prompt, /even if other code-level tests passed/i);
    assert.match(prompt, /omitted .* user-run manual-test steps/i);
});

test("review-plan prompt requires user-facing integration testing to stay in manual test plan", () => {
    const prompt = readPrompt("review-plan.md");

    assert.match(prompt, /User-facing integration\/manual-style checks are not assigned to implementation subtasks/i);
    assert.match(prompt, /Do not let implementation subtasks run, drive, use, or check those flows/i);
    assert.match(prompt, /debugging, exploration, smoke testing, automated test execution, and final verification/i);
    assert.match(prompt, /Reject `tdd: true` subtasks whose described test is user-facing browser\/GUI\/desktop\/end-to-end automation/i);
    assert.match(prompt, /Playwright, Cypress, Selenium, Appium, or Swing/i);
    assert.match(prompt, /lower-level automated test/i);
    assert.match(prompt, /`tdd: false`/i);
    assert.match(prompt, /Playwright/i);
    assert.match(prompt, /Swing/i);
    assert.match(prompt, /`## Manual Test Plan`/);
    assert.match(prompt, /performed by the user during `manual-test`/i);
});

test("implement-review prompt broadly defers user-facing integration testing", () => {
    const prompt = readPrompt("implement-review.md");

    assert.match(prompt, /Do \*\*not\*\* run, drive, use, or check user-facing integration\/manual-style tests before the/i);
    assert.match(prompt, /If the wider suite or repo.?s standard checks include user-facing browser\/GUI\/end-to-end checks, skip or defer those checks to `manual-test`/i);
    assert.match(prompt, /debugging, exploration, smoke testing, automated test execution, and final verification/i);
    assert.match(prompt, /Playwright/i);
    assert.match(prompt, /Swing/i);
    assert.match(prompt, /root\n`## Manual Test Plan`/i);
    assert.match(prompt, /concrete user-run steps/i);
});

test("prompts allow explicitly requested user-facing test asset authoring", () => {
    for (const name of ["plan.md", "review-plan.md", "implement.md", "implement-review.md", "review.md"]) {
        const prompt = readPrompt(name);

        assert.match(prompt, /explicitly (?:asks|requires).*add(?:ing)? or updat(?:e|ing) user-facing integration test assets/i, name);
        assert.match(prompt, /may (?:author|edit) (?:those|the) files/i, name);
        assert.match(prompt, /do not (?:run|execute) (?:or rely on )?them before `?manual-test`?/i, name);
        assert.match(prompt, /user-run (?:execution )?steps/i, name);
    }
});

test("implementation prompts require inspecting unknown check commands before running", () => {
    for (const name of ["implement.md", "implement-review.md"]) {
        const prompt = readPrompt(name);

        assert.match(prompt, /If you are unsure whether a check command drives a browser, GUI, desktop app, simulator, or end-to-end user flow/i);
        assert.match(prompt, /inspect the scripts\/configuration first/i);
        assert.match(prompt, /do not run the command blindly/i);
        assert.match(prompt, /Prefer filtered code-level checks/i);
    }
});
