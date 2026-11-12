// keepalive.compactMinTokens: no warm compaction below the minimum context (warmcompact.ts gate, final_warm trigger).
import { test } from "node:test";
import assert from "node:assert/strict";
import { warmCompact } from "../warmcompact.ts";
import { resolveWarmPolicy, type CachePolicy } from "../cachepolicy.ts";

const POLICY: CachePolicy = { active: true, ttlSeconds: 300, intervalSeconds: 270, windowMinutes: 45, effectiveWindowMinutes: 30, warmCompact: true, compactMinTokens: 100_000 };

function gate(tokens: number | null, min: number | undefined) {
  const traces: Record<string, unknown>[] = [];
  let compacts = 0;
  const fired = warmCompact({
    policy: { ...POLICY, compactMinTokens: min },
    alreadyCompacted: false,
    busy: () => false,
    now: 1000,
    lastTouch: 900,
    contextTokens: () => tokens,
    compact: () => {
      compacts += 1;
      return { point: 100000, model: "p/m" };
    },
    trace: (r) => void traces.push(r),
    trigger: "final_warm",
    skipOutcome: "skipped",
  });
  return { fired, compacts, traces };
}

test("final_warm: below the minimum no compaction and one compaction_skipped below_min", () => {
  const g = gate(99_999, 100_000);
  assert.equal(g.fired, false);
  assert.equal(g.compacts, 0);
  assert.deepEqual(g.traces, [{ event: "compaction_skipped", reason: "below_min", tokens: 99_999, min: 100_000, trigger: "final_warm" }]);
});

test("final_warm: at and above the minimum compacts", () => {
  for (const tokens of [100_000, 250_000]) {
    const g = gate(tokens, 100_000);
    assert.equal(g.fired, true);
    assert.equal(g.compacts, 1);
    assert.deepEqual(g.traces.map((r) => r.event), ["compaction"]);
  }
});

test("final_warm: compactMinTokens 0 compacts at any size", () => {
  const g = gate(10, 0);
  assert.equal(g.fired, true);
  assert.equal(g.compacts, 1);
});

test("absent field or unknown token count leaves the gate to the final-warm gate", () => {
  assert.equal(gate(10, undefined).fired, true);
  assert.equal(gate(null, 100_000).fired, true);
});

test("resolveWarmPolicy: default 100000, configured value kept (0 allowed), junk falls back", () => {
  const cfg = (v: unknown) => ({ providers: { "claude-bridge": { cache: { keepalive: { compactMinTokens: v } } } } });
  assert.equal(resolveWarmPolicy({}, "claude-bridge").compactMinTokens, 100_000);
  assert.equal(resolveWarmPolicy(cfg(0), "claude-bridge").compactMinTokens, 0);
  assert.equal(resolveWarmPolicy(cfg(250_000), "claude-bridge").compactMinTokens, 250_000);
  assert.equal(resolveWarmPolicy(cfg("x"), "claude-bridge").compactMinTokens, 100_000);
});
