import { test } from "node:test";
import assert from "node:assert/strict";
import { CompactionGate, IDLE_FLOOR_FACTOR, overIdleFloor } from "../compaction.ts";

const cfg = { tiers: { cheap: 1, standard: 5 }, thresholds: { cheap: 0.85, standard: 0.75, premium: 0.6 } };
const premium = { cost: { input: 15 } }; // threshold 0.6 -> idle floor 0.3
const at = (tokens: number) => ({ tokens, contextWindow: 100_000 });

test("overIdleFloor is overThreshold at half the fraction", () => {
  assert.equal(IDLE_FLOOR_FACTOR, 0.5);
  assert.equal(overIdleFloor(at(30_000), 0.6), false);
  assert.equal(overIdleFloor(at(30_001), 0.6), true);
  assert.equal(overIdleFloor(null, 0.6), false);
  assert.equal(overIdleFloor(at(99_000), undefined), false);
});

test("decideIdle: below the floor null, above fires once, then null", () => {
  const g = new CompactionGate();
  assert.equal(g.decideIdle("s", premium, at(20_000), cfg), null);
  assert.equal(g.decideIdle("s", premium, at(40_000), cfg), "premium"); // between floor and threshold
  assert.equal(g.decideIdle("s", premium, at(40_000), cfg), null);
});

test("decideIdle fires again after reset; below-floor call does not set the latch", () => {
  const g = new CompactionGate();
  assert.equal(g.decideIdle("s", premium, at(10_000), cfg), null);
  assert.equal(g.decideIdle("s", premium, at(40_000), cfg), "premium");
  g.reset("s");
  assert.equal(g.decideIdle("s", premium, at(40_000), cfg), "premium");
});

test("decideIdle shares the latch with decide()", () => {
  const g = new CompactionGate();
  assert.equal(g.decide("s", premium, at(70_000), cfg), "premium");
  assert.equal(g.decideIdle("s", premium, at(70_000), cfg), null);
  g.reset("s");
  assert.equal(g.decideIdle("s", premium, at(40_000), cfg), "premium");
  assert.equal(g.decide("s", premium, at(70_000), cfg), null);
  assert.equal(g.decideIdle("other", premium, at(40_000), cfg), "premium");
});
