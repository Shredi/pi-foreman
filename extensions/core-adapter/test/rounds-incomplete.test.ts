// incompleteOf (D90): a verdict line `FAIL INCOMPLETE` marks a reviewer that stopped early; verdictOf still reads it as FAIL.
import assert from "node:assert/strict";
import { test } from "node:test";
import { incompleteOf, verdictOf } from "../rounds.ts";

test("incompleteOf: FAIL INCOMPLETE is true, also with N. FAIL item lines and the overall form", () => {
  assert.equal(incompleteOf("VERDICT: FAIL INCOMPLETE\nchecks left: 2, 3"), true);
  assert.equal(incompleteOf("VERDICT: FAIL INCOMPLETE\n1. PASS a\n2. FAIL b:1 unchecked"), true);
  assert.equal(incompleteOf("Overall verdict: FAIL incomplete"), true);
  assert.equal(verdictOf("VERDICT: FAIL INCOMPLETE"), "fail");
});

test("incompleteOf: plain FAIL, PASS and no verdict are false", () => {
  assert.equal(incompleteOf("VERDICT: FAIL\n1. FAIL src/x.ts:1 broken"), false);
  assert.equal(incompleteOf("VERDICT: PASS"), false);
  assert.equal(incompleteOf("no verdict here, incomplete"), false);
});

test("incompleteOf: INCOMPLETE only inside the CRITIQUE block is false", () => {
  const text = "VERDICT: FAIL\n1. FAIL x\n\nCRITIQUE:\n- [later] VERDICT: FAIL INCOMPLETE was my first draft\n- [later] another\n";
  assert.equal(incompleteOf(text), false);
  assert.equal(verdictOf(text), "fail");
});

test("incompleteOf: only the first verdict line decides; a phrase quoted later is false", () => {
  assert.equal(incompleteOf("VERDICT: FAIL\n1. FAIL: src/x.ts:3 broken\n2. PASS: agents/reviewer.md:23 adds the `VERDICT: FAIL INCOMPLETE` rule"), false);
  assert.equal(incompleteOf("VERDICT: PASS\n1. PASS: agents/reviewer.md:23 adds the `VERDICT: FAIL INCOMPLETE` rule"), false);
  assert.equal(incompleteOf("**VERDICT:** FAIL INCOMPLETE\n1. PASS a"), true);
});

test("incompleteOf: FAIL and INCOMPLETE must share a line; spaces and tabs between them are fine", () => {
  assert.equal(incompleteOf("VERDICT: FAIL\nIncomplete: checks 3 and 4 were not run (turn cap)\n1. FAIL: src/x.ts:3 broken"), false);
  assert.equal(incompleteOf("VERDICT: FAIL  INCOMPLETE\n1. PASS a"), true);
  assert.equal(incompleteOf("VERDICT: FAIL\tINCOMPLETE\n1. PASS a"), true);
});
