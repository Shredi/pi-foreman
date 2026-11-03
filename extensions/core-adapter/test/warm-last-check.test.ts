// Warm compaction timing (docs/cache.md, "Warm compaction triggers"): the "no further warm" check right after the last
// cache touch (after a completed warm, or at settle after a grace when no warm is allowed), on the self-warm path and on
// Pi's path. Fake clock, fake one-slot timers, fake probe. Plan tests D1-D10j.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SelfWarm, type WarmReply } from "../selfwarm.ts";
import { Presence } from "../presence.ts";
import { IdleCache, type Busy } from "../idlecache.ts";
import type { CachePolicy } from "../cachepolicy.ts";
import type { UsageLine } from "../usage.ts";

const MIN = 60_000;
const SEC = 1000;
const NOT_BUSY: Busy = { childRun: false, wait: false, launchWait: false, pendingMessages: false, notIdle: false };
const RATES = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 };
const HIT: WarmReply = { provider: "p", model: "m", usage: { input: 5, output: 1, cacheRead: 100_000, cacheWrite: 0 }, timestamp: 0 };
const LONG: CachePolicy = {
  active: false, skip: "ttl_long", ttlSeconds: 3600, billing: "token", intervalSeconds: 3240, windowMinutes: 45, effectiveWindowMinutes: 30, warmCompact: true,
  budgetShare: 0.5, awayTicks: 0, whileWaiting: true, selfWarm: true, selfWarmWindowMinutes: 180,
};
const PI: CachePolicy = { active: true, ttlSeconds: 300, billing: "token", intervalSeconds: 270, windowMinutes: 45, effectiveWindowMinutes: 30, warmCompact: true, budgetShare: 0.5, awayTicks: 0, whileWaiting: true };
const AWAY = 20 * 60; // idle seconds that read as away (> 11 minutes)

