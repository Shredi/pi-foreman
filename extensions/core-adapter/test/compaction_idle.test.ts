import { test } from "node:test";
import assert from "node:assert/strict";
import { CompactionGate, IDLE_FLOOR_FACTOR, overIdleFloor } from "../compaction.ts";
import { runtimePoint } from "../compaction-point.mjs";

const at = (tokens: number) => ({ tokens, contextWindow: 200_000 });
const model = { provider: "p", id: "m", contextWindow: 200_000 };
// point = 200000 - 16384 = 183616 -> floor 91808

test("overIdleFloor is half the runtime point in tokens", () => {
  assert.equal(IDLE_FLOOR_FACTOR, 0.5);
  assert.equal(overIdleFloor(at(50_000), 100_000), false);
  assert.equal(overIdleFloor(at(50_000), 100_000), false); // not strictly above
  assert.equal(overIdleFloor(at(50_001), 100_000), true);
  assert.equal(overIdleFloor(null, 100_000), false);
  assert.equal(overIdleFloor({ tokens: null, contextWindow: 200_000 }, 100_000), false);
  assert.equal(overIdleFloor(at(199_000), null), false);
  assert.equal(overIdleFloor(at(199_000), undefined), false);
});

test("decideIdle: below the floor false, above fires once, then false", () => {
  const g = new CompactionGate();
  const point = runtimePoint(model, {});
  assert.equal(point, 183_616);
  assert.equal(g.decideIdle("s", at(91_000), point), false);
  assert.equal(g.decideIdle("s", at(92_000), point), true);
  assert.equal(g.decideIdle("s", at(92_000), point), false);
});

test("decideIdle fires again after reset; a below-floor call does not set the latch", () => {
  const g = new CompactionGate();
  const point = runtimePoint(model, {});
  assert.equal(g.decideIdle("s", at(10_000), point), false);
  assert.equal(g.decideIdle("s", at(92_000), point), true);
  g.reset("s");
  assert.equal(g.decideIdle("s", at(92_000), point), true);
});

test("a user's per-model reserve is honoured: the floor drops with the point", () => {
  const g = new CompactionGate();
  const settings = { compaction: { reserveTokens: 16_384, modelOverrides: { "p/m": { reserveTokens: 100_000 } } } };
  const point = runtimePoint(model, settings); // 100000 -> floor 50000
  assert.equal(point, 100_000);
  assert.equal(g.decideIdle("s", at(50_000), point), false);
  assert.equal(g.decideIdle("s", at(50_001), point), true);
});

test("compaction.enabled false: no point, no warm compaction", () => {
  const g = new CompactionGate();
  const point = runtimePoint(model, { compaction: { enabled: false } });
  assert.equal(point, null);
  assert.equal(g.decideIdle("s", at(199_000), point), false);
});
