// Conditions of the removed idle-cache and Pi-path tests that still hold under the owned warming (selfwarm.ts, warmcompact.ts):
// the final-compaction gate order, the latch, settle-probe races, stale timers, error paths, trace fields, the hook in a child.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { SelfWarm, settleGraceMs, type WarmReply, type WarmSignals } from "../selfwarm.ts";
import { Presence } from "../presence.ts";
import { warmCompact, coldAt } from "../warmcompact.ts";
import { CompactionGate } from "../compaction.ts";
import { sanitizeTrace } from "../trace.ts";
import { deprecatedKeepaliveLines } from "../doctorcache.ts";
import { resolveWarmPolicy, type CachePolicy } from "../cachepolicy.ts";
import { r11Rig } from "./_r11rig.ts";
import type { UsageLine } from "../usage.ts";

const MIN = 60_000;
const RATES = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 };
const HIT: WarmReply = { provider: "p", model: "m", usage: { input: 5, output: 1, cacheRead: 100_000, cacheWrite: 0 }, timestamp: 0 };
const NONE: WarmSignals = { strongA: null, turn: false, question: false, dialog: false, command: false };
const policy = (ttl: number, over: Partial<CachePolicy> = {}): CachePolicy => ({
  active: false, ttlSeconds: ttl, billing: "token", intervalSeconds: 0, windowMinutes: 0, effectiveWindowMinutes: 0, warmCompact: true, budgetShare: 0.5, keepaliveOwned: true, ...over,
});
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

interface Slot {
  fn: () => void;
  at: number;
  dead: boolean;
}
interface Opts {
  ttl?: number;
  policy?: Partial<CachePolicy>;
  isChild?: boolean;
  point?: number | null;
  rates?: () => typeof RATES | null;
  hold?: Promise<void>;
}

