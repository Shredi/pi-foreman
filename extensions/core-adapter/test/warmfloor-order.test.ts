// Warm compaction floor order (docs/cache.md "Minimum context"): the relative floor (0.5 x runtime point) is checked before compactMinTokens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { warmCompact } from "../warmcompact.ts";
import type { CachePolicy } from "../cachepolicy.ts";

const POLICY: CachePolicy = { active: true, ttlSeconds: 300, billing: "token", intervalSeconds: 270, windowMinutes: 45, effectiveWindowMinutes: 30, warmCompact: true, compactMinTokens: 100_000 };

function run(aboveFloor: boolean, tokens: number) {
  const traces: Record<string, unknown>[] = [];
  const fired = warmCompact({
    policy: POLICY,
    alreadyCompacted: false,
    busy: () => false,
    now: 1000,
    lastTouch: 900,
    contextTokens: () => tokens,
    aboveFloor: () => aboveFloor,
    compact: () => ({ point: 200_000, model: "p/m" }),
    trace: (r) => void traces.push(r),
  });
  return { fired, traces };
}

test("below the floor: below_floor wins over below_min", () => {
  const r = run(false, 10_000);
  assert.equal(r.fired, false);
  assert.deepEqual(r.traces, [{ event: "keepalive", outcome: "window_end", reason: "below_floor" }]);
});

test("above the floor but below the minimum: below_min", () => {
  const r = run(true, 99_999);
  assert.equal(r.fired, false);
  assert.deepEqual(r.traces, [{ event: "compaction_skipped", reason: "below_min", tokens: 99_999, min: 100_000 }]);
});

test("both hold: compacts and traces the point", () => {
  const r = run(true, 120_000);
  assert.equal(r.fired, true);
  assert.deepEqual(r.traces, [{ event: "compaction", reason: "warm_idle", point: 200_000, model: "p/m" }]);
});
