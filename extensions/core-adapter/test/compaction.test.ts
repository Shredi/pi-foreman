import { test } from "node:test";
import assert from "node:assert/strict";
import { CompactionGate, priceClass } from "../compaction.ts";

const TIERS = { cheap: 1, standard: 5 };
const TH = { cheap: 0.85, standard: 0.75, premium: 0.6 };
const cfg = { tiers: TIERS, thresholds: TH };
const model = (input: number) => ({ cost: { input } });

test("priceClass bounds and unknown cost", () => {
  assert.equal(priceClass(model(0.99), TIERS), "cheap");
  assert.equal(priceClass(model(1), TIERS), "standard");
  assert.equal(priceClass(model(4.99), TIERS), "standard");
  assert.equal(priceClass(model(5), TIERS), "premium");
  assert.equal(priceClass({}, TIERS), "standard");
  assert.equal(priceClass(undefined, TIERS), "standard");
});

test("trigger: below no, above yes once, reset re-arms", () => {
  const g = new CompactionGate();
  const m = model(15); // premium, 0.6
  assert.equal(g.decide("s", m, { tokens: 59_000, contextWindow: 100_000 }, cfg), null);
  assert.equal(g.decide("s", m, { tokens: 60_000, contextWindow: 100_000 }, cfg), null); // not strictly above
  assert.equal(g.decide("s", m, { tokens: 61_000, contextWindow: 100_000 }, cfg), "premium");
  assert.equal(g.decide("s", m, { tokens: 70_000, contextWindow: 100_000 }, cfg), null);
  g.reset("s");
  assert.equal(g.decide("s", m, { tokens: 70_000, contextWindow: 100_000 }, cfg), "premium");
});

test("tokens null or no usage never triggers; thresholds per class; sessions independent", () => {
  const g = new CompactionGate();
  assert.equal(g.decide("a", model(15), { tokens: null, contextWindow: 100_000 }, cfg), null);
  assert.equal(g.decide("a", model(15), null, cfg), null);
  assert.equal(g.decide("a", model(0.5), { tokens: 80_000, contextWindow: 100_000 }, cfg), null);
  assert.equal(g.decide("a", model(0.5), { tokens: 86_000, contextWindow: 100_000 }, cfg), "cheap");
  assert.equal(g.decide("b", model(2), { tokens: 76_000, contextWindow: 100_000 }, cfg), "standard");
});