function make(o: Opts = {}) {
  const clock = { t: 10_000_000 };
  const slots: Slot[] = [];
  const timers = {
    set: (fn: () => void, ms: number) => {
      const s: Slot = { fn, at: clock.t + ms, dead: false };
      slots.push(s);
      return s;
    },
    clear: (h: unknown) => {
      if (h) (h as Slot).dead = true;
    },
  };
  const traces: Record<string, unknown>[] = [];
  const f = { sig: { ...NONE } as WarmSignals, queued: false, compacts: 0, replays: 0 };
  const presence = new Presence({
    now: () => clock.t,
    timers,
    config: () => ({ enabled: true, awayAfterMinutes: 11, command: null }),
    probe: async () => {
      await o.hold;
      return 0;
    },
    trace: (r) => void traces.push(r),
  });
  const gate = new CompactionGate();
  const sw = new SelfWarm({
    now: () => clock.t,
    timers,
    isChild: o.isChild ?? false,
    policy: () => policy(o.ttl ?? 300, o.policy),
    presence,
    signals: () => f.sig,
    queued: () => f.queued,
    rates: () => (o.rates ? o.rates() : RATES),
    compact: () => {
      if (!gate.decideFinal("s", { tokens: 700_000, contextWindow: 1_000_000 })) return null;
      f.compacts += 1;
      return { point: o.point === undefined ? 100_000 : o.point, model: "p/m" };
    },
    contextTokens: () => 700_000,
    contextWindow: () => 1_000_000,
    trace: (r) => void traces.push(r),
    replayable: () => true,
    replay: async () => {
      f.replays += 1;
      return HIT;
    },
    record: () => ({ cost: { total: 0.05 } }) as UsageLine,
  });
  const advance = async (ms: number): Promise<void> => {
    const target = clock.t + ms;
    for (;;) {
      const due = slots.filter((s) => !s.dead && s.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.dead = true;
      clock.t = Math.max(clock.t, due.at);
      due.fn();
      await flush();
    }
    clock.t = target;
  };
  const request = (): void => {
    sw.capture([{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
    sw.noteRequest(100_000);
  };
  const open = (): void => {
    request();
    sw.start();
  };
  const ev = (event: string) => traces.filter((r) => r.event === event);
  return { sw, f, clock, traces, advance, open, request, ev, gate };
}

// ---- the compaction gate (warmcompact.ts) ------------------------------------------------------------------

function gateRun(over: Partial<Parameters<typeof warmCompact>[0]> = {}) {
  const order: string[] = [];
  const traces: Record<string, unknown>[] = [];
  const base = {
    policy: policy(300),
    alreadyCompacted: false,
    busy: () => (order.push("busy"), false),
    now: 1_000_000,
    lastTouch: 1_000_000 - 10_000,
    contextTokens: () => 50_000,
    aboveFloor: () => (order.push("floor"), true),
    compact: () => (order.push("compact"), { point: 1, model: "m" }),
    trace: (r: Record<string, unknown>) => void traces.push(r),
    trigger: "final_warm" as const,
    skipOutcome: "skipped" as const,
  };
  const fired = warmCompact({ ...base, ...over });
  return { fired, order, reasons: traces.filter((t) => t.event === "keepalive").map((t) => t.reason), traces };
}

test("final-compaction gates in order, each with its reason; compact() runs last", () => {
  assert.deepEqual(gateRun({ policy: { ...policy(300), warmCompact: false } }).reasons, ["warm_compact_off"]);
  assert.deepEqual(gateRun({ alreadyCompacted: true }).reasons, ["already_compacted"]);
  const busy = gateRun({ busy: () => true });
  assert.deepEqual(busy.reasons, ["busy"]);
  assert.deepEqual(busy.order, []);
  const cold = gateRun({ lastTouch: 1_000_000 - 400_000 });
  assert.deepEqual(cold.reasons, ["cold"]);
  assert.deepEqual(cold.order, ["busy"]);
  assert.deepEqual(gateRun({ lastTouch: 0 }).reasons, ["cold"], "an unknown touch counts as cold");
  const below = gateRun({ aboveFloor: () => false });
  assert.deepEqual(below.reasons, ["below_floor"]);
  assert.equal(below.order.includes("compact"), false);
  const min = gateRun({ policy: { ...policy(300), compactMinTokens: 100_000 } });
  assert.deepEqual(min.traces.map((t) => [t.event, t.reason, t.trigger]), [["compaction_skipped", "below_min", "final_warm"]]);
  const ok = gateRun();
  assert.equal(ok.fired, true);
  assert.deepEqual(ok.order, ["busy", "floor", "compact"]);
  assert.deepEqual(ok.traces.map((t) => [t.event, t.reason, t.trigger]), [["compaction", "warm_idle", "final_warm"]]);
  assert.equal(coldAt(1000, 300), 1000 + 0.95 * 300_000);
});

test("the latch is set only by a compaction that goes ahead: a failing cheaper gate leaves it unset", () => {
  const gate = new CompactionGate();
  const usage = { tokens: 700_000, contextWindow: 1_000_000 };
  const compact = () => (gate.decideFinal("s", usage) ? { point: null, model: "p/m" } : null);
  assert.equal(gateRun({ lastTouch: 1, compact }).fired, false);
  assert.equal(gate.decideFinal("s", { tokens: 1, contextWindow: 1_000_000 }), false);
  assert.equal(gateRun({ compact }).fired, true);
  assert.equal(gate.decideFinal("s", usage), false, "latched by the compaction");
  gate.reset("s");
  assert.equal(gate.decideFinal("s", usage), true, "session_compact resets the latch");
});

// ---- SelfWarm paths ----------------------------------------------------------------------------------------

test("a null runtime compaction point does not block the final compaction", async () => {
  const h = make({ ttl: 300, point: null });
  h.open();
  await h.advance(60 * MIN);
  assert.equal(h.f.compacts, 1);
  assert.deepEqual(h.ev("compaction").map((r) => [r.point, r.trigger]), [[null, "final_warm"]]);
});

test("a subagent run, a running turn or a queued message at the final check: no compaction", async () => {
  for (const [sig, queued] of [[{ strongA: "subagent" }, false], [{ turn: true }, false], [{}, true]] as [Partial<WarmSignals>, boolean][]) {
    const h = make({ ttl: 300, policy: { budgetShare: 0.01 } });
    h.open();
    h.f.sig = { ...NONE, ...sig };
    h.f.queued = queued;
    await h.advance(settleGraceMs(300) + 1000);
    assert.equal(h.f.compacts, 0, JSON.stringify(sig));
  }
});

test("a child session compacts nothing, even with the budget refusing the first warm", async () => {
  const h = make({ ttl: 300, isChild: true, policy: { budgetShare: 0.01 } });
  h.open();
  await h.advance(60 * MIN);
  assert.equal(h.f.compacts, 0);
  assert.deepEqual(h.ev("compaction"), []);
});

test("a compaction ends the stretch and invalidates the cache; the next request opens a fresh one with a fresh latch", async () => {
  const h = make({ ttl: 300 });
  h.open();
  await h.advance(60 * MIN);
  assert.equal(h.f.compacts, 1);
  h.sw.onCompact();
  assert.equal(h.sw.lastCacheTouch(), null);
  assert.equal(h.sw.state(), "ended");
  h.gate.reset("s");
  h.open();
  assert.equal(h.sw.state(), "watching");
  await h.advance(60 * MIN);
  assert.equal(h.f.compacts, 2);
});

test("activity during the settle probe: no compaction", async () => {
  let release: () => void = () => {};
  const h = make({ ttl: 300, policy: { budgetShare: 0.01 }, hold: new Promise<void>((r) => (release = r)) });
  h.open();
  await h.advance(settleGraceMs(300) + 1000); // the settle check is waiting on the probe
  h.request(); // a new real request arrives
  release();
  await flush();
  assert.equal(h.f.compacts, 0);
});

test("a stale settle check (the stretch ended and a new one opened during its probe) does nothing", async () => {
  let release: () => void = () => {};
  const h = make({ ttl: 300, policy: { budgetShare: 0.01 }, hold: new Promise<void>((r) => (release = r)) });
  h.open();
  await h.advance(settleGraceMs(300) + 1000);
  h.sw.onShutdown();
  h.sw.noteRequest(100_000);
  release();
  await flush();
  assert.equal(h.f.compacts, 0);
});

test("an exception in the timer callback ends with error and never compacts", async () => {
  const h = make({ ttl: 300, rates: () => { throw new Error("boom"); } });
  h.open();
  await h.advance(10 * 270_000);
  assert.equal(h.f.compacts, 0);
  assert.equal(h.f.replays, 0);
  assert.deepEqual(h.ev("keepalive").filter((r) => r.outcome === "window_end").map((r) => r.reason), ["error"]);
  assert.equal(h.sw.state(), "off");
});

test("shutdown ends the stretch and disarms the timers", async () => {
  const h = make({ ttl: 300 });
  h.open();
  h.sw.onShutdown();
  await h.advance(60 * MIN);
  assert.equal(h.f.replays, 0);
  assert.equal(h.sw.state(), "off");
});

test("every trace record of a stretch keeps all its fields through the trace writer's allowlist", async () => {
  const h = make({ ttl: 300 });
  h.open();
  await h.advance(60 * MIN);
  const bad = h.traces.filter((r) => Object.keys(r).some((k) => !(k in sanitizeTrace(r))));
  assert.deepEqual(bad.map((r) => [r.event, Object.keys(r).filter((k) => !(k in sanitizeTrace(r)))]), []);
  assert.ok(h.traces.length >= 5);
  const skipped = make({ ttl: 300, policy: { budgetShare: 0.01 } });
  skipped.open();
  await skipped.advance(settleGraceMs(300) + 1000);
  for (const r of skipped.traces) for (const k of Object.keys(r)) assert.ok(k in sanitizeTrace(r), `${String(r.event)}.${k}`);
});

// ---- hook and deprecated keys ------------------------------------------------------------------------------

test("cache_warming_decision answers stop in a child session and for a claude-bridge model", async (t) => {
  for (const o of [{ child: true, model: { provider: "pa", id: "big" } }, { child: false, model: { provider: "claude-bridge", id: "claude-opus-5-5" } }]) {
    const r = await r11Rig(t, {}, { child: o.child, ctx: { model: o.model } });
    assert.deepEqual(await r.fire("cache_warming_decision", {}), { action: "stop" }, JSON.stringify(o));
  }
});

test("the shipped presets set no deprecated keepalive key: the doctor stays quiet", () => {
  const dir = path.join(import.meta.dirname, "..", "..", "..", "config", "presets");
  const names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  assert.ok(names.length > 0);
  for (const n of names) assert.deepEqual(deprecatedKeepaliveLines(JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"))), [], n);
});

test("deprecated keys at any layer never change ownership", () => {
  const base = { ttlSeconds: 3600, billing: "token", keepalive: { enabled: true } };
  const dep = { ...base, keepalive: { enabled: true, beyondPiCap: false, windowMinutes: 1, selfWarmWindowMinutes: 1, awayTicks: 0, whileWaiting: false, intervalSeconds: 1 } };
  for (const c of [base, dep]) assert.equal(resolveWarmPolicy({ providers: { p: { cache: c } } }, "p").keepaliveOwned, true);
});
