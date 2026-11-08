// Review stakes: occasion models as set (no rank refusal), the pair fallback, ceremony.highStakes and the missing-pair warning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOccasionOverrides, applyReviewModelRule, diffPaths, effectiveReviewer, highStakesConfig, missingPairWarning, pathGlob, stakeOf } from "../reviewerclimb.ts";
import { entryOccasions } from "../occasion.ts";
import { sanitizeTrace } from "../trace.ts";

const ROLES = { reviewer: { model: "provider-a/mid", strong: { model: "provider-a/big", thinking: "high" } } };
const cfg = (ceremony: Record<string, unknown>) => ({ ceremony });
const WF = "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n+x\n";
const PLAIN = "diff --git a/src/view.ts b/src/view.ts\n+++ b/src/view.ts\n+x\n";

function launch(config: Record<string, unknown>, input: Record<string, unknown>, o: { tier?: string; tags?: string[]; diff?: string | null; foreman?: string } = {}) {
  const occasions = entryOccasions(input);
  const stakes = new Map<Record<string, unknown>, NonNullable<ReturnType<typeof stakeOf>>>();
  for (const [e, occ] of occasions) {
    const st = e.agent === "reviewer" ? stakeOf(occ, o.tier ?? "standard", o.tags ?? [], o.diff ?? PLAIN, config) : null;
    if (st) stakes.set(e, st);
  }
  const occ = applyOccasionOverrides(input, occasions, [], { config, maxThinking: "high", childMaxThinking: undefined, stakes });
  const pinned = new Map([...occ.overrode].map((e) => [e, "occasion" as const]));
  const rule = applyReviewModelRule(input, ROLES, { config, foreman: o.foreman ?? "provider-a/big", maxThinking: "high", childMaxThinking: undefined, thinking: occ.thinking, pinned });
  return { occ, rule };
}

test("item 1: an occasion model carries policy_override only through the caller; the entry is marked overridden and stays", () => {
  const input: Record<string, unknown> = { agent: "reviewer", task: "[plan-review] x", model: "provider-a/mid" };
  const { occ, rule } = launch(cfg({ reviewByOccasion: { "plan-review": { model: "provider-b/top" } } }), input);
  assert.equal(input.model, "provider-b/top");
  assert.deepEqual([...occ.overrode].length, 1);
  assert.equal(occ.traceOf.size, 1);
  assert.deepEqual(rule, []); // no pair, a differing base: distinct, nothing to trace
});

test("item 2: an occasion model equal to the foreman falls back to the pair, else today's rule; the occasion thinking applies to the model moved to", () => {
  const paired: Record<string, unknown> = { agent: "reviewer", task: "[second-opinion] x" };
  const config = { ceremony: { reviewByOccasion: { "second-opinion": { model: "provider-a/big", thinking: "low" }, }, reviewModel: { "provider-a/big": "provider-b/mid" } } };
  const a = launch(config, paired);
  assert.deepEqual(a.rule.map((t) => [t.to, t.reason]), [["provider-b/mid", "paired"]]);
  assert.equal(paired.model, "provider-b/mid:low");
  const rung: Record<string, unknown> = { agent: "reviewer", task: "[second-opinion] x" };
  const b = launch(cfg({ reviewByOccasion: { "second-opinion": { model: "provider-a/mid" } } }), rung, { foreman: "provider-a/mid" });
  assert.deepEqual(b.rule.map((t) => [t.to, t.reason]), [["provider-a/big", "same_as_foreman"]]);
  const stay: Record<string, unknown> = { agent: "reviewer", task: "[second-opinion] x" };
  const c = launch(cfg({ reviewByOccasion: { "second-opinion": { model: "provider-b/top" } }, reviewModel: { "provider-a/big": "provider-b/mid" } }), stay);
  assert.deepEqual(c.rule.map((t) => [t.reason, t.pin]), [["paired_skipped", "occasion"]]);
  assert.equal(stay.model, "provider-b/top");
});

test("item 4: without the occasion flag a pinned model keeps paired_skipped; roles and strong keep the different-model rule", () => {
  const pair = cfg({ reviewModel: { "provider-a/big": "provider-b/mid" } });
  assert.equal(effectiveReviewer("provider-a/big", ROLES, pair, "provider-a/big", true).reason, "paired_skipped");
  assert.equal(effectiveReviewer("provider-a/big", ROLES, pair, "provider-a/big", true, false).reason, "paired_skipped");
  assert.deepEqual(effectiveReviewer("provider-a/mid", ROLES, cfg({}), "provider-a/mid"), { model: "provider-a/big:high", reason: "same_as_foreman" });
  assert.deepEqual(effectiveReviewer("provider-a/mid", ROLES, pair, "provider-a/big"), { model: "provider-b/mid", reason: "paired" });
});

test("item 3: no occasion model, no stakes: nothing changes", () => {
  const input: Record<string, unknown> = { agent: "reviewer", task: "items 1", model: "provider-a/mid" };
  const { occ } = launch(cfg({}), input);
  assert.deepEqual([occ.traces, [...occ.overrode], input.model], [[], [], "provider-a/mid"]);
});

