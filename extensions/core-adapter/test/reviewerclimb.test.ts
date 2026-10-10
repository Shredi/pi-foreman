import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLaunchModels } from "../launchmodel.ts";
import { applySecurityRungs, defaultSecurityRung, failItemsOf, planReviewerClimbs, ReviewerFails, reviewerTextsOfRunEnd } from "../reviewerclimb.ts";

const ROLES = {
  foreman: { model: "p/m-opus", thinking: "high" },
  builder: { model: "p/m-haiku", strong: { model: "p/m-sonnet" } },
  reviewer: { model: "p/m-haiku", thinking: "medium", strong: { model: "p/m-sonnet", thinking: "medium" } },
};
const RANKS = { providers: { p: { ranks: [{ match: "m-opus*", tier: 1 }, { match: "m-sonnet*", tier: 2 }, { match: "m-haiku*", tier: 3 }] } } };
const AUTH_DIFF = "diff --git a/src/auth/login.ts b/src/auth/login.ts\n+++ b/src/auth/login.ts\n@@ -1 +1 @@\n+const x = 1;\n";
const PLAIN_DIFF = "diff --git a/src/view.ts b/src/view.ts\n+++ b/src/view.ts\n@@ -1 +1 @@\n+const y = f.bind(this);\n";

const run = (config: Record<string, unknown>, input: Record<string, unknown>, fails = new ReviewerFails(), diff: string | null = PLAIN_DIFF, live = new Map<string, string>()) =>
  planReviewerClimbs(input, ROLES, { config, live, fails, diffOf: async () => diff });

test("failItemsOf: decorated N. FAIL lines, outside fences, without repeats", () => {
  const text = ["1. FAIL a.go:3", "- `2. FAIL` b", "**3) FAIL**", "* 4) `4. FAIL` doubled", "5. PASS", "the 6. FAIL in prose", "```", "7. FAIL fenced", "```", "1. FAIL again"].join("\n");
  assert.deepEqual(failItemsOf(text), ["1", "2", "3", "4"]);
});

test("ReviewerFails: an item counts once per reviewer run; the second run's FAIL repeats it", () => {
  const f = new ReviewerFails();
  f.onRun("r1", ["1. FAIL x\n2. FAIL y\n1. FAIL again"], "L");
  f.onRun("r1", ["2. FAIL y"], "L"); // same run: not counted twice
  assert.equal(f.repeated(), null);
  f.onRun("r2", ["2. FAIL y"], "L");
  assert.equal(f.repeated(), "2");
  f.onRun("r3", ["2. FAIL y"], "other ledger");
  assert.equal(f.repeated(), null);
  const end = { results: [{ agent: "reviewer", status: "completed", success: true, output: "1. FAIL" }, { agent: "senior-reviewer", status: "completed", success: true, output: "1. FAIL" }] };
  assert.deepEqual(reviewerTextsOfRunEnd(end), ["1. FAIL"]);
});

test("disabled by default: no climb, no diff taken", async () => {
  const fails = new ReviewerFails();
  fails.onRun("a", ["1. FAIL"], null);
  fails.onRun("b", ["1. FAIL"], null);
  let diffs = 0;
  const input = { agent: "reviewer", task: "t" };
  const r = await planReviewerClimbs(input, ROLES, { config: {}, live: new Map(), fails, diffOf: async () => (diffs++, AUTH_DIFF) });
  assert.deepEqual([r.climbs, r.traces, diffs, "model" in input], [[], [], 0, false]);
});

test("second FAIL of the same item: the next reviewer launch goes one rung up to its strong model", async () => {
  const fails = new ReviewerFails();
  fails.onRun("a", ["3. FAIL"], null);
  const cfg = { ladder: { reviewerClimb: { enabled: true } } };
  assert.deepEqual((await run(cfg, { agent: "reviewer", task: "t" }, fails)).climbs, []);
  fails.onRun("b", ["3. FAIL"], null);
  const input: Record<string, unknown> = { agent: "reviewer", task: "t" };
  const r = await run(cfg, input, fails);
  assert.deepEqual(r.climbs.map((c) => c.trace), [{ event: "rung_up", role: "reviewer", from: "p/m-haiku", to: "p/m-sonnet", reason: "review_fail_repeat", item: "3" }]);
  applyLaunchModels(input, ROLES, "high");
  assert.equal(input.model, "p/m-sonnet:medium");
  // already on the strong rung: rung_top; an explicit model from the foreman is left alone
  const again = await run(cfg, { agent: "reviewer", task: "t" }, fails, PLAIN_DIFF, new Map([["reviewer", "p/m-sonnet:medium"]]));
  assert.deepEqual(again.climbs.map((c) => c.trace.event), ["rung_top"]);
  assert.deepEqual((await run(cfg, { agent: "reviewer", task: "t", model: "default" }, fails)).climbs, []);
});

test("security-shaped diff: the reviewer goes to securityRung, written after the models", async () => {
  const cfg = { ladder: { reviewerClimb: { enabled: true, securityRung: "p/m-opus:max" } } };
  const input: Record<string, unknown> = { tasks: [{ agent: "reviewer", task: "t" }, { agent: "builder", task: "b" }] };
  const r = await run(cfg, input, new ReviewerFails(), AUTH_DIFF);
  assert.deepEqual(r.climbs.map((c) => c.trace), [{ event: "rung_up", role: "reviewer", from: "p/m-haiku", to: "p/m-opus", reason: "security", hits: "path:auth" }]);
  applyLaunchModels(input, ROLES, "high");
  applySecurityRungs(r.climbs, "high", undefined);
  assert.deepEqual((input.tasks as Record<string, unknown>[]).map((e) => e.model), ["p/m-opus:high", "p/m-haiku"]);
});

test("security default rung: next rank above the reviewer's strong rung, else none with a trace", async () => {
  assert.equal(defaultSecurityRung(RANKS, ROLES), "p/m-opus:high");
  assert.equal(defaultSecurityRung({}, ROLES), null);
  const on = { ladder: { reviewerClimb: { enabled: true } } };
  const ranked = await run({ ...RANKS, ...on }, { agent: "reviewer", task: "t" }, new ReviewerFails(), AUTH_DIFF);
  assert.deepEqual(ranked.climbs.map((c) => [c.reason, c.model]), [["security", "p/m-opus:high"]]);
  const none = await run(on, { agent: "reviewer", task: "t" }, new ReviewerFails(), AUTH_DIFF);
  assert.deepEqual([none.climbs, none.traces], [[], [{ event: "security_rung_unset", role: "reviewer", reason: "security", hits: "path:auth" }]]);
});

test("no security hit and no repeated FAIL: no climb", async () => {
  const r = await run({ ladder: { reviewerClimb: { enabled: true, securityRung: "p/m-opus" } } }, { agent: "reviewer", task: "t" });
  assert.deepEqual([r.climbs, r.traces], [[], []]);
});
