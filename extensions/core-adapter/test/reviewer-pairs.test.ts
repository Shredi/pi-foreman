// Reviewer pairs (idle-router PR B): ceremony.reviewModel as a map keyed by the foreman's live model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyReviewModelRule, effectiveReviewer } from "../reviewerclimb.ts";
import { sanitizeTrace } from "../trace.ts";
import { modelGaps } from "../modelcheck.ts";

test("modelcheck lists the pair values, labelled ceremony.reviewModel[<key>]", () => {
  const registry = { find: (p: string, id: string) => (id === "known" ? { provider: p, id } : undefined), getProviderAuthStatus: () => ({ configured: true }) };
  const config = { ceremony: { reviewModel: { "a/big": "b/known:high", "b/mid": "b/missing", "c/x": 3 } } };
  assert.deepEqual(modelGaps(config, "a", registry), ["model b/missing (ceremony.reviewModel[b/mid]) is not in the model registry"]);
});

const ROLES = { reviewer: { model: "a/mid", strong: { model: "a/big", thinking: "high" } } };
const cfg = (reviewModel: unknown) => ({ ceremony: { reviewModel } });
const opts = (config: Record<string, unknown>, foreman: string | null, extra: Record<string, unknown> = {}) => ({ config, foreman, maxThinking: "high", childMaxThinking: undefined, ...extra });

test("effectiveReviewer: reasons table", () => {
  const map = cfg({ "b/y": "a/small:low", "a/big": "b/z" });
  assert.deepEqual(effectiveReviewer("a/mid", ROLES, map, "b/y"), { model: "a/small:low", reason: "paired" });
  assert.deepEqual(effectiveReviewer("a/mid:high", ROLES, map, "b/y:medium"), { model: "a/small:low", reason: "paired" }); // levels ignored in the lookup
  assert.deepEqual(effectiveReviewer("a/mid", ROLES, map, "b/y", true), { model: "a/mid", reason: "paired_skipped" });
  assert.deepEqual(effectiveReviewer("a/mid", ROLES, map, "c/other"), { model: "a/mid", reason: "distinct" });
  assert.deepEqual(effectiveReviewer("a/mid", ROLES, map, "a/mid"), { model: "a/big:high", reason: "same_as_foreman" });
  assert.deepEqual(effectiveReviewer("a/big", ROLES, cfg("c/fb"), "a/big"), { model: "c/fb", reason: "same_as_foreman" });
  assert.deepEqual(effectiveReviewer("a/big", { reviewer: { model: "a/big" } }, cfg({}), "a/big"), { model: "a/big", reason: "no_alternative" });
  assert.deepEqual(effectiveReviewer("a/mid", ROLES, cfg({ "b/y": "a/mid" }), "b/y"), { model: "a/mid", reason: "distinct" }); // pair to the entry's own base: nothing to change
});

test("the string form is unchanged: an entry that is the foreman's moves, others stay", () => {
  const same: Record<string, unknown> = { agent: "reviewer", model: "a/mid" };
  assert.deepEqual(applyReviewModelRule(same, ROLES, opts(cfg("c/fb"), "a/mid")).map((t) => [t.to, t.reason]), [["a/big", "same_as_foreman"]]);
  const other: Record<string, unknown> = { agent: "reviewer", model: "a/mid" };
  assert.deepEqual(applyReviewModelRule(other, ROLES, opts(cfg("c/fb"), "b/y")), []);
  assert.equal(other.model, "a/mid");
});

test("pair map: the live foreman model's pair replaces the role-mapped model, level capped, traced paired", () => {
  const one: Record<string, unknown> = { tasks: [{ agent: "reviewer", model: "a/mid" }, { agent: "finalizer", model: "a/mid" }] };
  const t = applyReviewModelRule(one, ROLES, opts(cfg({ "b/y": "a/big:max" }), "b/y", { maxThinking: "medium" }));
  assert.deepEqual(t.map(sanitizeTrace), [{ event: "review_model", role: "reviewer", from: "a/mid", to: "a/big", reason: "paired" }]);
  assert.deepEqual((one.tasks as Record<string, unknown>[]).map((e) => e.model), ["a/big:medium", "a/mid"]);
});