test("item 8: stakeOf rules", () => {
  const c = cfg({});
  assert.equal(stakeOf("item", "heavy", [], PLAIN, c), null);
  assert.deepEqual(stakeOf("plan-review", "trivial", [], null, c)?.reasons, ["occasion"]);
  assert.deepEqual(stakeOf("second-opinion", "standard", [], null, c)?.reasons, ["occasion"]);
  assert.deepEqual(stakeOf("pre-pr", "heavy", [], PLAIN, c)?.reasons, ["heavy_pre_pr"]);
  assert.equal(stakeOf("pre-pr", "standard", [], PLAIN, c), null);
  assert.deepEqual(stakeOf("item", "standard", ["parser", "guard"], PLAIN, c), { reasons: ["risk_tag"], tags: ["guard"] });
  assert.deepEqual(stakeOf("item", "standard", [], WF, c), { reasons: ["sensitive_path"], paths: [".github/workflows/ci.yml"] });
  assert.equal(stakeOf("item", "standard", [], WF, cfg({ highStakes: { paths: ["docs/**"] } })), null);
  assert.deepEqual(stakeOf("item", "standard", [], PLAIN, cfg({ highStakes: { paths: ["src/*.ts"] } }))?.paths, ["src/view.ts"]);
  assert.deepEqual(highStakesConfig(cfg({})), { model: null, paths: [".github/workflows/**"] });
  assert.equal(pathGlob("a/**/c", "a/c"), true);
  assert.equal(pathGlob("a/*", "a/b/c"), false);
  assert.deepEqual(diffPaths(WF + PLAIN), [".github/workflows/ci.yml", "src/view.ts"]);
});

test("item 8: highStakes.model applies on a high-stakes launch, as set; the occasion's own model wins; unset changes nothing", () => {
  const hs = cfg({ highStakes: { model: "provider-b/top" } });
  const plan: Record<string, unknown> = { agent: "reviewer", task: "[plan-review] x", model: "provider-a/mid" };
  const r = launch(hs, plan);
  assert.equal(plan.model, "provider-b/top");
  assert.deepEqual(r.occ.traces.map(sanitizeTrace), [{ event: "review_stakes", role: "reviewer", occasion: "plan-review", level: "high", reasons: "occasion", model_applied: true }]);
  const own: Record<string, unknown> = { agent: "reviewer", task: "[plan-review] x", model: "provider-a/mid" };
  const o = launch(cfg({ highStakes: { model: "provider-b/top" }, reviewByOccasion: { "plan-review": { model: "provider-b/other" } } }), own);
  assert.equal(own.model, "provider-b/other");
  assert.deepEqual(o.occ.traces.map((t) => [t.event, t.model_applied ?? t.model_overridden]), [["review_occasion", true], ["review_stakes", false]]);
  const none: Record<string, unknown> = { agent: "reviewer", task: "[plan-review] x", model: "provider-a/mid" };
  const n = launch(cfg({}), none);
  assert.equal(none.model, "provider-a/mid");
  assert.deepEqual(n.occ.traces.map((t) => [t.event, t.model_applied]), [["review_stakes", false]]);
  const item: Record<string, unknown> = { agent: "reviewer", task: "items 1", model: "provider-a/mid" };
  assert.deepEqual(launch(hs, item).occ.traces, []);
  assert.equal(item.model, "provider-a/mid");
});

test("item 8: heavy pre-pr, risk tag and workflow path each take highStakes.model; highStakes.model equal to the foreman falls back to the pair", () => {
  const hs = cfg({ highStakes: { model: "provider-b/top" } });
  const heavy: Record<string, unknown> = { agent: "reviewer", task: "branch [pre-pr]", model: "provider-a/mid" };
  assert.deepEqual(launch(hs, heavy, { tier: "heavy" }).occ.traces.map((t) => t.reasons), ["heavy_pre_pr"]);
  assert.equal(heavy.model, "provider-b/top");
  const std: Record<string, unknown> = { agent: "reviewer", task: "branch [pre-pr]", model: "provider-a/mid" };
  assert.deepEqual(launch(hs, std, { tier: "standard" }).occ.traces, []);
  const tag: Record<string, unknown> = { agent: "reviewer", task: "items 1", model: "provider-a/mid" };
  assert.deepEqual(launch(hs, tag, { tags: ["permission"] }).occ.traces.map((t) => t.tags), ["permission"]);
  const wf: Record<string, unknown> = { agent: "reviewer", task: "items 1", model: "provider-a/mid" };
  assert.deepEqual(launch(hs, wf, { diff: WF }).occ.traces.map((t) => t.paths), [1]);
  const same: Record<string, unknown> = { agent: "reviewer", task: "[plan-review] x", model: "provider-a/mid" };
  const r = launch(cfg({ highStakes: { model: "provider-a/big" }, reviewModel: { "provider-a/big": "provider-b/mid" } }), same);
  assert.equal(same.model, "provider-b/mid");
  assert.deepEqual(r.rule.map((t) => t.reason), ["paired"]);
});

test("item 9: missingPairWarning names the model and the key; pairs and differing reviewers stay silent", () => {
  const w = missingPairWarning(cfg({}), ROLES, "provider-a/mid");
  assert.match(w ?? "", /ceremony\.reviewModel\["provider-a\/mid"\]/);
  assert.match(w ?? "", /swapped/);
  assert.match(missingPairWarning(cfg({}), { reviewer: { model: "provider-a/big" } }, "provider-a/big") ?? "", /foreman's own model/);
  assert.match(missingPairWarning(cfg({}), {}, "provider-a/big") ?? "", /foreman's own model/);
  assert.equal(missingPairWarning(cfg({ reviewModel: { "provider-a/big": "provider-b/mid" } }), ROLES, "provider-a/big"), null);
  assert.equal(missingPairWarning(cfg({}), ROLES, "provider-c/other"), null);
  assert.equal(missingPairWarning(cfg({}), ROLES, null), null);
});
