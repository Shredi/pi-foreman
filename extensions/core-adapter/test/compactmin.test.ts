// keepalive.compactMinTokens: no warm compaction below the minimum context (warmcompact.ts gate, all three triggers).
import { test } from "node:test";
import assert from "node:assert/strict";
import { warmCompact, type CompactTrigger } from "../warmcompact.ts";
import { resolveWarmPolicy, type CachePolicy } from "../cachepolicy.ts";
import { IdleCache, type Busy } from "../idlecache.ts";

const POLICY: CachePolicy = { active: true, ttlSeconds: 300, billing: "token", intervalSeconds: 270, windowMinutes: 45, effectiveWindowMinutes: 30, warmCompact: true, compactMinTokens: 100_000 };
const NOT_BUSY: Busy = { childRun: false, wait: false, launchWait: false, pendingMessages: false, notIdle: false };
const MIN = 60_000;

function gate(tokens: number | null, min: number | undefined, trigger: CompactTrigger | undefined) {
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
    trigger,
    skipOutcome: trigger === "window" ? "window_end" : "skipped",
  });
  return { fired, compacts, traces };
}

for (const trigger of ["budget", "away", "window"] as const) {
  test(`${trigger}: below the minimum no compaction and one compaction_skipped below_min`, () => {
    const g = gate(99_999, 100_000, trigger);
    assert.equal(g.fired, false);
    assert.equal(g.compacts, 0);
    assert.deepEqual(g.traces, [{ event: "compaction_skipped", reason: "below_min", tokens: 99_999, min: 100_000, trigger }]);
  });
  test(`${trigger}: at and above the minimum compacts as before`, () => {
    for (const tokens of [100_000, 250_000]) {
      const g = gate(tokens, 100_000, trigger);
      assert.equal(g.fired, true);
      assert.equal(g.compacts, 1);
      assert.deepEqual(g.traces.map((r) => r.event), ["compaction"]);
    }
  });
  test(`${trigger}: compactMinTokens 0 compacts at any size`, () => {
    const g = gate(10, 0, trigger);
    assert.equal(g.fired, true);
    assert.equal(g.compacts, 1);
  });
}

test("absent field or unknown token count leaves the gate to the floor (old behaviour)", () => {
  assert.equal(gate(10, undefined, undefined).fired, true);
  assert.equal(gate(null, 100_000, "budget").fired, true);
});

test("resolveWarmPolicy: default 100000, configured value kept (0 allowed), junk falls back", () => {
  const cfg = (v: unknown) => ({ providers: { "claude-bridge": { cache: { keepalive: { compactMinTokens: v } } } } });
  assert.equal(resolveWarmPolicy({}, "claude-bridge").compactMinTokens, 100_000);
  assert.equal(resolveWarmPolicy(cfg(0), "claude-bridge").compactMinTokens, 0);
  assert.equal(resolveWarmPolicy(cfg(250_000), "claude-bridge").compactMinTokens, 250_000);
  assert.equal(resolveWarmPolicy(cfg("x"), "claude-bridge").compactMinTokens, 100_000);
});

function idle(tokens: number, min: number) {
  const clock = { t: 1_000_000 };
  const slots: { fn: () => void; at: number; dead: boolean }[] = [];
  const traces: Record<string, unknown>[] = [];
  let compacts = 0;
  const ic = new IdleCache({
    now: () => clock.t,
    timers: {
      set(fn: () => void, ms: number) {
        const s = { fn, at: clock.t + ms, dead: false };
        slots.push(s);
        return s;
      },
      clear(h: unknown) {
        if (h) (h as { dead: boolean }).dead = true;
      },
    },
    policy: () => ({ ...POLICY, compactMinTokens: min }),
    piIdleMode: () => true,
    hasPromptCache: () => true,
    busy: () => NOT_BUSY,
    trace: (r) => void traces.push(r),
    compact: () => {
      compacts += 1;
      return { point: 100000, model: "p/m" };
    },
    contextTokens: () => tokens,
    setGlyph: () => {},
    syncKeepalives: () => ({ newEntries: 0, lastReadAt: clock.t }),
    lastAssistantAt: () => null,
    isChild: false,
  } as never);
  ic.noteTurnStart(clock.t);
  ic.start();
  const start = clock.t;
  const advance = (ms: number): void => {
    const target = clock.t + ms;
    for (;;) {
      const due = slots.filter((s) => !s.dead && s.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.dead = true;
      clock.t = Math.max(clock.t, due.at);
      due.fn();
    }
    clock.t = target;
  };
  /** Pi ticks every 270 s (decide + a cache read) until `rel` ms. */
  const warmUntil = (rel: number): void => {
    for (let k = 1; k * 270_000 <= rel; k++) {
      advance(k * 270_000 - (clock.t - start));
      ic.noteDecision(ic.decide(NOT_BUSY));
    }
  };
  return { advance, warmUntil, traces, compacts: () => compacts };
}

test("IdleCache window trigger: below min traces compaction_skipped once, at min compacts", () => {
  const low = idle(50_000, 100_000);
  low.warmUntil(22.5 * MIN);
  low.advance(3 * MIN);
  assert.equal(low.compacts(), 0);
  assert.equal(low.traces.filter((r) => r.event === "compaction_skipped").length, 1);
  const ok = idle(100_000, 100_000);
  ok.warmUntil(22.5 * MIN);
  ok.advance(3 * MIN);
  assert.equal(ok.compacts(), 1);
  assert.equal(ok.traces.filter((r) => r.event === "compaction_skipped").length, 0);
});
