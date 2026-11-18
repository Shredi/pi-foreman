// The last review verdict on the current tree wins at the finish gate and at close.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptySteps, initialReviewGate, onReviewVerdicts, onRevision, openSteps, requiredSteps, reviewHint, reviewVerdictsOfRunEnd } from "../bound.ts";
import { resultsOf, type RecSpec } from "./_verdict-rig.ts";

const req = requiredSteps({ standard: ["builder", "reviewer"] }, "standard");
const counts = emptySteps();
counts.builder = 1;
const child = (agent: string, output: string) => ({ agent, status: "completed", success: true, output });
const end = (...results: ReturnType<typeof child>[]) => ({ runId: "r", results });
const open = (g: ReturnType<typeof initialReviewGate>) => openSteps(counts, req, "pass", g);
const PASS: RecSpec = { verdict: "pass" };
const FAIL: RecSpec = { verdict: "fail", findings: [{ kind: "defect", text: "broken" }] };
/** The verdicts a run end of one reviewer that left `spec` gives the gate. */
const verdictsOf = (spec: RecSpec | null) => reviewVerdictsOfRunEnd(resultsOf(end(child("reviewer", "report")), spec));

test("a later PASS on the final tree clears an earlier FAIL: no open reviewer step, no hint", () => {
  const fail = onReviewVerdicts(initialReviewGate(), verdictsOf(FAIL), 1);
  assert.deepEqual(open(fail), ["reviewer"]);
  const fixed = onRevision(fail);
  assert.equal(reviewHint(fixed), "(re-review needed: last verdict FAIL)");
  const pass = onReviewVerdicts(fixed, verdictsOf(PASS), 2);
  assert.deepEqual(open(pass), []);
  assert.equal(reviewHint(pass), "");
});

test("a run end carries one record: a result next to a builder result in one event reads as no verdict (reviewers are single launches)", () => {
  const v = reviewVerdictsOfRunEnd(resultsOf(end(child("reviewer", "report"), child("builder", "fixed"), child("reviewer", "report")), PASS));
  assert.deepEqual(v, [null, null]);
  assert.deepEqual(open(onReviewVerdicts(initialReviewGate(), v, 1)), ["reviewer"]);
});

test("a run end whose reviewer left no record, or an incomplete one, gives no verdict", () => {
  assert.deepEqual(verdictsOf(null), [null]);
  assert.deepEqual(verdictsOf({ verdict: "incomplete", reason: "tests would not start" }), [null]);
  assert.deepEqual(open(onReviewVerdicts(onReviewVerdicts(initialReviewGate(), ["pass"], 1), verdictsOf(null), 2)), ["reviewer"]);
});

test("a FAIL after the last PASS still blocks; parallel reviewers on one tree: any FAIL wins", () => {
  const pass = onReviewVerdicts(initialReviewGate(), ["pass"], 1);
  const fail = onReviewVerdicts(pass, ["fail"], 2);
  assert.deepEqual(open(fail), ["reviewer"]);
  assert.equal(reviewHint(fail), "(re-review needed: last verdict FAIL)");
  assert.deepEqual(open(onReviewVerdicts(initialReviewGate(), ["pass", "fail"], 1)), ["reviewer"]);
});
