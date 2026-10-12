import { test } from "node:test";
import assert from "node:assert/strict";
import type { PlanRecord } from "../checkpoint.ts";
import { effectivePlannerMode, plannerMode, plannerNotBelow, selfPlanRequired } from "../plannerself.ts";
import { emptySteps, finishRefusal, initialReviewGate, onReviewVerdicts, openSteps, requiredSteps, type Step } from "../bound.ts";

const REQUIRED = { heavy: ["planner", "builder", "reviewer", "finalizer"] };
const heavy = requiredSteps(REQUIRED, "heavy");
const plan = (status: PlanRecord["status"]): PlanRecord => ({ topic: "t", path: "/p", hash: "h", status, approvedAt: null, by: null });
const cfg = (childPolicy: string | undefined, ranks = [{ match: "big*", tier: 1 }, { match: "mid*", tier: 2 }, { match: "small*", tier: 3 }]) => ({ ladder: childPolicy ? { childPolicy } : {}, providers: { p: { ranks } } });

test("planner mode: self by default, role only when set so; a fallback wins", () => {
  assert.equal(plannerMode(undefined), "self");
  assert.equal(plannerMode({ ceremony: { planner: "bogus" } }), "self");
  assert.equal(plannerMode({ ceremony: { planner: "role" } }), "role");
  assert.equal(effectivePlannerMode({ ceremony: { planner: "role" } }, true), "self");
  assert.equal(effectivePlannerMode({ ceremony: { planner: "role" } }, false), "role");
});

test("planner self: requiredOf drops planner only with an approved plan record", () => {
  assert.deepEqual(selfPlanRequired(heavy, "self", plan("approved")), ["builder", "reviewer", "finalizer"]);
  for (const st of ["pending", "revise", "rejected"] as const) assert.deepEqual(selfPlanRequired(heavy, "self", plan(st)), heavy, st);
  assert.deepEqual(selfPlanRequired(heavy, "self", null), heavy, "no record: a stale file on disk never counts");
});

test("planner role: unchanged even with an approved plan", () => {
  assert.deepEqual(selfPlanRequired(heavy, "role", plan("approved")), heavy);
});

test("planner fallback: tier compare is direct, whatever childPolicy says", () => {
  for (const policy of [undefined, "below", "at-or-below", "any"]) {
    assert.equal(plannerNotBelow(cfg(policy), "p/big-1", "p/big-2"), true, `equal tier, ${policy}`);
    assert.equal(plannerNotBelow(cfg(policy), "p/mid-1", "p/big-2"), true, `planner above, ${policy}`);
    assert.equal(plannerNotBelow(cfg(policy), "p/big-1", "p/mid-2"), false, `planner below, ${policy}`);
  }
});

test("planner fallback: an unranked planner or foreman model counts as not below; no ranks at all is inert", () => {
  assert.equal(plannerNotBelow(cfg(undefined), "p/big-1", "p/mystery"), true);
  assert.equal(plannerNotBelow(cfg(undefined), "p/mystery", "p/small-1"), true);
  assert.equal(plannerNotBelow(cfg(undefined), null, "p/small-1"), true);
  assert.equal(plannerNotBelow({}, "p/big-1", "p/small-1"), false);
  assert.equal(plannerNotBelow({ providers: { p: { ranks: [] } } }, "p/big-1", "p/big-1"), false);
});

test("finish gate: heavy, self plan approved, plan-review PASS, builder, reviewer PASS, finalizer -> nothing missing", () => {
  const counts = emptySteps();
  const req = (): Step[] => selfPlanRequired(heavy, "self", plan("approved"));
  // plan-review PASS never feeds the reviewer gate (occasion.ts); the builder and finalizer runs count.
  counts.builder = 1;
  counts.finalizer = 1;
  assert.deepEqual(openSteps(counts, req(), "pass", initialReviewGate()), ["reviewer"], "reviewer still open before its verdict");
  const passed = onReviewVerdicts(initialReviewGate(), ["pass"]);
  const open = openSteps(counts, req(), "pass", passed);
  assert.deepEqual(open, []);
  assert.doesNotMatch(finishRefusal("heavy", open), /planner|reviewer/);
});

test("finish gate: no approved plan keeps the planner step open; with review verdicts present reviewer is not missing", () => {
  const counts = { ...emptySteps(), builder: 1, finalizer: 1 };
  const passed = onReviewVerdicts(initialReviewGate(), ["pass"]);
  assert.deepEqual(openSteps(counts, selfPlanRequired(heavy, "self", plan("pending")), "pass", passed), ["planner"]);
  // reviewGate verdict mode: any review verdict (the reviewer run counted) satisfies the reviewer step
  assert.deepEqual(openSteps({ ...counts, reviewer: 1 }, selfPlanRequired(heavy, "self", plan("approved")), "verdict", onReviewVerdicts(initialReviewGate(), ["fail"])), []);
});
