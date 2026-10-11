import { test } from "node:test";
import assert from "node:assert/strict";
import { PlanReviews, planReviewHash, planReviewRounds, planReviewSection, type PlanVerdict } from "../planreview.ts";

const P = "/ws/.workflow/scratch/plan-x.md";
const [A, B, C] = ["# A\n", "# B\n", "# C\n"].map((s) => planReviewHash(Buffer.from(s)));
const v = (hash: string, verdict: "pass" | "fail"): PlanVerdict => ({ hash, verdict, model: "p/m-sonnet", findings: Promise.resolve([]) });

test("planReviewRounds: positive integer, else 2", () => {
  assert.deepEqual([planReviewRounds(undefined), planReviewRounds(0), planReviewRounds(1.5), planReviewRounds("3"), planReviewRounds(1), planReviewRounds(4)], [2, 2, 2, 2, 1, 4]);
});

test("planreview rounds: counted across a revision; below the cap a FAIL is refused", () => {
  const r = new PlanReviews();
  r.record(P, v(A, "fail"));
  assert.deepEqual(r.gate(P, A, 3), { refusal: "plan_revision_required", stale: false });
  r.record(P, v(B, "fail"));
  assert.deepEqual(r.gate(P, B, 3), { refusal: "plan_revision_required", stale: false }, "round 2 of 3");
  r.record(P, v(C, "fail"));
  const g = r.gate(P, C, 3);
  assert.ok("verdict" in g && g.capped === true && g.rounds === 3);
});

test("planreview rounds: cap reached with FAIL opens capped; a PASS never is", () => {
  const r = new PlanReviews();
  r.record(P, v(A, "fail"));
  r.record(P, v(B, "fail"));
  const g = r.gate(P, B);
  assert.ok("verdict" in g && g.capped === true && g.rounds === 2 && g.verdict.verdict === "fail");
  r.record(P, v(C, "pass"));
  const p = r.gate(P, C);
  assert.ok("verdict" in p && !p.capped);
});

test("planreview rounds: the capped dialog header names the rounds and the open findings", () => {
  const f = [{ file: "plan-x.md", line: 3, class: "missing-item", note: "x" }];
  const s = planReviewSection(v(A, "fail"), f, { rounds: 2, cap: 2 }).split("\n");
  assert.equal(s[0], "Plan review: FAIL after 2 of 2 rounds; open findings:");
  assert.equal(s[1], "  plan-x.md:3 missing-item x");
});
