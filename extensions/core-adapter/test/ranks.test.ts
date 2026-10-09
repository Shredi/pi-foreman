import { test } from "node:test";
import assert from "node:assert/strict";
import { launchedModels, rankRefusal, ranksOf, tierOf } from "../ranks.ts";

const RANKS = {
  a: { ranks: [{ match: "top-*", tier: 0 }, { match: "mid-*", tier: 1 }, { match: "small-*", tier: 2 }] },
  b: { ranks: [{ match: "b/big", tier: 1 }, { match: "tiny?", tier: 3 }] },
};
const cfg = (childPolicy?: string) => ({ providers: RANKS, ...(childPolicy ? { ladder: { childPolicy } } : {}) });

test("below (default): only children strictly below the foreman's tier", () => {
  assert.equal(rankRefusal(cfg(), "a/mid-1", "a/small-1:high"), null);
  const r = rankRefusal(cfg(), "a/mid-1", "a/mid-2");
  assert.deepEqual([r?.policy, r?.foreman, r?.requested], ["below", "a/mid-1", "a/mid-2"]);
  assert.match(r!.message, /rank_policy:below.*tier 1.*tier 1/);
  assert.ok(rankRefusal(cfg(), "a/mid-1", "a/top-1"));
});

test("at-or-below allows the same tier; any allows everything", () => {
  assert.equal(rankRefusal(cfg("at-or-below"), "a/mid-1", "a/mid-2"), null);
  assert.ok(rankRefusal(cfg("at-or-below"), "a/mid-1", "a/top-1"));
  assert.equal(rankRefusal(cfg("any"), "a/mid-1", "a/top-1"), null);
  assert.equal(rankRefusal(cfg("any"), "a/mid-1", "z/unranked"), null);
});

test("tiers compare across providers; own provider's list first", () => {
  const ranks = ranksOf(cfg());
  assert.deepEqual([tierOf(ranks, "b/big"), tierOf(ranks, "b/tiny1"), tierOf(ranks, "a/tiny2"), tierOf(ranks, "b/mid-x")], [1, 3, 3, 1]);
  assert.equal(rankRefusal(cfg(), "a/top-1", "b/big"), null);
  assert.ok(rankRefusal(cfg(), "b/big", "a/mid-1"));
  assert.equal(rankRefusal(cfg(), "b/big", "a/small-1"), null);
});

test("with ranks configured an unranked child or foreman is refused (unless any)", () => {
  assert.match(rankRefusal(cfg(), "a/top-1", "z/other")!.message, /z\/other is unranked/);
  assert.match(rankRefusal(cfg("at-or-below"), "z/other", "a/small-1")!.message, /foreman model z\/other is unranked/);
});

test("no ranks anywhere: the policy is inert", () => {
  assert.equal(rankRefusal({ providers: { a: { roles: {} } } }, "a/x", "a/y"), null);
  assert.equal(rankRefusal({}, null, "a/y"), null);
});

test("launchedModels: top level and every tasks/chain entry", () => {
  assert.deepEqual(launchedModels({ agent: "builder", model: "a/x" }), ["a/x"]);
  assert.deepEqual(launchedModels({ tasks: [{ agent: "e", model: "a/1" }], chain: [{ parallel: [{ agent: "r", model: "a/2" }] }] }), ["a/1", "a/2"]);
});
