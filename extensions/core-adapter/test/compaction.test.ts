import { test } from "node:test";
import assert from "node:assert/strict";
import { CompactionGate } from "../compaction.ts";

// The price-class gate (priceClass, overThreshold, decide) is gone: Pi's auto-compaction decides.
test("the gate only has the idle path and reset", () => {
  const g = new CompactionGate() as unknown as Record<string, unknown>;
  assert.equal(g.decide, undefined);
  assert.equal(typeof g.decideIdle, "function");
  assert.equal(typeof g.reset, "function");
});

test("latch: fires once per crossing, reset re-arms, sessions independent", () => {
  const g = new CompactionGate();
  const u = { tokens: 70_000, contextWindow: 200_000 };
  assert.equal(g.decideIdle("s", u, 100_000), true);
  assert.equal(g.decideIdle("s", u, 100_000), false);
  assert.equal(g.decideIdle("other", u, 100_000), true);
  g.reset("s");
  assert.equal(g.decideIdle("s", u, 100_000), true);
});