test("pair map: a foreman model without a pair falls back to today's rule (same-model walk, else distinct)", () => {
  const map = cfg({ "b/y": "a/big" });
  const same: Record<string, unknown> = { agent: "reviewer", model: "a/mid" };
  assert.deepEqual(applyReviewModelRule(same, ROLES, opts(map, "a/mid")).map((t) => t.reason), ["same_as_foreman"]);
  const distinct: Record<string, unknown> = { agent: "reviewer", model: "a/mid" };
  assert.deepEqual(applyReviewModelRule(distinct, ROLES, opts(map, "c/z")), []);
  assert.equal(distinct.model, "a/mid");
});

test("pair map: a pair wins over the same-model walk, even when the entry is the foreman's model", () => {
  const e: Record<string, unknown> = { agent: "reviewer", model: "a/mid" };
  assert.deepEqual(applyReviewModelRule(e, ROLES, opts(cfg({ "a/mid": "c/other" }), "a/mid")).map((t) => [t.to, t.reason]), [["c/other", "paired"]]);
  assert.equal(e.model, "c/other");
});

test("pair map: an occasion thinking override replaces the pair's level; policy_override when the rank policy refuses", () => {
  const e: Record<string, unknown> = { agent: "reviewer", model: "a/mid" };
  const thinking = new Map<unknown, "low">([[e, "low"]]);
  const t = applyReviewModelRule(e, ROLES, opts(cfg({ "b/y": "a/big:high" }), "b/y", { thinking, refused: () => true }));
  assert.equal(e.model, "a/big:low");
  assert.equal(t[0].policy_override, true);
});

test("pair map: a pinned entry keeps its model; paired_skipped carries the pin; one pin of each kind", () => {
  const entries = [{ agent: "reviewer", model: "a/mid" }, { agent: "reviewer", model: "a/mid" }, { agent: "reviewer", model: "a/mid" }, { agent: "reviewer", model: "a/mid" }];
  const pinned = new Map<unknown, "explicit" | "security_rung" | "occasion">([[entries[0], "explicit"], [entries[1], "security_rung"], [entries[2], "occasion"]]);
  const t = applyReviewModelRule({ tasks: entries }, ROLES, opts(cfg({ "b/y": "a/big" }), "b/y", { pinned }));
  assert.deepEqual(t.map(sanitizeTrace), [
    { event: "review_model", role: "reviewer", from: "a/mid", to: "a/mid", reason: "paired_skipped", pin: "explicit" },
    { event: "review_model", role: "reviewer", from: "a/mid", to: "a/mid", reason: "paired_skipped", pin: "security_rung" },
    { event: "review_model", role: "reviewer", from: "a/mid", to: "a/mid", reason: "paired_skipped", pin: "occasion" },
    { event: "review_model", role: "reviewer", from: "a/mid", to: "a/big", reason: "paired" },
  ]);
  assert.deepEqual(entries.map((e) => e.model), ["a/mid", "a/mid", "a/mid", "a/big"]);
});

test("pair map: invalid values and keys without a slash are ignored; a null foreman does nothing", () => {
  const map = cfg({ "b/y": 3, "noslash": "a/big", "c/w": "  " });
  for (const f of ["b/y", "noslash", "c/w"]) {
    const e: Record<string, unknown> = { agent: "reviewer", model: "a/mid" };
    assert.deepEqual(applyReviewModelRule(e, ROLES, opts(map, f)), []);
    assert.equal(e.model, "a/mid");
  }
  const e: Record<string, unknown> = { agent: "reviewer", model: "a/mid" };
  assert.deepEqual(applyReviewModelRule(e, ROLES, opts(cfg({ "b/y": "a/big" }), null)), []);
});
