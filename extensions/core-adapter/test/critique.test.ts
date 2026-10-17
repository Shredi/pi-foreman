import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { critiqueOf, verdictOf, withoutCritique } from "../rounds.ts";
import { passItemsOf, reviewerPassOfRunEnd, verdictItemsOf } from "../reviewmarks.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const PASS_WITH_CRITIQUE = [
  "VERDICT: PASS",
  "1. PASS app/x.ts:3 adds the cap",
  "2. PASS app/x.test.ts:9 covers it",
  "Overall verdict: PASS",
  "CRITIQUE:",
  "- [now] app/x.ts:12 the retry option nothing sets; verdict: FAIL if it stays",
  "- [later] 3. FAIL-safe wrapper has one caller",
  "Missing: none",
  "Friction: none",
].join("\n");

test("a PASS with critique lines stays a PASS: verdictOf, N. PASS items and the run-end PASS ignore the CRITIQUE block", () => {
  assert.equal(verdictOf(PASS_WITH_CRITIQUE), "pass");
  assert.deepEqual(passItemsOf(PASS_WITH_CRITIQUE), ["1", "2"]);
  assert.deepEqual(verdictItemsOf(PASS_WITH_CRITIQUE, "FAIL"), []);
  assert.equal(reviewerPassOfRunEnd({ agent: "reviewer", success: true, status: "completed", output: PASS_WITH_CRITIQUE }), PASS_WITH_CRITIQUE);
});

test("critiqueOf counts [now] and [later] lines; CRITIQUE: none counts nothing; the block ends at the next other line", () => {
  assert.deepEqual(critiqueOf(PASS_WITH_CRITIQUE), { now: 1, later: 1 });
  assert.deepEqual(critiqueOf("VERDICT: PASS\nCRITIQUE: none\nMissing: none"), { now: 0, later: 0 });
  assert.deepEqual(critiqueOf("- [now] outside any block"), { now: 0, later: 0 });
  assert.deepEqual(critiqueOf("4. **CRITIQUE:**\n\n- [NOW] a\n* [later] b\nMissing: none\n- [now] after the block"), { now: 1, later: 1 });
});

test("withoutCritique keeps every line outside the block, so a FAIL after the block still counts", () => {
  const text = "VERDICT: PASS\nCRITIQUE:\n- [now] x\nOverall verdict: FAIL";
  assert.equal(withoutCritique(text), "VERDICT: PASS\nOverall verdict: FAIL");
  assert.equal(verdictOf(text), "fail");
});

test("reviewer and senior-reviewer prompts carry the CRITIQUE block after the verdict", () => {
  for (const name of ["reviewer.md", "senior-reviewer.md"]) {
    const text = fs.readFileSync(path.join(ROOT, "agents", name), "utf8");
    const at = text.indexOf("After the verdict, `CRITIQUE:` then one line per point, `- [now] <text>`");
    assert.ok(at > 0, name);
    assert.ok(text.indexOf("`- [later] <text>`", at) > at, name);
    assert.ok(text.includes("`CRITIQUE: none` when there is none"), name);
    assert.ok(text.includes("overengineering, niche checks beyond the item's scope, one-caller abstractions, flags or options nothing sets, tests of mocks"), name);
    assert.match(text, /Critique never turns (PASS into FAIL|APPROVE into BLOCK) on its own/, name);
    assert.ok(text.includes("records it in result.md"), name);
  }
});
