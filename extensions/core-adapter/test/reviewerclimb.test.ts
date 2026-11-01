import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLaunchModels } from "../launchmodel.ts";
import { rankRefusal } from "../ranks.ts";
import { applyOccasionOverrides, applyReviewModelRule, applySecurityRungs, defaultSecurityRung, failItemsOf, markPolicyOverrides, planReviewerClimbs, ReviewerFails, reviewerTextsOfRunEnd } from "../reviewerclimb.ts";
import { entryOccasions } from "../occasion.ts";
import { sanitizeTrace } from "../trace.ts";

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
  const end = { results: [{ agent: "reviewer", status: "completed", success: true, output: "1. FAIL" }, { agent: "builder", status: "completed", success: true, output: "1. FAIL" }] };
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

const byOcc = (table: Record<string, unknown>, climb: Record<string, unknown> = { enabled: true }) => ({ ladder: { reviewerClimb: climb }, ceremony: { reviewByOccasion: table } });
/** One launch in index.ts order: climbs, mapped models, occasion overrides, security rung, different-model rule. */
async function occLaunch(config: Record<string, unknown>, input: Record<string, unknown>, o: { maxThinking?: string; childMaxThinking?: string; fails?: ReviewerFails; diff?: string | null } = {}) {
  const occasions = entryOccasions(input);
  const max = o.maxThinking ?? "high";
  const r = await planReviewerClimbs(input, ROLES, { config, live: new Map(), fails: o.fails ?? new ReviewerFails(), diffOf: async () => o.diff ?? PLAIN_DIFF });
  applyLaunchModels(input, ROLES, max, { childMaxThinking: o.childMaxThinking });
  const occ = applyOccasionOverrides(input, occasions, r.climbs, { config, maxThinking: max, childMaxThinking: o.childMaxThinking });
  applySecurityRungs(r.climbs, max, o.childMaxThinking);
  const rule = applyReviewModelRule(input, ROLES, { config, foreman: "p/m-opus", maxThinking: max, childMaxThinking: o.childMaxThinking, thinking: occ.thinking });
  return { traces: occ.traces, rule };
}

test("reviewByOccasion: a pre-pr launch gets high thinking while an item launch stays medium; traced review_occasion", async () => {
  const input: Record<string, unknown> = { tasks: [{ agent: "reviewer", task: "items 1" }, { agent: "reviewer", task: "branch [pre-pr]" }] };
  const { traces } = await occLaunch(byOcc({ "pre-pr": { thinking: "high" } }), input);
  assert.deepEqual((input.tasks as Record<string, unknown>[]).map((e) => e.model), ["p/m-haiku:medium", "p/m-haiku:high"]);
  assert.deepEqual(traces.map(sanitizeTrace), [{ event: "review_occasion", role: "reviewer", occasion: "pre-pr", thinking: "high", model_overridden: false }]);
});

test("reviewByOccasion: a model override equal to the foreman's is moved by the different-model rule; its thinking stays", async () => {
  const input: Record<string, unknown> = { agent: "reviewer", task: "items 1" };
  const { traces, rule } = await occLaunch(byOcc({ item: { model: "p/m-opus", thinking: "high" } }), input);
  assert.deepEqual(traces.map((t) => [t.occasion, t.thinking, t.model_overridden]), [["item", "high", true]]);
  assert.deepEqual(rule.map((t) => [t.from, t.to, t.reason]), [["p/m-opus", "p/m-haiku", "same_as_foreman"]]);
  assert.equal(input.model, "p/m-haiku:high");
});

test("reviewByOccasion: the thinking override is capped by maxThinking and childMaxThinking", async () => {
  const one: Record<string, unknown> = { agent: "reviewer", task: "[pre-pr]" };
  const capped = await occLaunch(byOcc({ "pre-pr": { thinking: "high" } }), one, { maxThinking: "medium" });
  assert.deepEqual([one.model, capped.traces[0].thinking], ["p/m-haiku:medium", "medium"]);
  const two: Record<string, unknown> = { agent: "reviewer", task: "[pre-pr]" };
  await occLaunch(byOcc({ "pre-pr": { thinking: "high" } }), two, { childMaxThinking: "low" });
  assert.equal(two.model, "p/m-haiku:low");
});

test("reviewByOccasion: a repeat-fail or security climb beats the model override; the thinking override still applies", async () => {
  const fails = new ReviewerFails();
  fails.onRun("a", ["1. FAIL"], null);
  fails.onRun("b", ["1. FAIL"], null);
  const table = { item: { model: "q/other", thinking: "high" } };
  const rep: Record<string, unknown> = { agent: "reviewer", task: "items 1" };
  const r = await occLaunch(byOcc(table), rep, { fails });
  assert.deepEqual([rep.model, r.traces[0].model_overridden], ["p/m-sonnet:high", false]);
  const sec: Record<string, unknown> = { agent: "reviewer", task: "items 1" };
  await occLaunch(byOcc({ item: { model: "q/other", thinking: "low" } }, { enabled: true, securityRung: "p/m-sonnet:max" }), sec, { diff: AUTH_DIFF });
  assert.equal(sec.model, "p/m-sonnet:low");
});

test("reviewByOccasion: unknown occasion keys and invalid values are ignored", async () => {
  const input: Record<string, unknown> = { agent: "reviewer", task: "items 1" };
  const { traces } = await occLaunch(byOcc({ plan: { thinking: "high" }, item: { thinking: "max", model: 3 }, "pre-pr": "high" }), input);
  assert.deepEqual([input.model, traces], ["p/m-haiku:medium", []]);
  assert.deepEqual(applyOccasionOverrides(input, entryOccasions(input), [], { config: { ceremony: {} }, maxThinking: "high", childMaxThinking: undefined }).traces, []);
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
