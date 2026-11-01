// The last review verdict on the current tree wins at the finish gate and at close.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptySteps, initialReviewGate, onReviewVerdicts, onRevision, openSteps, requiredSteps, reviewHint, reviewVerdictsOfRunEnd } from "../bound.ts";

const req = requiredSteps({ standard: ["builder", "reviewer"] }, "standard");
const counts = emptySteps();
counts.builder = 1;
const child = (agent: string, output: string) => ({ agent, status: "completed", success: true, output });
const end = (...results: ReturnType<typeof child>[]) => ({ runId: "r", results });
const open = (g: ReturnType<typeof initialReviewGate>) => openSteps(counts, req, "pass", g);

test("a later PASS on the final tree clears an earlier FAIL: no open reviewer step, no hint", () => {
  const fail = onReviewVerdicts(initialReviewGate(), reviewVerdictsOfRunEnd(end(child("reviewer", "VERDICT: FAIL"))), 1);
  assert.deepEqual(open(fail), ["reviewer"]);
  const fixed = onRevision(fail);
  assert.equal(reviewHint(fixed), "(re-review needed: last verdict FAIL)");
  const pass = onReviewVerdicts(fixed, reviewVerdictsOfRunEnd(end(child("reviewer", "VERDICT: PASS"))), 2);
  assert.deepEqual(open(pass), []);
  assert.equal(reviewHint(pass), "");
});

test("one run, results in order FAIL, builder, PASS: the PASS after the builder wins", () => {
  const v = reviewVerdictsOfRunEnd(end(child("reviewer", "VERDICT: FAIL"), child("builder", "fixed"), child("reviewer", "VERDICT: PASS")));
  assert.deepEqual(v, ["pass"]);
  assert.deepEqual(open(onReviewVerdicts(initialReviewGate(), v, 1)), []);
});

test("one run, results PASS, builder: the PASS before the builder does not count", () => {
  assert.deepEqual(reviewVerdictsOfRunEnd(end(child("reviewer", "VERDICT: PASS"), child("builder", "edit"))), []);
});

test("a FAIL after the last PASS still blocks; parallel reviewers on one tree: any FAIL wins", () => {
  const pass = onReviewVerdicts(initialReviewGate(), ["pass"], 1);
  const fail = onReviewVerdicts(pass, ["fail"], 2);
  assert.deepEqual(open(fail), ["reviewer"]);
  assert.equal(reviewHint(fail), "(re-review needed: last verdict FAIL)");
  const both = reviewVerdictsOfRunEnd(end(child("reviewer", "VERDICT: PASS"), child("reviewer", "VERDICT: FAIL")));
  assert.deepEqual(both, ["pass", "fail"]);
  assert.deepEqual(open(onReviewVerdicts(initialReviewGate(), both, 1)), ["reviewer"]);
});
