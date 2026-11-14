// Review occasion models: as set (no rank refusal), the pair fallback and the missing-pair warning. ceremony.highStakes.model plays no part here (highstakes.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOccasionOverrides, applyReviewModelRule, effectiveReviewer, missingPairWarning } from "../reviewerclimb.ts";
import { entryOccasions } from "../occasion.ts";

const ROLES = { reviewer: { model: "provider-a/mid", strong: { model: "provider-a/big", thinking: "high" } } };
const cfg = (ceremony: Record<string, unknown>) => ({ ceremony });

function launch(config: Record<string, unknown>, input: Record<string, unknown>, o: { foreman?: string } = {}) {
  const occasions = entryOccasions(input);
  const occ = applyOccasionOverrides(input, occasions, [], { config, maxThinking: "high", childMaxThinking: undefined });
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

test("item 3: no occasion model: nothing changes", () => {
  const input: Record<string, unknown> = { agent: "reviewer", task: "items 1", model: "provider-a/mid" };
  const { occ } = launch(cfg({}), input);
  assert.deepEqual([occ.traces, [...occ.overrode], input.model], [[], [], "provider-a/mid"]);
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
