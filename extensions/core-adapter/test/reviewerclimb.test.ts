import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLaunchModels } from "../launchmodel.ts";
import { rankRefusal } from "../ranks.ts";
import { applyOnFindRungs, applyReviewModelRule, applySecurityRungs, defaultSecurityRung, failItemsOf, markPolicyOverrides, OnFindClimb, planReviewerClimbs, ReviewerFails, reviewerTextsOfRunEnd } from "../reviewerclimb.ts";

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
  const withStrong = { ...ROLES, builder: { model: "p/m-haiku", strong: { model: "p/m-opus", thinking: "high" } } };
  assert.equal(defaultSecurityRung(RANKS, withStrong), "p/m-opus:high");
  assert.equal(defaultSecurityRung({}, withStrong), null);
  // a role's plain model may come from the project layer: never a candidate (only strong rungs and literal ranks)
  assert.equal(defaultSecurityRung(RANKS, { ...ROLES, explorer: { model: "p/m-opus" } }), null);
  const literal = { providers: { p: { ranks: [{ match: "m-opus-1", tier: 1 }, ...RANKS.providers.p.ranks] } } };
  assert.equal(defaultSecurityRung(literal, ROLES), "p/m-opus-1");
  const on = { ladder: { reviewerClimb: { enabled: true } } };
  const ranked = await planReviewerClimbs({ agent: "reviewer", task: "t" }, withStrong, { config: { ...RANKS, ...on }, live: new Map(), fails: new ReviewerFails(), diffOf: async () => AUTH_DIFF });
  assert.deepEqual(ranked.climbs.map((c) => [c.reason, c.model]), [["security", "p/m-opus:high"]]);
  const none = await run(on, { agent: "reviewer", task: "t" }, new ReviewerFails(), AUTH_DIFF);
  assert.deepEqual([none.climbs, none.traces], [[], [{ event: "security_rung_unset", role: "reviewer", reason: "security", hits: "path:auth" }]]);
});

test("no security hit and no repeated FAIL: no climb", async () => {
  const r = await run({ ladder: { reviewerClimb: { enabled: true, securityRung: "p/m-opus" } } }, { agent: "reviewer", task: "t" });
  assert.deepEqual([r.climbs, r.traces], [[], []]);
});

test("security rung over the child rank policy: the trace carries policy_override, a rung within it does not", async () => {
  const climb = { enabled: true, securityRung: "p/m-opus" };
  const cfg = { ...RANKS, ladder: { childPolicy: "below", reviewerClimb: climb } };
  const refused = (m: string): boolean => rankRefusal(cfg, "p/m-opus", m) !== null;
  const over = await run(cfg, { agent: "reviewer", task: "t" }, new ReviewerFails(), AUTH_DIFF);
  markPolicyOverrides(over.climbs, refused);
  assert.equal(over.climbs[0].trace.policy_override, true);
  climb.securityRung = "p/m-sonnet";
  const within = await run(cfg, { agent: "reviewer", task: "t" }, new ReviewerFails(), AUTH_DIFF);
  markPolicyOverrides(within.climbs, refused);
  assert.deepEqual([within.climbs[0].trace.event, "policy_override" in within.climbs[0].trace], ["rung_up", false]);
});

const ON_FIND = { ladder: { reviewerClimb: { enabled: true, mode: "on-find" } } };
/** Plan one reviewer launch with the on-find climb, then write the models as index.ts does. */
async function launch(climb: OnFindClimb, config: Record<string, unknown> = ON_FIND, diff: string | null = PLAIN_DIFF, fails = new ReviewerFails()) {
  const input: Record<string, unknown> = { agent: "reviewer", task: "t" };
  const r = await planReviewerClimbs(input, ROLES, { config, live: new Map(), fails, climb, diffOf: async () => diff });
  applyLaunchModels(input, ROLES, "high");
  applyOnFindRungs(r.climbs, "high", undefined);
  applySecurityRungs(r.climbs, "high", undefined);
  return { model: input.model, traces: r.climbs.map((c) => c.trace) };
}

test("on-find: rung 0 FAIL climbs, the next launch runs on rung 1, its clean PASS ends the climb after two rungs", async () => {
  const climb = new OnFindClimb();
  assert.deepEqual(await launch(climb), { model: "p/m-haiku:medium", traces: [] });
  assert.deepEqual(climb.onVerdict("r1", ["1"], "fail", false, "p/m-haiku:medium", "L"), [{ event: "rung_up", role: "reviewer", from: "p/m-haiku", to: "p/m-sonnet", reason: "on_find", item: "1" }]);
  const second = await launch(climb);
  assert.deepEqual(second, { model: "p/m-sonnet:medium", traces: [{ event: "rung_up", role: "reviewer", from: "p/m-haiku", to: "p/m-sonnet", reason: "on_find", rung: 1 }] });
  assert.deepEqual(climb.onVerdict("r2", ["1"], "pass", false, "p/m-sonnet", "L"), [{ event: "climb_done", role: "reviewer", rungs: 2, reason: "clean", item: "1" }]);
  assert.equal(climb.launchRung(), 0);
});

