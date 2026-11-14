// Different-model rule: the same model id under two provider names is the foreman's own model (automatic part only);
// a configured pair is used as set, also a self-pair or the same id on another provider, without a warning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOccasionOverrides, applyReviewModelRule, effectiveReviewer, missingPairWarning, modelIdOf, stakeOf } from "../reviewerclimb.ts";
import { entryOccasions } from "../occasion.ts";
import { sanitizeTrace } from "../trace.ts";

const cfg = (reviewModel: unknown) => ({ ceremony: { reviewModel } });
const opts = (config: Record<string, unknown>, foreman: string | null, extra: Record<string, unknown> = {}) => ({ config, foreman, maxThinking: "high", childMaxThinking: undefined, ...extra });

test("same id under another provider: the entry is the foreman's own and moves to a differing rung", () => {
  const roles = { reviewer: { model: "provB/model-x", strong: { model: "provB/model-y" } } };
  assert.deepEqual(effectiveReviewer("provB/model-x:high", roles, cfg({}), "provA/model-x"), { model: "provB/model-y", reason: "same_as_foreman" });
  const e: Record<string, unknown> = { agent: "reviewer", model: "provB/model-x:high" };
  const t = applyReviewModelRule(e, roles, opts(cfg({}), "provA/model-x"));
  assert.deepEqual(t.map(sanitizeTrace), [{ event: "review_model", role: "reviewer", from: "provB/model-x", to: "provB/model-y", reason: "same_as_foreman" }]);
  assert.equal(String(e.model).split(":")[0], "provB/model-y");
});

test("same id under another provider: a rung with that id is no candidate, no_alternative", () => {
  const roles = { reviewer: { model: "provC/model-x", strong: { model: "provB/model-x" } } };
  assert.deepEqual(effectiveReviewer("provB/model-x", roles, cfg({}), "provA/model-x"), { model: "provB/model-x", reason: "no_alternative" });
  const e: Record<string, unknown> = { agent: "reviewer", model: "provB/model-x:high" };
  assert.deepEqual(applyReviewModelRule(e, { reviewer: { model: "provB/model-x" } }, opts(cfg({}), "provA/model-x")).map((t) => t.reason), ["no_alternative"]);
  assert.equal(e.model, "provB/model-x:high");
});

test("same id under another provider: a string ceremony.reviewModel with that id is no fallback, no_alternative", () => {
  const roles = { reviewer: { model: "provA/model-x" } };
  assert.deepEqual(effectiveReviewer("provA/model-x", roles, cfg("provB/model-x"), "provA/model-x"), { model: "provA/model-x", reason: "no_alternative" });
  assert.deepEqual(effectiveReviewer("provA/model-x", roles, cfg("provB/model-y"), "provA/model-x"), { model: "provB/model-y", reason: "same_as_foreman" });
});

test("a pair onto the same id on another provider and a self-pair are used as set (paired), no matter the entry", () => {
  const roles = { reviewer: { model: "provB/model-y" } };
  assert.deepEqual(effectiveReviewer("provB/model-y", roles, cfg({ "provA/model-x": "provB/model-x" }), "provA/model-x"), { model: "provB/model-x", reason: "paired" });
  assert.deepEqual(effectiveReviewer("provB/model-y", roles, cfg({ "provA/model-x": "provA/model-x:high" }), "provA/model-x"), { model: "provA/model-x:high", reason: "paired" });
  const e: Record<string, unknown> = { agent: "reviewer", model: "provA/model-x" };
  assert.deepEqual(applyReviewModelRule(e, roles, opts(cfg({ "provA/model-x": "provA/model-x" }), "provA/model-x")).map((t) => [t.to, t.reason]), [["provA/model-x", "paired"]]);
  assert.equal(e.model, "provA/model-x");
});

test("an occasion-pinned model with the foreman's id on another provider is the foreman's own: the pair, else the next differing rung", () => {
  const roles = { reviewer: { model: "provB/model-x", strong: { model: "provB/model-y" } } };
  assert.deepEqual(effectiveReviewer("provB/model-x", roles, cfg({ "provA/model-x": "provC/model-z" }), "provA/model-x", true, true), { model: "provC/model-z", reason: "paired" });
  assert.deepEqual(effectiveReviewer("provB/model-x", roles, cfg({}), "provA/model-x", true, true), { model: "provB/model-y", reason: "same_as_foreman" });
  // a differing occasion model stays pinned
  assert.deepEqual(effectiveReviewer("provB/model-w", roles, cfg({ "provA/model-x": "provC/model-z" }), "provA/model-x", true, true), { model: "provB/model-w", reason: "paired_skipped" });
  const e: Record<string, unknown> = { agent: "reviewer", model: "provB/model-x" };
  const t = applyReviewModelRule(e, roles, opts(cfg({}), "provA/model-x", { pinned: new Map([[e, "occasion" as const]]) }));
  assert.deepEqual(t.map((r) => r.reason), ["same_as_foreman"]);
});

test("missingPairWarning: fires for the same id on another provider without a pair; silent for a self-pair and a cross-provider pair", () => {
  const roles = { reviewer: { model: "provB/model-x" } };
  assert.match(missingPairWarning(cfg({}), roles, "provA/model-x") ?? "", /no reviewer pair for foreman model provA\/model-x: the reviewer would run on the foreman's own model/);
  assert.equal(missingPairWarning(cfg({ "provA/model-x": "provA/model-x" }), roles, "provA/model-x"), null);
  assert.equal(missingPairWarning(cfg({ "provA/model-x": "provB/model-x" }), roles, "provA/model-x"), null);
  assert.equal(missingPairWarning(cfg({}), { reviewer: { model: "provB/model-y" } }, "provA/model-x"), null);
});

test("modelIdOf: level and the provider up to the first slash dropped; a bare id compares as itself", () => {
  assert.equal(modelIdOf("provA/vendor/model-x"), "vendor/model-x");
  assert.equal(modelIdOf("provA/model-x:high"), "model-x");
  assert.equal(modelIdOf("model-x"), "model-x");
  assert.equal(modelIdOf("model-x:low"), "model-x");
});

// High stakes: a differing ceremony.highStakes.model wins over a self-pair for the foreman.
test("high stakes: a differing highStakes.model wins over a self-pair (paired_skipped, review_stakes model_applied)", () => {
  const roles = { reviewer: { model: "provA/model-r" } };
  const config = { ceremony: { reviewModel: { "provA/model-x": "provA/model-x" }, highStakes: { model: "provB/model-z" } } };
  const input: Record<string, unknown> = { agent: "reviewer", task: "[second-opinion] x", model: "provA/model-r" };
  const occasions = entryOccasions(input);
  const stakes = new Map<Record<string, unknown>, NonNullable<ReturnType<typeof stakeOf>>>();
  for (const [e, occ] of occasions) {
    const st = stakeOf(occ, "standard", [], null, config);
    if (st) stakes.set(e, st);
  }
  const occ = applyOccasionOverrides(input, occasions, [], { config, maxThinking: "high", childMaxThinking: undefined, stakes });
  const pinned = new Map([...occ.overrode].map((e) => [e, "occasion" as const]));
  const rule = applyReviewModelRule(input, roles, opts(config, "provA/model-x", { thinking: occ.thinking, pinned }));
  assert.equal(String(input.model).split(":")[0], "provB/model-z");
  assert.deepEqual(rule.map((r) => [r.reason, r.pin]), [["paired_skipped", "occasion"]]);
  assert.deepEqual(occ.traces.filter((t) => t.event === "review_stakes").map((t) => t.model_applied), [true]);
});
