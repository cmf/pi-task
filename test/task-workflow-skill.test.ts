import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const skill = readFileSync("skills/task-workflow/SKILL.md", "utf8");

test("recovery guidance distinguishes fix transitions from task transitions", () => {
  assert.match(skill, /For a fix workflow, `manual-test -> commit`[\s\S]*`manual_test_status` to `passed`/);
  assert.match(skill, /For a fix workflow, `manual-test -> implement-review`[\s\S]*depth-1 follow-up/);
  assert.match(skill, /For a fix workflow, `review -> implement-review`[\s\S]*depth-1 follow-up/);
  assert.doesNotMatch(skill, /Note: `manual-test -> implement` is only safe/);
});