interface Slot {
  fn: () => void;
  at: number;
  dead: boolean;
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

interface Over {
  policy?: Partial<CachePolicy>;
  idle?: number | null;
  compact?: { point: number | null; model: string | null } | null;
  contextTokens?: number | null;
  isChild?: boolean;
  gate?: boolean;
  noRates?: boolean;
}

/** Clock, timers, presence and the SelfWarm both paths share (the gate of the Pi path, the sender of the self path). */
function world(base: CachePolicy, over: Over) {
  const clock = { t: 10_000_000 };
  const t0 = clock.t;
  const slots: Slot[] = [];
  let sets = 0;
  const timers = {
    set: (fn: () => void, ms: number) => {
      sets += 1;
      assert.ok(sets < 5000, "runaway re-arm loop");
      const s: Slot = { fn, at: clock.t + ms, dead: false };
      slots.push(s);
      return s;
    },
    clear: (h: unknown) => {
      if (h) (h as Slot).dead = true;
    },
  };
  const traces: Record<string, unknown>[] = [];
  const f = { policy: { ...base, ...over.policy } as CachePolicy, idle: over.idle === undefined ? 0 : over.idle, hold: null as Promise<void> | null, replayHold: null as Promise<void> | null, probes: 0, replays: 0, compacts: 0, context: over.contextTokens ?? null as number | null };
  const presence = new Presence({
    now: () => clock.t,
    timers,
    config: () => ({ enabled: true, awayAfterMinutes: 11, command: null }),
    probe: async () => {
      f.probes += 1;
      const v = f.idle;
      if (f.hold) await f.hold;
      return v;
    },
    trace: (r) => void traces.push(r),
  });
  const compact = (): { point: number | null; model: string | null } | null => {
    f.compacts += 1;
    return over.compact === undefined ? { point: 100000, model: "p/m" } : over.compact;
  };
  const sw = new SelfWarm({
    now: () => clock.t,
    timers,
    isChild: over.isChild ?? false,
    policy: () => f.policy,
    presence,
    busy: () => NOT_BUSY,
    rates: () => (over.noRates ? null : RATES),
    compact,
    contextTokens: () => f.context,
    trace: (r) => void traces.push(r),
    replayable: () => true,
    replay: async () => {
      f.replays += 1;
      if (f.replayHold) await f.replayHold;
      return HIT;
    },
    record: () => ({ cost: { total: 0.05 } }) as UsageLine,
  });
  sw.capture([{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
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
  const advanceTo = (rel: number): Promise<void> => advance(t0 + rel - clock.t);
  const ev = (event: string, outcome?: string) => traces.filter((r) => r.event === event && (outcome === undefined || r.outcome === outcome));
  const reasons = (outcome: string): unknown[] => ev("keepalive", outcome).map((r) => r.reason);
  const compactions = () => ev("compaction").map((r) => r.trigger);
  return { clock, t0, slots, timers, traces, f, presence, sw, advance, advanceTo, ev, reasons, compactions, sets: () => sets };
}

/** The self-warm path: pi-foreman sends the warms (3600 s TTL). */
function self(over: Over = {}) {
  const w = world(LONG, over);
  const open = (): void => {
    w.sw.noteRequest(100_000);
    w.sw.start();
  };
  return { ...w, open };
}

/** Pi's path: the IdleCache decides Pi's hook, the SelfWarm is its gate; a Pi tick appends an entry a little later. */
function pi(over: Over = {}) {
  const w = world(PI, over);
  let pending: number[] = [];
  const traces = w.traces;
  const state = { compactCalls: 0, lastSeen: null as number | null, assistantAt: w.t0 };
  const ic = new IdleCache({
    now: () => w.clock.t,
    timers: w.timers,
    policy: () => w.f.policy,
    piIdleMode: () => true,
    hasPromptCache: () => true,
    busy: () => NOT_BUSY,
    trace: (r) => void traces.push(r),
    contextTokens: () => w.f.context,
    compact: () => {
      state.compactCalls += 1;
      return over.compact === undefined ? { point: 100000, model: "p/m" } : over.compact;
    },
    setGlyph: () => {},
    syncKeepalives: () => {
      const due = pending.filter((at) => at <= w.clock.t);
      pending = pending.filter((at) => at > w.clock.t);
      for (const at of due) w.sw.noteWarmLine({ ts: new Date(at).toISOString(), input: 5, output: 1, cacheRead: 100_000, cacheWrite: 0 } as UsageLine);
      if (due.length) state.lastSeen = Math.max(state.lastSeen ?? 0, ...due);
      return { newEntries: due.length, lastReadAt: state.lastSeen };
    },
    lastAssistantAt: () => state.assistantAt,
    isChild: over.isChild ?? false,
    gate: over.gate === false ? undefined : w.sw,
  });
  /** `agent_settled`: a real request ended at the fake clock, Pi's idle begins. */
  const open = (lastTurnAgoMs = 0): void => {
    w.sw.noteRequest(100_000);
    state.assistantAt = w.clock.t;
    ic.noteTurnStart(w.clock.t - lastTurnAgoMs);
    ic.start();
  };
  /** What Pi does on a tick: ask the hook, then (on `warm`) append the entry `landMs` later. */
  const tick = (landMs = 2 * SEC): "warm" | "stop" | undefined => {
    const a = ic.decide(NOT_BUSY);
    ic.noteDecision(a);
    if (a === "warm") pending.push(w.clock.t + landMs);
    return a;
  };
  /** Ticks at k x 270 s up to and including `rel`. */
  const ticksUntil = async (rel: number): Promise<void> => {
    for (let k = 1; k * 270 * SEC <= rel && ic.state() === "watching"; k++) {
      await w.advanceTo(k * 270 * SEC);
      tick();
    }
  };
  return { ...w, ic, open, tick, ticksUntil, state };
}

// ---------------------------------------------------------------------------------------------------- D1 budget

test("D1 self: budget allows two warms -> compaction when warm 2 completes, not at tick 3; budget counts warm 2", async () => {
  const h = self({ policy: { budgetShare: 0.12 } });
  h.open();
  await h.advance(54 * MIN);
  assert.equal(h.f.replays, 1);
  assert.equal(h.f.compacts, 0);
  await h.advance(54 * MIN);
  assert.equal(h.f.replays, 2);
  assert.equal(h.f.compacts, 1, "right after warm 2, at 108 min");
  assert.equal(h.clock.t, h.t0 + 108 * MIN);
  const b = h.ev("budget");
  assert.equal(b.length, 1);
  assert.ok(Number(b[0].spent) > 0.1, "spent includes warm 2");
  assert.deepEqual(h.ev("keepalive", "skipped").map((r) => [r.reason, r.count, r.phase]), [["budget", 2, "post_warm"]]);
  assert.deepEqual(h.compactions(), ["budget"]);
  assert.deepEqual(h.reasons("window_end"), ["budget"]);
  await h.advance(120 * MIN);
  assert.equal(h.f.replays, 2, "no warm 3");
  assert.equal(h.f.compacts, 1);
});

test("D1 Pi: warm 2 is the last the budget allows -> compaction at the poll that sees its entry, not at tick 3", async () => {
  const h = pi({ policy: { budgetShare: 0.12 } });
  h.open();
  await h.ticksUntil(540 * SEC);
  assert.equal(h.ic.state(), "watching");
  assert.equal(h.state.compactCalls, 0);
  await h.advanceTo(546 * SEC);
  assert.equal(h.state.compactCalls, 1, "the poll after the entry landed (542 s)");
  assert.deepEqual(h.ev("keepalive", "skipped").map((r) => [r.reason, r.count, r.phase]), [["budget", 2, "post_warm"]]);
  assert.deepEqual(h.compactions(), ["budget"]);
  assert.deepEqual(h.reasons("window_end"), ["budget"]);
  assert.equal(h.ic.state(), "ended");
  assert.equal(h.ic.decide(NOT_BUSY), "stop", "10b: no further warm");
  await h.advanceTo(900 * SEC);
  assert.equal(h.state.compactCalls, 1);
});

// ---------------------------------------------------------------------------------------------------- D2 budget allows none

test("D2 self: budget allows no warm -> compaction at settle (after the grace), no warm sent", async () => {
  const h = self({ policy: { budgetShare: 0.01 } });
  h.open();
  await h.advance(59 * SEC);
  assert.equal(h.f.compacts, 0, "inside the grace");
  await h.advance(2 * SEC);
  assert.equal(h.f.compacts, 1);
  assert.equal(h.f.replays, 0);
  assert.deepEqual(h.ev("keepalive", "skipped").map((r) => [r.reason, r.count, r.phase]), [["budget", 0, "settle"]]);
  assert.deepEqual(h.reasons("window_end"), ["budget"]);
  await h.advance(120 * MIN);
  assert.equal(h.f.replays, 0);
});

test("D2 Pi: budget allows no warm -> compaction at settle (after the grace), Pi's tick never reaches a decision", async () => {
  const h = pi({ policy: { budgetShare: 0.01 } });
  h.open();
  await h.advance(59 * SEC);
  assert.equal(h.state.compactCalls, 0);
  await h.advance(2 * SEC);
  assert.equal(h.state.compactCalls, 1);
  assert.deepEqual(h.ev("keepalive", "skipped").map((r) => [r.reason, r.count, r.phase]), [["budget", 0, "settle"]]);
  assert.deepEqual(h.reasons("window_end"), ["budget"]);
  assert.equal(h.ic.decide(NOT_BUSY), "stop");
});

// ---------------------------------------------------------------------------------------------------- D3 bug-1 regression

test("D3 self (bug 1): awayTicks 2, owner away from settle -> exactly 2 warms, compaction right after the 2nd, no 3rd", async () => {
  const h = self({ idle: AWAY, policy: { awayTicks: 2 } });
  h.open();
  await h.advance(54 * MIN);
  assert.equal(h.f.replays, 1);
  assert.equal(h.f.compacts, 0);
  await h.advance(54 * MIN);
  assert.equal(h.f.replays, 2);
  assert.equal(h.f.compacts, 1);
  assert.equal(h.clock.t, h.t0 + 108 * MIN, "at the 2nd warm's completion");
  assert.deepEqual(h.compactions(), ["away"]);
  assert.deepEqual(h.ev("keepalive", "skipped").map((r) => [r.reason, r.count, r.phase]), [["away", 2, "post_warm"]]);
  await h.advance(300 * MIN);
  assert.equal(h.f.replays, 2, "no 3rd warm");
  assert.equal(h.f.compacts, 1);
});

test("D3 Pi (bug 1, 5-minute TTL): awayTicks 2, owner away from settle -> exactly 2 warms, compaction right after the 2nd, no 3rd request", async () => {
  const h = pi({ idle: AWAY, policy: { awayTicks: 2 } });
  h.open();
  await h.ticksUntil(540 * SEC);
  await h.advanceTo(546 * SEC);
  assert.equal(h.state.compactCalls, 1);
  assert.equal(h.f.compacts, 0, "the self-warm sender never ran");
  assert.deepEqual(h.compactions(), ["away"]);
  assert.deepEqual(h.ev("keepalive", "skipped").map((r) => [r.reason, r.count, r.phase]), [["away", 2, "post_warm"]]);
  assert.equal(h.ic.state(), "ended");
  assert.equal(h.tick(), "stop", "no 3rd request");
  await h.advanceTo(30 * MIN);
  assert.equal(h.state.compactCalls, 1);
});

// ---------------------------------------------------------------------------------------------------- D4 away at settle, no warm

test("D4 self: awayTicks 0, away at settle -> compaction at settle after the fresh probe, no warm", async () => {
  const h = self({ idle: AWAY });
  h.open();
  await h.advance(59 * SEC);
  assert.equal(h.f.compacts, 0);
  await h.advance(2 * SEC);
  assert.equal(h.f.compacts, 1);
  assert.equal(h.f.replays, 0);
  assert.ok(h.f.probes >= 1);
  assert.deepEqual(h.compactions(), ["away"]);
  assert.deepEqual(h.ev("keepalive", "skipped").map((r) => [r.reason, r.count, r.phase]), [["away", 0, "settle"]]);
});

test("D4 Pi: awayTicks 0, away at settle -> compaction at settle after the fresh probe, no warm", async () => {
  const h = pi({ idle: AWAY });
  h.open();
  assert.equal(h.f.probes, 0, "start() itself never probes");
  await h.advance(59 * SEC);
  assert.equal(h.state.compactCalls, 0);
  await h.advance(2 * SEC);
  assert.equal(h.state.compactCalls, 1);
  assert.ok(h.f.probes >= 1);
  assert.deepEqual(h.compactions(), ["away"]);
  assert.deepEqual(h.ev("keepalive", "skipped").map((r) => [r.reason, r.count, r.phase]), [["away", 0, "settle"]]);
});

// ---------------------------------------------------------------------------------------------------- D5 unknown / present

test("D5 self: presence unknown or present with awayTicks 0 -> no away compaction, warms continue to the window", async () => {
  for (const idle of [null, 30]) {
    const h = self({ idle, policy: { selfWarmWindowMinutes: 120 } });
    h.open();
    await h.advance(60 * SEC);
    assert.equal(h.f.compacts, 0, `settle ${idle}`);
    await h.advance(54 * MIN);
    assert.equal(h.f.replays, 1);
    await h.advance(54 * MIN);
    assert.equal(h.f.replays, 2);
    assert.deepEqual(h.compactions(), ["window"], `only the window trigger (${idle})`);
  }
});

test("D5 Pi: presence unknown or present with awayTicks 0 -> no away compaction, warms continue to the window", async () => {
  for (const idle of [null, 30]) {
    const h = pi({ idle });
    h.open();
    await h.advance(60 * SEC);
    assert.equal(h.state.compactCalls, 0, `settle ${idle}`);
    await h.ticksUntil(1200 * SEC);
    assert.equal(h.ic.state(), "watching");
    assert.equal(h.state.compactCalls, 0);
    assert.deepEqual(h.compactions(), []);
  }
});

// ---------------------------------------------------------------------------------------------------- D6 window

test("D6 self: the warm after which the next tick falls past the window compacts right after that warm (trigger window)", async () => {
  const h = self({ policy: { selfWarmWindowMinutes: 120 } });
  h.open();
  await h.advance(54 * MIN);
  assert.equal(h.f.compacts, 0);
  await h.advance(54 * MIN);
  assert.equal(h.f.replays, 2);
  assert.equal(h.f.compacts, 1);
  assert.equal(h.clock.t, h.t0 + 108 * MIN, "after warm 2, not at the refused tick 162 min");
  assert.deepEqual(h.compactions(), ["window"]);
  assert.deepEqual(h.reasons("window_end"), ["window"]);
  assert.deepEqual(h.reasons("skipped"), [], "a window hit traces no skipped");
  await h.advance(120 * MIN);
  assert.equal(h.f.replays, 2);
});

test("D6 Pi: Pi's 30-minute cap (lastTurnStart) -> compaction right after the last warm, window_end compact once the compaction ends", async () => {
  const h = pi();
  h.open(10 * MIN); // the window ends 20 min after settle
  await h.ticksUntil(1080 * SEC);
  assert.equal(h.state.compactCalls, 0);
  await h.advanceTo(1086 * SEC);
  assert.equal(h.state.compactCalls, 1, "after warm 4 (landed 1082 s), before the window end at 1200 s");
  assert.deepEqual(h.compactions(), ["window"]);
  assert.deepEqual(h.reasons("window_end"), [], "the window keeps watching until the compaction ends");
  assert.equal(h.ic.decide(NOT_BUSY), undefined, "10b: no override once the latch is set");
  h.ic.onCompact();
  assert.deepEqual(h.reasons("window_end"), ["compact"]);
  assert.equal(h.state.compactCalls, 1);
  assert.deepEqual(h.reasons("skipped"), []);
});

// ---------------------------------------------------------------------------------------------------- D7 floor / min

test("D7 self: below the idle floor or below compactMinTokens at the check -> no compaction, the window ends, no further warm", async () => {
  const floor = self({ idle: AWAY, compact: null, policy: { awayTicks: 1 } });
  floor.open();
  await floor.advance(54 * MIN);
  assert.equal(floor.f.replays, 1);
  assert.deepEqual(floor.ev("compaction"), []);
  assert.deepEqual(floor.reasons("skipped"), ["away", "below_floor"]);
  assert.deepEqual(floor.reasons("window_end"), ["away"]);
  await floor.advance(200 * MIN);
  assert.equal(floor.f.replays, 1);

  const min = self({ idle: AWAY, contextTokens: 10_000, policy: { awayTicks: 1, compactMinTokens: 50_000 } });
  min.open();
  await min.advance(54 * MIN);
  assert.deepEqual(min.ev("compaction"), []);
  assert.deepEqual(min.ev("compaction_skipped").map((r) => [r.reason, r.trigger]), [["below_min", "away"]]);
  assert.deepEqual(min.reasons("window_end"), ["away"]);
  await min.advance(200 * MIN);
  assert.equal(min.f.replays, 1);
});

test("D7 Pi: below the idle floor or below compactMinTokens at the check -> no compaction, the window ends, no further warm", async () => {
  const floor = pi({ idle: AWAY, compact: null, policy: { awayTicks: 1 } });
  floor.open();
  await floor.ticksUntil(270 * SEC);
  await floor.advanceTo(276 * SEC);
  assert.deepEqual(floor.ev("compaction"), []);
  assert.deepEqual(floor.reasons("skipped"), ["away", "below_floor"]);
  assert.equal(floor.ic.state(), "ended");
  assert.equal(floor.tick(), "stop");

  const min = pi({ idle: AWAY, contextTokens: 10_000, policy: { awayTicks: 1, compactMinTokens: 50_000 } });
  min.open();
  await min.ticksUntil(270 * SEC);
  await min.advanceTo(276 * SEC);
  assert.deepEqual(min.ev("compaction"), []);
  assert.deepEqual(min.ev("compaction_skipped").map((r) => [r.reason, r.trigger]), [["below_min", "away"]]);
  assert.equal(min.ic.state(), "ended");
  assert.equal(min.state.compactCalls, 0);
});

// ---------------------------------------------------------------------------------------------------- D8 activity

test("D8 self: activity during the settle probe -> no compaction", async () => {
  const h = self({ idle: AWAY });
  let release: () => void = () => {};
  h.f.hold = new Promise<void>((r) => (release = r));
  h.open();
  await h.advance(61 * SEC);
  assert.equal(h.f.probes, 1);
  h.sw.onActivity();
  release();
  await flush();
  assert.equal(h.f.compacts, 0);
  assert.deepEqual(h.ev("compaction"), []);
});

test("D8 Pi: activity during the settle probe and during the post-warm poll -> no compaction", async () => {
  const a = pi({ idle: AWAY });
  let release: () => void = () => {};
  a.f.hold = new Promise<void>((r) => (release = r));
  a.open();
  await a.advance(61 * SEC);
  assert.equal(a.f.probes, 1);
  a.ic.onActivity();
  release();
  await flush();
  assert.equal(a.state.compactCalls, 0);

  const b = pi({ policy: { budgetShare: 0.12 } });
  b.open();
  await b.ticksUntil(540 * SEC);
  await b.advanceTo(543 * SEC); // warm 2 landed at 542 s, the poll sees it at 545 s
  b.ic.onActivity();
  await b.advanceTo(600 * SEC);
  assert.equal(b.state.compactCalls, 0);
  assert.equal(b.ic.state(), "off");
});

// ---------------------------------------------------------------------------------------------------- D9 child

test("D9: a child session runs no check and compacts nothing", async () => {
  const s = self({ isChild: true, idle: AWAY, policy: { budgetShare: 0.01 } });
  s.open();
  await s.advance(200 * MIN);
  assert.equal(s.f.compacts, 0);
  assert.equal(s.f.replays, 0);
  const p = pi({ isChild: true, idle: AWAY, policy: { budgetShare: 0.01 } });
  p.open();
  await p.advance(30 * MIN);
  assert.equal(p.state.compactCalls, 0);
  assert.equal(p.ic.state(), "off");
  assert.deepEqual(p.ev("compaction"), []);
});

// ---------------------------------------------------------------------------------------------------- D10 legacy time rule

test("D10 Pi without a gate: the time rule compacts at windowEnd - interval; a window shorter than one tick keeps the midpoint rule", async () => {
  const a = pi({ gate: false });
  a.open();
  await a.ticksUntil(1350 * SEC);
  await a.advanceTo(25 * MIN + 29 * SEC);
  assert.equal(a.state.compactCalls, 0);
  await a.advanceTo(25 * MIN + 31 * SEC);
  assert.equal(a.state.compactCalls, 1, "at 25.5 min = 30 min - 270 s");
  const b = pi({ gate: false, policy: { windowMinutes: 1, effectiveWindowMinutes: 1 } });
  b.open();
  await b.advanceTo(29 * SEC);
  assert.equal(b.state.compactCalls, 0);
  await b.advanceTo(31 * SEC);
  assert.equal(b.state.compactCalls, 1, "midpoint of the one-minute window");
});

// ---------------------------------------------------------------------------------------------------- D10a fallback

test("D10a self: presence turns away between warms (awayTicks 0, present at the last check) -> the pre-warm refusal compacts at the refused tick", async () => {
  const h = self({ idle: 30 });
  h.open();
  await h.advance(54 * MIN);
  assert.equal(h.f.replays, 1);
  assert.equal(h.f.compacts, 0);
  h.f.idle = AWAY;
  await h.advance(54 * MIN);
  assert.equal(h.f.replays, 1, "refused at tick 2");
  assert.equal(h.f.compacts, 1);
  assert.equal(h.clock.t, h.t0 + 108 * MIN);
  assert.deepEqual(h.ev("keepalive", "skipped").map((r) => [r.reason, r.count, r.phase]), [["away", 1, "pre_warm"]]);
  assert.deepEqual(h.compactions(), ["away"]);
});

test("D10a Pi: presence turns away between warms (awayTicks 0, present at the last check) -> the pre-warm refusal compacts at the refused tick", async () => {
  const h = pi({ idle: 30 });
  h.open();
  await h.ticksUntil(270 * SEC);
  await h.advanceTo(300 * SEC);
  assert.equal(h.ic.state(), "watching");
  h.f.idle = AWAY;
  await h.advanceTo(540 * SEC - 1);
  assert.equal(h.state.compactCalls, 0);
  assert.equal(h.tick(), "stop", "the background probe before the tick saw away");
  assert.equal(h.state.compactCalls, 1);
  assert.deepEqual(h.ev("keepalive", "skipped").map((r) => [r.reason, r.count, r.phase]), [["away", 1, "pre_warm"]]);
  assert.deepEqual(h.compactions(), ["away"]);
});

// ---------------------------------------------------------------------------------------------------- D10b one compaction

test("D10b: after a hit ctx.compact is called once until the window ends (both paths)", async () => {
  const s = self({ idle: AWAY, policy: { awayTicks: 1 } });
  s.open();
  await s.advance(54 * MIN);
  assert.equal(s.f.compacts, 1);
  s.sw.onCompact();
  s.sw.start(); // a second settle in the same idle: the window is gone with the compaction
  await s.advance(10 * MIN);
  assert.equal(s.f.compacts, 1);

  const p = pi({ policy: { budgetShare: 0.01 } });
  p.open();
  await p.advance(61 * SEC);
  assert.equal(p.state.compactCalls, 1);
  assert.equal(p.ic.decide(NOT_BUSY), "stop");
  p.ic.start();
  await p.advance(10 * MIN);
  assert.equal(p.state.compactCalls, 1);
});

// ---------------------------------------------------------------------------------------------------- D10c probe cancellation

test("D10c self: end() then start() during the awaited settle probe -> the stale check does nothing", async () => {
  const h = self({ idle: AWAY });
  let release: () => void = () => {};
  h.f.hold = new Promise<void>((r) => (release = r));
  h.open();
  await h.advance(61 * SEC);
  assert.equal(h.f.probes, 1);
  h.sw.onActivity();
  h.open();
  release();
  await flush();
  assert.equal(h.f.compacts, 0);
  assert.equal(h.sw.state(), "watching");
});

test("D10c Pi: end() then start() during the awaited settle probe -> the stale check does nothing", async () => {
  const h = pi({ idle: AWAY });
  let release: () => void = () => {};
  h.f.hold = new Promise<void>((r) => (release = r));
  h.open();
  await h.advance(61 * SEC);
  assert.equal(h.f.probes, 1);
  h.ic.onActivity();
  h.open();
  release();
  await flush();
  assert.equal(h.state.compactCalls, 0);
  assert.equal(h.ic.state(), "watching");
});

// ---------------------------------------------------------------------------------------------------- D10d stale sample

test("D10d: an away sample under 60 s old at settle, the forced probe says present -> no compaction, warms run", async () => {
  const s = self({ idle: AWAY });
  s.open();
  await s.advance(10 * SEC);
  await s.presence.refresh();
  assert.equal(s.presence.sample()?.outcome, "away");
  s.f.idle = 30;
  await s.advance(51 * SEC);
  assert.equal(s.presence.sample()?.outcome, "present", "the grace slot probed although the sample was 50 s old");
  assert.equal(s.f.compacts, 0);
  await s.advance(54 * MIN);
  assert.equal(s.f.replays, 1);

  const p = pi({ idle: AWAY });
  p.open();
  await p.advance(10 * SEC);
  await p.presence.refresh();
  p.f.idle = 30;
  await p.advance(51 * SEC);
  assert.equal(p.presence.sample()?.outcome, "present");
  assert.equal(p.state.compactCalls, 0);
  await p.ticksUntil(270 * SEC);
  assert.equal(p.ic.state(), "watching");
});

// ---------------------------------------------------------------------------------------------------- D10e window end while warm

test("D10e Pi: no post-warm hit and the window end reached while warm -> tryCompact(window) once at the window end", async () => {
  const h = pi();
  h.open();
  await h.ticksUntil(1350 * SEC);
  await h.advanceTo(1525 * SEC);
  h.tick(); // lands at 1527 s: 1527 + 270 < 1800, no hit; Pi then stops asking
  await h.advanceTo(1799 * SEC);
  assert.equal(h.state.compactCalls, 0);
  assert.equal(h.ic.state(), "watching");
  await h.advanceTo(1801 * SEC);
  assert.equal(h.state.compactCalls, 1);
  assert.deepEqual(h.compactions(), ["window"]);
  assert.deepEqual(h.reasons("window_end"), [], "watching until onCompact");
  h.ic.onCompact();
  assert.deepEqual(h.reasons("window_end"), ["compact"]);
  assert.equal(h.state.compactCalls, 1);
});

test("D10e Pi: cold at the window end -> no compaction, the window ends", async () => {
  const h = pi();
  h.open();
  await h.ticksUntil(1350 * SEC);
  await h.advanceTo(1500 * SEC);
  h.tick(); // lands at 1502 s, cold from 1787 s
  await h.advanceTo(1801 * SEC);
  assert.equal(h.state.compactCalls, 0);
  assert.deepEqual(h.ev("compaction"), []);
  assert.deepEqual(h.reasons("window_end"), ["cold", "window"]);
  assert.equal(h.ic.state(), "ended");
});

// ---------------------------------------------------------------------------------------------------- D10f snapshot

test("D10f Pi: the footer snapshot's nextWarmAt ignores a lastKeepaliveAt from an earlier idle", async () => {
  const h = pi();
  h.open();
  await h.ticksUntil(270 * SEC);
  await h.advanceTo(276 * SEC);
  const first = h.ic.snapshot();
  assert.equal(first.nextWarmAt, h.t0 + 272 * SEC + 270 * SEC, "once a warm landed: last landing + Pi's tick");
  h.ic.onActivity();
  await h.advanceTo(400 * SEC);
  const startedAt = h.clock.t;
  h.open();
  assert.equal(h.ic.snapshot().nextWarmAt, startedAt + 270 * SEC, "the earlier idle's landing is not used");
});

// ---------------------------------------------------------------------------------------------------- D10g grace

test("D10g: activity within the settle grace -> no settle check, no compaction (both paths)", async () => {
  const s = self({ policy: { budgetShare: 0.01 } });
  s.open();
  await s.advance(30 * SEC);
  s.sw.onActivity();
  await s.advance(10 * MIN);
  assert.equal(s.f.compacts, 0);
  const p = pi({ policy: { budgetShare: 0.01 } });
  p.open();
  await p.advance(30 * SEC);
  p.ic.onActivity();
  await p.advance(10 * MIN);
  assert.equal(p.state.compactCalls, 0);
  assert.deepEqual(p.ev("compaction"), []);
});

test("D10g: the grace is min(60 s, a quarter of the TTL)", async () => {
  const p = pi({ policy: { budgetShare: 0.01, ttlSeconds: 100, intervalSeconds: 90 } });
  p.open();
  await p.advance(24 * SEC);
  assert.equal(p.state.compactCalls, 0);
  await p.advance(2 * SEC);
  assert.equal(p.state.compactCalls, 1, "25 s");
});

// ---------------------------------------------------------------------------------------------------- D10h in-flight warm at the window end

test("D10h Pi: the last warm is in flight at the window end -> the window keeps watching, compaction after it lands, window_end compact", async () => {
  const h = pi();
  h.open();
  await h.ticksUntil(1350 * SEC);
  await h.advanceTo(1525 * SEC);
  h.tick(); // lands at 1527 s, no hit
  await h.advanceTo(1797 * SEC);
  h.tick(20 * SEC); // lands at 1817 s, past the window end at 1800 s
  await h.advanceTo(1805 * SEC);
  assert.equal(h.ic.state(), "watching", "past the window end, still waiting for the entry");
  assert.equal(h.state.compactCalls, 0);
  await h.advanceTo(1822 * SEC);
  assert.equal(h.state.compactCalls, 1);
  assert.deepEqual(h.compactions(), ["window"]);
  h.ic.onCompact();
  assert.deepEqual(h.reasons("window_end"), ["compact"]);
});

// ---------------------------------------------------------------------------------------------------- D10i compaction running past the window end

test("D10i Pi: a compaction still running past the window end -> no override, no hook_stop, no 0 ms re-arm; onCompact ends with compact", async () => {
  const h = pi();
  h.open(10 * MIN); // the window ends at 1200 s
  await h.ticksUntil(1080 * SEC);
  await h.advanceTo(1090 * SEC);
  assert.equal(h.state.compactCalls, 1);
  await h.advanceTo(1201 * SEC);
  assert.equal(h.ic.state(), "watching", "the compaction is running");
  const before = h.sets();
  assert.equal(h.tick(), undefined, "decide gives no override past the window end");
  await h.advanceTo(1350 * SEC);
  assert.equal(h.tick(), undefined);
  assert.ok(h.sets() - before < 20, "no tight re-arm loop");
  assert.deepEqual(h.reasons("window_end"), []);
  h.ic.onCompact();
  assert.deepEqual(h.reasons("window_end"), ["compact"]);
  assert.equal(h.state.compactCalls, 1);
});

test("D10i Pi: without onCompact the cold bound of the last touch ends the window with window", async () => {
  const h = pi();
  h.open(10 * MIN);
  await h.ticksUntil(1080 * SEC);
  await h.advanceTo(1090 * SEC);
  assert.equal(h.state.compactCalls, 1);
  await h.advanceTo(1360 * SEC); // cold from 1082 + 285 = 1367 s
  assert.equal(h.ic.state(), "watching");
  await h.advanceTo(1370 * SEC);
  assert.equal(h.ic.state(), "ended");
  assert.deepEqual(h.reasons("window_end"), ["window"]);
});

// ---------------------------------------------------------------------------------------------------- D10j midpoint declined

test("D10j Pi: a short window whose midpoint check declined traces no second decline at the window end", async () => {
  const h = pi({ compact: null, policy: { windowMinutes: 1, effectiveWindowMinutes: 1 } });
  h.open();
  await h.advanceTo(61 * SEC);
  assert.deepEqual(h.reasons("window_end"), ["below_floor", "window"]);
  assert.equal(h.state.compactCalls, 1);
  assert.equal(h.ic.state(), "ended");
});

// ---------------------------------------------------------------------------------------------------- Pi decided before the grace

test("Pi: a warm decided before the grace slot skips the settle check; the post-warm check takes over", async () => {
  const h = pi({ idle: AWAY });
  h.open();
  await h.advanceTo(30 * SEC);
  assert.equal(h.tick(8 * SEC), "warm"); // Pi's first tick fell before the grace slot
  await h.advanceTo(100 * SEC);
  assert.equal(h.f.probes, 0, "no forced probe at the grace slot");
  assert.equal(h.state.compactCalls, 0);
  assert.equal(h.ic.state(), "watching");
});

// ---------------------------------------------------------------------------------------------------- warm in flight at the settle check

test("self: the settle check arrives while the first warm is in flight -> no compaction then; the post-warm check decides", async () => {
  const h = self({ idle: 30, policy: { ttlSeconds: 40, intervalSeconds: 36 } }); // grace 10 s, first warm at 36 s
  await h.presence.refresh(); // a sample younger than a minute, so the warm's own refresh does not join the settle probe
  h.open();
  h.f.idle = AWAY;
  let releaseProbe: () => void = () => {};
  h.f.hold = new Promise<void>((r) => (releaseProbe = r));
  let releaseWarm: () => void = () => {};
  h.f.replayHold = new Promise<void>((r) => (releaseWarm = r));
  await h.advance(11 * SEC);
  assert.equal(h.f.probes, 2, "the settle probe is held");
  await h.advance(30 * SEC);
  assert.equal(h.f.replays, 1, "the first warm is in flight");
  releaseProbe();
  await flush();
  assert.equal(h.f.compacts, 0, "settle must not compact under a warm in flight");
  releaseWarm();
  await flush();
  assert.equal(h.f.compacts, 1);
  assert.deepEqual(h.compactions(), ["away"]);
  assert.deepEqual(h.ev("keepalive", "skipped").map((r) => [r.reason, r.count, r.phase]), [["away", 1, "post_warm"]]);
});

// ---------------------------------------------------------------------------------------------------- budget unavailable

test("budget unavailable self: no settle refusal, no early window end; the window rule compacts after the warm that passes the window", async () => {
  const h = self({ noRates: true, policy: { selfWarmWindowMinutes: 120 } });
  h.open();
  await h.advance(2 * MIN);
  assert.equal(h.f.compacts, 0, "settle check skips the budget part");
  assert.deepEqual(h.reasons("window_end"), []);
  await h.advance(52 * MIN);
  assert.equal(h.f.replays, 1);
  assert.equal(h.f.compacts, 0);
  await h.advance(54 * MIN);
  assert.equal(h.f.replays, 2);
  assert.equal(h.f.compacts, 1, "post-warm window check, as on main");
  assert.deepEqual(h.compactions(), ["window"]);
  assert.deepEqual(h.reasons("window_end"), ["window"]);
  assert.deepEqual(h.reasons("skipped"), ["budget_unavailable"], "traced once, never a refusal");
});

test("budget unavailable Pi: the time rule stays on with a gate, the window compacts as on main and never ends early for the budget", async () => {
  const h = pi({ noRates: true, policy: { windowMinutes: 1, effectiveWindowMinutes: 1 } });
  h.open();
  await h.advanceTo(29 * SEC);
  assert.equal(h.state.compactCalls, 0);
  await h.advanceTo(31 * SEC);
  assert.equal(h.state.compactCalls, 1, "midpoint of the one-minute window");
  assert.deepEqual(h.compactions(), ["window"]);
  assert.deepEqual(h.reasons("window_end").filter((r) => r === "budget"), []);
  const g = pi({ noRates: true });
  g.open();
  await g.advanceTo(61 * SEC);
  assert.equal(g.ic.state(), "watching", "settle check ends nothing");
  await g.ticksUntil(1350 * SEC);
  await g.advanceTo(25 * MIN + 31 * SEC);
  assert.equal(g.state.compactCalls, 1, "windowEnd - interval, as on main");
});