test("on-find: a finding on the top rung ends the climb as exhausted", async () => {
  const climb = new OnFindClimb();
  await launch(climb);
  climb.onVerdict("r1", ["2"], "fail", false, "p/m-haiku", "L");
  assert.deepEqual(climb.onVerdict("r2", ["2"], "fail", false, "p/m-sonnet", "L"), [{ event: "climb_done", role: "reviewer", rungs: 2, reason: "exhausted", item: "2" }]);
  assert.equal(climb.launchRung(), 0);
});

test("on-find: rungs are per item; a ledger change resets them", async () => {
  const climb = new OnFindClimb();
  climb.rungs = ["p/a", "p/b", "p/c"];
  climb.onVerdict("r1", ["1"], "fail", false, "p/a", "L");
  climb.onVerdict("r2", ["1"], "fail", false, "p/b", "L");
  assert.deepEqual(climb.onVerdict("r3", ["2"], "fail", false, "p/c", "L").map((t) => [t.item, t.from, t.to]), [["2", "p/a", "p/b"]]);
  assert.equal(climb.launchRung(), 2);
  climb.onVerdict("r3", ["2"], "fail", false, "p/c", "L"); // same run: counted once
  climb.onVerdict("r4", ["1"], "pass", false, "p/c", "L");
  assert.equal(climb.launchRung(), 1);
  climb.onVerdict("r5", [], "fail", false, "p/a", "other ledger");
  assert.equal(climb.launchRung(), 0);
});

test("on-find: a PASS with located findings climbs; a clean first review never climbs", () => {
  const climb = new OnFindClimb();
  climb.rungs = ["p/a", "p/b"];
  assert.deepEqual(climb.onVerdict("r1", ["1"], "pass", false, "p/a", "L"), [{ event: "climb_done", role: "reviewer", rungs: 1, reason: "clean", item: "1" }]);
  assert.deepEqual(climb.onVerdict("r2", ["3"], "pass", true, "p/a", "L").map((t) => [t.event, t.reason]), [["rung_up", "on_find"]]);
  assert.equal(climb.launchRung(), 1);
});

test("on-find: a security-shaped diff jumps over the on-find rung; repeat-fail mode ignores the on-find climb", async () => {
  const climb = new OnFindClimb();
  const sec = { ladder: { reviewerClimb: { enabled: true, mode: "on-find", securityRung: "p/m-opus:max" } } };
  await launch(climb, sec);
  climb.onVerdict("r1", ["1"], "fail", false, "p/m-haiku", "L");
  const r = await launch(climb, sec, AUTH_DIFF);
  assert.deepEqual([r.model, r.traces.map((t) => t.reason)], ["p/m-opus:high", ["security"]]);
  const plain = await launch(climb, { ladder: { reviewerClimb: { enabled: true } } });
  assert.deepEqual(plain, { model: "p/m-haiku:medium", traces: [] });
});

test("different-model rule: same as the foreman moves to the next differing rung, else reviewModel, else stays", () => {
  const roles = { ...ROLES, reviewer: { model: "p/m-opus", strong: { model: "p/m-sonnet", thinking: "high" } } };
  const opts = (config: Record<string, unknown>) => ({ config, foreman: "p/m-opus", maxThinking: "medium", childMaxThinking: undefined });
  const one: Record<string, unknown> = { agent: "reviewer", model: "p/m-opus:high" };
  assert.deepEqual(applyReviewModelRule(one, roles, opts({})), [{ event: "review_model", role: "reviewer", from: "p/m-opus", to: "p/m-sonnet", reason: "same_as_foreman" }]);
  assert.equal(one.model, "p/m-sonnet:medium");
  const noStrong = { ...ROLES, reviewer: { model: "p/m-opus" } };
  const two: Record<string, unknown> = { tasks: [{ agent: "reviewer", model: "p/m-opus" }, { agent: "builder", model: "p/m-opus" }] };
  assert.deepEqual(applyReviewModelRule(two, noStrong, opts({ ceremony: { reviewModel: "q/other" } })).map((t) => [t.to, t.reason]), [["q/other", "same_as_foreman"]]);
  assert.deepEqual((two.tasks as Record<string, unknown>[]).map((e) => e.model), ["q/other", "p/m-opus"]);
  const three: Record<string, unknown> = { agent: "reviewer", model: "p/m-opus" };
  assert.deepEqual(applyReviewModelRule(three, noStrong, opts({})), [{ event: "review_model", role: "reviewer", from: "p/m-opus", to: "p/m-opus", reason: "no_alternative" }]);
  assert.equal(three.model, "p/m-opus");
  assert.deepEqual(applyReviewModelRule({ agent: "reviewer", model: "p/m-haiku" }, roles, opts({})), []);
});
