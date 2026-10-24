import { test } from "node:test";
import assert from "node:assert/strict";
import { PI_DEFAULT_KEEP_RECENT, PI_DEFAULT_RESERVE, TIER_HEADROOM, compactionPoint, runtimePoint } from "../compaction-point.mjs";

const tiered = { contextWindow: 400_000, tiers: [{ inputTokensAbove: 272_000 }] };

test("constants", () => {
  assert.equal(TIER_HEADROOM, 20_000);
  assert.equal(PI_DEFAULT_RESERVE, 16_384);
  assert.equal(PI_DEFAULT_KEEP_RECENT, 20_000);
});

test("no tiers, no cap: window minus the effective reserve, nothing to write", () => {
  const r = compactionPoint({ contextWindow: 200_000 }, { maxTokens: null, effectiveReserve: 16_384, effectiveKeepRecent: 20_000 });
  assert.deepEqual(r, { point: 183_616, reserve: 16_384, write: false, reason: "not-earlier" });
});

test("tier only: lowest boundary minus the headroom", () => {
  const r = compactionPoint({ contextWindow: 400_000, tiers: [{ inputTokensAbove: 272_000 }, { inputTokensAbove: 300_000 }] }, { maxTokens: null, effectiveReserve: 16_384 });
  assert.deepEqual(r, { point: 252_000, reserve: 148_000, write: true });
});

test("cap only", () => {
  const r = compactionPoint({ contextWindow: 1_000_000 }, { maxTokens: 200_000, effectiveReserve: 16_384 });
  assert.deepEqual(r, { point: 200_000, reserve: 800_000, write: true });
});

test("tier and cap: the minimum wins", () => {
  assert.equal(compactionPoint(tiered, { maxTokens: 200_000, effectiveReserve: 16_384 }).point, 200_000);
  assert.equal(compactionPoint(tiered, { maxTokens: 300_000, effectiveReserve: 16_384 }).point, 252_000);
});

test("a user reserve larger than the derived one: no write", () => {
  const r = compactionPoint({ contextWindow: 200_000 }, { maxTokens: 150_000, effectiveReserve: 50_000 });
  assert.equal(r.write, false);
  assert.equal(r.point, 150_000);
  assert.equal(r.reserve, 50_000);
});

test("below the minimum point: no write, reason below-minimum", () => {
  const r = compactionPoint({ contextWindow: 200_000 }, { maxTokens: 50_000, effectiveReserve: 16_384, effectiveKeepRecent: 40_000 });
  assert.deepEqual(r, { point: 50_000, reserve: 150_000, write: false, reason: "below-minimum" });
  assert.equal(compactionPoint({ contextWindow: 200_000 }, { maxTokens: 60_000, effectiveKeepRecent: 40_000 }).write, true);
  assert.equal(compactionPoint({ contextWindow: 200_000 }, { maxTokens: 59_999, effectiveKeepRecent: 40_000 }).write, false);
});

test("unknown or invalid window: no point, no write", () => {
  for (const w of [undefined, null, 0, -1, Number.NaN, "200000"]) {
    assert.deepEqual(compactionPoint({ contextWindow: w }, { maxTokens: 100_000 }), { point: null, reserve: null, write: false, reason: "unknown-window" });
  }
  assert.equal(compactionPoint(null, {}).point, null);
});

test("runtimePoint: per-model override, then global reserve, then the default", () => {
  const m = { provider: "p", id: "m", contextWindow: 200_000 };
  assert.equal(runtimePoint(m, {}), 183_616);
  assert.equal(runtimePoint(m, { compaction: { reserveTokens: 30_000 } }), 170_000);
  assert.equal(runtimePoint(m, { compaction: { reserveTokens: 30_000, modelOverrides: { "p/m": { reserveTokens: 120_000 } } } }), 80_000);
  assert.equal(runtimePoint(m, { compaction: { modelOverrides: { "p/other": { reserveTokens: 120_000 } } } }), 183_616);
});

test("runtimePoint: null when compaction is off or the window is unknown", () => {
  assert.equal(runtimePoint({ provider: "p", id: "m", contextWindow: 200_000 }, { compaction: { enabled: false } }), null);
  assert.equal(runtimePoint({ provider: "p", id: "m" }, {}), null);
  assert.equal(runtimePoint(null, {}), null);
});
