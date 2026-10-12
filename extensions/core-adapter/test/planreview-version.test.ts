import { test } from "node:test";
import assert from "node:assert/strict";
import { planVersionHash } from "../checkpoint.ts";
import { PlanReviews, type PlanVerdict } from "../planreview.ts";

const P = "/ws/.workflow/scratch/plan-x.md";
const BODY = "# Plan\n\n## Approach\nA\n";
const h = (s: string): string => planVersionHash(Buffer.from(s));
const v = (hash: string, verdict: "pass" | "fail"): PlanVerdict => ({ hash, verdict, model: "p/m", findings: Promise.resolve([]) });

test("plan review versions: an appended ruling needs no new review", () => {
  const r = new PlanReviews();
  r.record(P, v(h(BODY), "pass"));
  const g = r.gate(P, h(`${BODY}\n## Ruling\nowner: ok\n`), 2);
  assert.ok("verdict" in g && g.verdict.verdict === "pass");
});

test("plan review versions: a body edit is a new version and needs a review (stale)", () => {
  const r = new PlanReviews();
  r.record(P, v(h(BODY), "pass"));
  assert.deepEqual(r.gate(P, h(BODY.replace("A", "B")), 2), { refusal: "plan_review_required", stale: true });
});

test("plan review versions: rounds count per version, not per review run", () => {
  const r = new PlanReviews();
  r.record(P, v(h(BODY), "fail"));
  r.record(P, v(h(BODY), "fail")); // same version reviewed again: still round 1
  assert.deepEqual(r.gate(P, h(BODY), 2), { refusal: "plan_revision_required", stale: false });
  const v2 = BODY.replace("A", "B");
  r.record(P, v(h(v2), "fail"));
  const g = r.gate(P, h(`${v2}\n## Ruling\nx\n`), 2);
  assert.ok("verdict" in g && g.capped === true && g.rounds === 2, "cap 2 honoured at the second version; the ruling append re-triggers nothing");
});
