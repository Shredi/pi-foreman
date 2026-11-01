// Self-warm (selfwarm.ts) and the warm gate behind Pi-sent warms: fake clock, fake timers, fake probe and replay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SelfWarm, type WarmReply } from "../selfwarm.ts";
import { Presence } from "../presence.ts";
import { IdleCache, type Busy } from "../idlecache.ts";
import { resolveWarmPolicy, type CachePolicy } from "../cachepolicy.ts";
import { replayWarm, replayable, splitSystem } from "../warmreplay.ts";
import type { UsageLine } from "../usage.ts";

const MIN = 60_000;
const NOT_BUSY: Busy = { childRun: false, wait: false, launchWait: false, pendingMessages: false, notIdle: false };
const LONG: CachePolicy = {
  active: false, skip: "ttl_long", ttlSeconds: 3600, billing: "token", intervalSeconds: 3240, windowMinutes: 45, effectiveWindowMinutes: 30, warmCompact: true,
  budgetShare: 0.5, awayTicks: 0, whileWaiting: true, selfWarm: true, selfWarmWindowMinutes: 180,
};
const RATES = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 };
const HIT: WarmReply = { provider: "p", model: "m", usage: { input: 5, output: 1, cacheRead: 100_000, cacheWrite: 0 }, timestamp: 0 };

interface Slot {
  fn: () => void;
  at: number;
  dead: boolean;
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

function make(over: { policy?: Partial<CachePolicy>; idle?: number | null; compact?: { point: number | null; model: string | null } | null; replayable?: boolean; rates?: typeof RATES | null; reply?: () => Promise<WarmReply | null>; isChild?: boolean } = {}) {
  const clock = { t: 10_000_000 };
  const t0 = clock.t;
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
  const f = { policy: { ...LONG, ...over.policy } as CachePolicy, busy: { ...NOT_BUSY }, replays: 0, signals: [] as AbortSignal[], recorded: [] as WarmReply[], compacts: 0, probes: 0 };
  const presence = new Presence({
    now: () => clock.t,
    timers,
    config: () => ({ enabled: true, awayAfterMinutes: 11, command: null }),
    probe: async () => {
      f.probes += 1;
      return over.idle === undefined ? 0 : over.idle;
    },
    trace: (r) => void traces.push(r),
  });
  const sw = new SelfWarm({
    now: () => clock.t,
    timers,
    isChild: over.isChild ?? false,
    policy: () => f.policy,
    presence,
    busy: () => f.busy,
    rates: () => (over.rates === undefined ? RATES : over.rates),
    compact: () => {
      f.compacts += 1;
      return over.compact === undefined ? { point: 100000, model: "p/m" } : over.compact;
    },
    trace: (r) => void traces.push(r),
    replayable: () => over.replayable ?? true,
    replay: async (_m, signal) => {
      f.replays += 1;
      f.signals.push(signal);
      return over.reply ? over.reply() : HIT;
    },
    record: (reply) => {
      f.recorded.push(reply);
      return { cost: { total: 0.05 } } as UsageLine;
    },
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
  const open = (prompt = 100_000): void => {
    sw.noteRequest(prompt);
    sw.start();
  };
  const ev = (event: string, outcome?: string) => traces.filter((r) => r.event === event && (outcome === undefined || r.outcome === outcome));
  const reasons = (outcome: string): unknown[] => ev("keepalive", outcome).map((r) => r.reason);
  return { sw, f, clock, t0, traces, advance, open, ev, reasons, slots };
}

test("3600 s TTL: first self-warm at 54 minutes, recorded as source foreman, then every 54 minutes", async () => {
  const h = make();
  h.open();
  await h.advance(53 * MIN);
  assert.equal(h.f.replays, 0);
  await h.advance(1 * MIN);
  assert.equal(h.f.replays, 1);
  assert.equal(h.f.recorded.length, 1);
  assert.deepEqual(h.ev("keepalive", "fired").map((r) => [r.source, r.cacheRead, r.cacheWrite]), [["foreman", 100_000, 0]]);
  assert.equal(h.sw.lastCacheTouch(), h.t0 + 54 * MIN);
  await h.advance(54 * MIN);
  assert.equal(h.f.replays, 2);
});

test("the replay is sent through the provided signal; the hook-side owns() is true so Pi's hook answers stop", () => {
  const h = make();
  assert.equal(h.sw.owns(), true);
});

test("short TTL, beyondPiCap off or a child: not owned, nothing scheduled", async () => {
  for (const o of [{ policy: { selfWarm: false, ttlSeconds: 300 } }, { policy: { selfWarm: false } }, { isChild: true }]) {
    const h = make(o);
    h.open();
    await h.advance(200 * MIN);
    assert.equal(h.sw.owns(), false);
    assert.equal(h.f.replays, 0);
  }
});

test("abort on activity: the in-flight call is aborted, not recorded, window ends with activity", async () => {
  let release: (r: WarmReply) => void = () => {};
  const h = make({ reply: () => new Promise<WarmReply | null>((res) => (release = res)) });
  h.open();
  await h.advance(54 * MIN);
  assert.equal(h.f.replays, 1);
  h.sw.onActivity();
  assert.equal(h.f.signals[0].aborted, true);
  release(HIT);
  await flush();
  assert.equal(h.f.recorded.length, 0);
  assert.deepEqual(h.reasons("window_end"), ["activity"]);
  await h.advance(120 * MIN);
  assert.equal(h.f.replays, 1, "no further warms");
});

test("an errored call is not recorded and ends the window", async () => {
  const h = make({ reply: async () => null });
  h.open();
  await h.advance(54 * MIN);
  assert.equal(h.f.recorded.length, 0);
  assert.deepEqual(h.reasons("window_end"), ["activity"]);
});

test("model change, compaction and session shutdown abort an in-flight warm", async () => {
  for (const act of ["invalidate", "onCompact", "onShutdown"] as const) {
    const h = make({ reply: () => new Promise<WarmReply | null>(() => {}) });
    h.open();
    await h.advance(54 * MIN);
    h.sw[act]();
    assert.equal(h.f.signals[0].aborted, true, act);
  }
});

test("miss contingency: the first completed warm with cacheWrite >= cacheRead disables self-warm for the session", async () => {
  const h = make({ reply: async () => ({ ...HIT, usage: { ...HIT.usage, cacheRead: 0, cacheWrite: 100_000 } }) });
  h.open();
  await h.advance(54 * MIN);
  assert.equal(h.f.recorded.length, 1, "the call is still recorded");
  assert.deepEqual(h.reasons("window_end"), ["self_warm_miss"]);
  assert.equal(h.sw.owns(), false);
  assert.equal(h.sw.missed(), true);
  h.sw.onActivity();
  h.open();
  await h.advance(200 * MIN);
  assert.equal(h.f.replays, 1);
});

test("not replayable: skipped, traced once, no warm", async () => {
  const h = make({ replayable: false });
  h.open();
  h.sw.onActivity();
  h.open();
  await h.advance(200 * MIN);
  assert.equal(h.f.replays, 0);
  assert.deepEqual(h.reasons("skipped"), ["not_replayable"]);
});

test("budget: the warm that would exceed budgetShare x cold is refused, the last warm read compacts once (trigger budget)", async () => {
  const h = make({ policy: { budgetShare: 0.01 } });
  h.open();
  await h.advance(54 * MIN);
  assert.equal(h.f.replays, 0);
  assert.deepEqual(h.reasons("skipped"), ["budget"]);
  assert.deepEqual(h.ev("compaction").map((r) => [r.reason, r.trigger]), [["warm_idle", "budget"]]);
  assert.deepEqual(h.reasons("window_end"), ["budget"]);
  assert.equal(h.ev("budget").length, 1);
  assert.equal(h.f.compacts, 1);
});

test("budget exhausted below the idle floor: no compaction, the idle goes cold", async () => {
  const h = make({ policy: { budgetShare: 0.01 }, compact: null });
  h.open();
  await h.advance(54 * MIN);
  assert.equal(h.ev("compaction").length, 0);
  assert.deepEqual(h.reasons("skipped"), ["budget", "below_floor"]);
});

test("budget accumulates over warms: the second warm is refused when two ticks no longer fit", async () => {
  // cold = 1.0 USD; a tick = 100k x 0.5/M + 1 token = 0.05; share 0.12 allows two warms (0.1) but not a third
  const h = make({ policy: { budgetShare: 0.12 } });
  h.open();
  await h.advance(54 * MIN);
  await h.advance(54 * MIN);
  assert.equal(h.f.replays, 2);
  await h.advance(54 * MIN);
  assert.equal(h.f.replays, 2);
  assert.deepEqual(h.reasons("window_end"), ["budget"]);
});

test("budget unavailable (no rates): traced once, warming goes on inside the window", async () => {
  const h = make({ rates: null });
  h.open();
  await h.advance(54 * MIN);
  assert.equal(h.f.replays, 1);
  assert.deepEqual(h.reasons("skipped"), ["budget_unavailable"]);
  await h.advance(54 * MIN);
  assert.equal(h.reasons("skipped").length, 1);
});

test("a real request resets the budget and the away ticks", async () => {
  const h = make({ policy: { budgetShare: 0.06 } });
  h.open();
  await h.advance(54 * MIN);
  assert.equal(h.f.replays, 1);
  h.sw.onActivity();
  h.open();
  await h.advance(54 * MIN);
  assert.equal(h.f.replays, 2, "fresh idle, fresh budget");
});

test("away: awayTicks 0 refuses the first warm and compacts (trigger away); the probe ran in the background timer", async () => {
  const h = make({ idle: 20 * 60 });
  h.open();
  await h.advance(54 * MIN);
  assert.equal(h.f.replays, 0);
  assert.deepEqual(h.reasons("skipped"), ["away"]);
  assert.deepEqual(h.ev("compaction").map((r) => r.trigger), ["away"]);
  assert.deepEqual(h.reasons("window_end"), ["away"]);
  assert.deepEqual(h.ev("presence").map((r) => r.outcome), ["away"]);
  assert.ok(h.f.probes >= 1);
});

test("away with awayTicks 2: two warms, the third is refused", async () => {
  const h = make({ idle: 20 * 60, policy: { awayTicks: 2 } });
  h.open();
  for (let i = 0; i < 3; i++) await h.advance(54 * MIN);
  assert.equal(h.f.replays, 2);
  assert.deepEqual(h.reasons("window_end"), ["away"]);
});

test("present or unknown owner is never refused for presence", async () => {
  for (const idle of [30, null]) {
    const h = make({ idle });
    h.open();
    await h.advance(54 * MIN);
    assert.equal(h.f.replays, 1);
  }
});

test("window end: the warm that would fall past selfWarmWindowMinutes compacts (trigger window) and ends the window", async () => {
  const h = make({ policy: { selfWarmWindowMinutes: 60 } });
  h.open();
  await h.advance(54 * MIN);
  await h.advance(54 * MIN);
  assert.equal(h.f.replays, 1);
  assert.deepEqual(h.ev("compaction").map((r) => r.trigger), ["window"]);
  assert.deepEqual(h.reasons("window_end"), ["window"]);
});

test("a running turn or queued message at fire time: no warm", async () => {
  const h = make();
  h.open();
  h.f.busy.pendingMessages = true;
  await h.advance(54 * MIN);
  assert.equal(h.f.replays, 0);
  assert.deepEqual(h.reasons("window_end"), ["activity"]);
});

test("a late timer (more than half the margin past due) skips the warm", async () => {
  const h = make();
  h.open();
  h.clock.t += 54 * MIN + 4 * MIN; // margin is 6 min, half is 3
  const slot = h.slots.filter((s) => !s.dead).sort((a, b) => b.at - a.at)[0]; // the warm timer; the probe slot is 60 s earlier
  slot.dead = true;
  slot.fn();
  await flush();
  assert.equal(h.f.replays, 0);
  assert.deepEqual(h.reasons("skipped"), ["late"]);
});

test("noteWarmLine (a Pi-sent warm) moves the cache touch and counts toward spent", () => {
  const h = make();
  h.sw.noteRequest(100_000);
  const ts = new Date(h.clock.t + 5 * MIN).toISOString();
  h.sw.noteWarmLine({ ts, input: 0, output: 0, cacheRead: 100_000, cacheWrite: 0 } as UsageLine);
  assert.equal(h.sw.lastCacheTouch(), Date.parse(ts));
  const v = h.sw.verdict();
  assert.equal(v.ok, true);
});

// ---- the gate behind Pi-sent warms (idlecache.ts) --------------------------------------------------------

const PI: CachePolicy = { active: true, ttlSeconds: 300, billing: "token", intervalSeconds: 270, windowMinutes: 45, effectiveWindowMinutes: 30, warmCompact: true };

function makeIdle(policy: CachePolicy, gate?: ConstructorParameters<typeof IdleCache>[0]["gate"], compact: { point: number | null; model: string | null } | null = { point: 100000, model: "p/m" }) {
  const clock = { t: 1_000_000 };
  const slots: Slot[] = [];
  const traces: Record<string, unknown>[] = [];
  let compacts = 0;
  const ic = new IdleCache({
    now: () => clock.t,
    timers: {
      set: (fn, ms) => {
        const s: Slot = { fn, at: clock.t + ms, dead: false };
        slots.push(s);
        return s;
      },
      clear: (h) => {
        if (h) (h as Slot).dead = true;
      },
    },
    policy: () => policy,
    piIdleMode: () => true,
    hasPromptCache: () => true,
    busy: () => NOT_BUSY,
    trace: (r) => void traces.push(r),
    compact: () => {
      compacts += 1;
      return compact;
    },
    setGlyph: () => {},
    syncKeepalives: () => ({ newEntries: 0, lastReadAt: null }),
    lastAssistantAt: () => clock.t,
    isChild: false,
    gate,
  });
  return { ic, clock, traces, slots, compacts: () => compacts };
}

test("Pi path: a budget refusal answers stop, compacts with trigger budget and ends the window", () => {
  const gate = {
    verdict: () => ({ ok: false as const, reason: "budget" as const, budget: { spent: 0.4, cold: 1, share: 0.5 } }),
    budgetAvailable: () => true,
    lastCacheTouch: () => null,
    owns: () => false,
    noteWarm: () => {},
    armProbe: () => {},
    disarm: () => {},
  };
  const h = makeIdle({ ...PI, budgetShare: 0.5 }, gate);
  h.ic.start();
  const a = h.ic.decide(NOT_BUSY);
  assert.equal(a, "stop");
  h.ic.noteDecision(a);
  assert.deepEqual(h.traces.filter((r) => r.event === "budget"), [{ event: "budget", spent: 0.4, cold: 1, share: 0.5 }]);
  assert.deepEqual(h.traces.filter((r) => r.event === "compaction"), [{ event: "compaction", reason: "warm_idle", point: 100000, model: "p/m", trigger: "budget" }]);
  assert.deepEqual(h.traces.filter((r) => r.event === "keepalive").map((r) => [r.outcome, r.reason]), [["skipped", "budget"], ["window_end", "budget"]]);
  assert.equal(h.ic.decide(NOT_BUSY), "stop", "ended");
});

test("Pi path: a refusal below the idle floor does not compact", () => {
  const gate = { verdict: () => ({ ok: false as const, reason: "away" as const }), budgetAvailable: () => false, lastCacheTouch: () => null, owns: () => false, noteWarm: () => {}, armProbe: () => {}, disarm: () => {} };
  const h = makeIdle({ ...PI, budgetShare: 0.5 }, gate, null);
  h.ic.start();
  h.ic.noteDecision(h.ic.decide(NOT_BUSY));
  assert.equal(h.traces.filter((r) => r.event === "compaction").length, 0);
  assert.deepEqual(h.traces.filter((r) => r.event === "keepalive").map((r) => r.reason), ["away", "below_floor", "away"]);
});

test("Pi path: an allowed warm counts an away tick and arms the background probe; decide never probes", () => {
  const log: string[] = [];
  const gate = { verdict: () => ({ ok: true as const }), budgetAvailable: () => true, lastCacheTouch: () => null, owns: () => false, noteWarm: () => void log.push("warm"), armProbe: () => void log.push("arm"), disarm: () => {} };
  const h = makeIdle({ ...PI, budgetShare: 0.5 }, gate);
  h.ic.start();
  assert.deepEqual(log, ["arm"]);
  log.length = 0;
  h.ic.noteDecision(h.ic.decide(NOT_BUSY));
  assert.deepEqual(log, ["warm", "arm"]);
});

test("whileWaiting: child runs, waits and launch waits do not stop the Pi-path warm; a queued message still does", () => {
  const h = makeIdle({ ...PI, whileWaiting: true });
  h.ic.start();
  for (const k of ["childRun", "wait", "launchWait"] as const) assert.equal(h.ic.decide({ ...NOT_BUSY, [k]: true }), "warm", k);
  assert.equal(h.ic.decide({ ...NOT_BUSY, pendingMessages: true }), undefined);
  assert.equal(h.ic.decide({ ...NOT_BUSY, notIdle: true }), undefined);
  const old = makeIdle(PI);
  old.ic.start();
  assert.equal(old.ic.decide({ ...NOT_BUSY, childRun: true }), undefined, "absent field = old behaviour");
});

test("the idle cache stays out when pi-foreman owns the warming", () => {
  const gate = { verdict: () => ({ ok: true as const }), budgetAvailable: () => true, lastCacheTouch: () => null, owns: () => true, noteWarm: () => {}, armProbe: () => {}, disarm: () => {} };
  const h = makeIdle({ ...PI, selfWarm: true }, gate);
  h.ic.start();
  assert.equal(h.ic.state(), "off");
});

test("the cold gate reads the owner's last cache touch: a self-warm touch keeps the idle warm for the window compaction", () => {
  const gate = { verdict: () => ({ ok: true as const }), budgetAvailable: () => true, lastCacheTouch: () => h.clock.t, owns: () => false, noteWarm: () => {}, armProbe: () => {}, disarm: () => {} };
  const h = makeIdle({ ...PI, windowMinutes: 1, effectiveWindowMinutes: 1, budgetShare: 0.5 }, gate);
  h.ic.start();
  h.clock.t += 30_000;
  const slot = h.slots.filter((s) => !s.dead).sort((a, b) => a.at - b.at)[0];
  slot.dead = true;
  slot.fn();
  assert.deepEqual(h.traces.filter((r) => r.event === "compaction").map((r) => r.trigger), ["window"]);
});

// ---- policy and replay ------------------------------------------------------------------------------------

test("resolveWarmPolicy: defaults, self-warm switch and window default", () => {
  const cfg = (ka: unknown, extra: Record<string, unknown> = {}) => ({ providers: { "claude-bridge": { cache: { ttlSeconds: 3600, keepalive: ka, ...extra } } } });
  const d = resolveWarmPolicy({}, "claude-bridge");
  assert.deepEqual([d.budgetShare, d.awayTicks, d.whileWaiting, d.selfWarm, d.selfWarmWindowMinutes], [0.5, 0, true, false, 45]);
  const on = resolveWarmPolicy(cfg({ enabled: true }), "claude-bridge");
  assert.deepEqual([on.selfWarm, on.selfWarmWindowMinutes, on.skip, on.active], [true, 180, "ttl_long", false]);
  assert.equal(resolveWarmPolicy(cfg({}), "claude-bridge").selfWarm, false, "keepalive.enabled is not on for a 1h TTL by default");
  assert.equal(resolveWarmPolicy(cfg({ enabled: true, beyondPiCap: false }), "claude-bridge").selfWarm, false);
  assert.equal(resolveWarmPolicy(cfg({ enabled: false }), "claude-bridge").selfWarm, false);
  assert.equal(resolveWarmPolicy(cfg({ enabled: true }, { billing: "request" }), "claude-bridge").selfWarm, false);
  assert.equal(resolveWarmPolicy({ providers: { "claude-bridge": { cache: { ttlSeconds: 1000, keepalive: { enabled: true } } } } }, "claude-bridge").selfWarm, false, "Pi warms 1000 s twice before its cap");
  assert.equal(resolveWarmPolicy({ providers: { "claude-bridge": { cache: { ttlSeconds: 1001, keepalive: { enabled: true } } } } }, "claude-bridge").selfWarm, true);
  const set = resolveWarmPolicy(cfg({ enabled: true, budgetShare: 0.2, awayTicks: 2, whileWaiting: false, selfWarmWindowMinutes: 90 }), "claude-bridge");
  assert.deepEqual([set.budgetShare, set.awayTicks, set.whileWaiting, set.selfWarmWindowMinutes], [0.2, 2, false, 90]);
  assert.equal(resolveWarmPolicy(cfg({ enabled: true, selfWarmWindowMinutes: 99999 }), "claude-bridge").selfWarmWindowMinutes, 1440);
  assert.equal(resolveWarmPolicy({}, "other").skip, "no_entry");
});

test("replay: system message first, rest converted, tools, session id, maxTokens 1, maxRetries 0, reasoning like Pi", async () => {
  let seen: { context: { systemPrompt: string; messages: unknown[]; tools: unknown[] }; options: Record<string, unknown> } | null = null;
  const ac = new AbortController();
  const reply = await replayWarm({ id: "m" }, [{ role: "system", content: [{ type: "text", text: "S1" }, { type: "text", text: "S2" }] }, { role: "user", content: "hi" }], ac.signal, {
    convertToLlm: (m) => m.map((x) => ({ converted: x })),
    tools: () => [{ name: "t" }],
    thinkingLevel: () => "high",
    sessionId: () => "sess",
    cacheRetention: () => "long",
    streamSimple: (_m, context, options) => {
      seen = { context: context as never, options: options as never };
      return { result: async () => ({ provider: "p", model: "m", responseModel: "m-1", usage: { cacheRead: 5 }, stopReason: "length" }) };
    },
  });
  assert.equal(seen!.context.systemPrompt, "S1S2");
  assert.deepEqual(seen!.context.messages, [{ converted: { role: "user", content: "hi" } }]);
  assert.deepEqual(seen!.context.tools, [{ name: "t" }]);
  assert.deepEqual({ ...seen!.options, signal: undefined }, { sessionId: "sess", maxTokens: 1, maxRetries: 0, signal: undefined, reasoning: "high", cacheRetention: "long" });
  assert.equal(reply?.model, "m-1");
  const off = await replayWarm({}, [], ac.signal, {
    convertToLlm: () => [], tools: () => [], thinkingLevel: () => "off", sessionId: () => "s", cacheRetention: () => undefined,
    streamSimple: (_m, _c, options) => {
      assert.equal("reasoning" in (options as object), false);
      assert.equal("cacheRetention" in (options as object), false);
      return { result: async () => ({ usage: {}, stopReason: "error" }) };
    },
  });
  assert.equal(off, null, "an errored call is null");
  assert.deepEqual(splitSystem([{ role: "user", content: "x" }]).systemPrompt, "");
});

test("isReplayable mirror: budget-thinking anthropic-messages without forceAdaptiveThinking is refused", () => {
  assert.equal(replayable({ api: "anthropic-messages" }, "high"), false);
  assert.equal(replayable({ api: "anthropic-messages", compat: { forceAdaptiveThinking: true } }, "high"), true);
  assert.equal(replayable({ api: "anthropic-messages" }, "off"), true);
  assert.equal(replayable({ api: "openai-responses" }, "high"), true);
  assert.equal(replayable(null, "off"), false);
});

test("the Pi hook path reads the cached presence sample: decide never probes, an away sample refuses with awayTicks 0", async () => {
  const h = make({ idle: 20 * 60, policy: { selfWarm: false, ttlSeconds: 300, awayTicks: 0 } });
  h.sw.noteRequest(100_000);
  const gateIc = makeIdle({ ...PI, awayTicks: 0, budgetShare: 0.5 }, h.sw);
  gateIc.ic.start();
  assert.equal(gateIc.ic.decide(NOT_BUSY), "warm", "no sample yet reads as present");
  assert.equal(h.f.probes, 0, "decide did not probe");
  await (h.sw as unknown as { deps: { presence: Presence } }).deps.presence.refresh();
  assert.equal(h.f.probes, 1);
  assert.equal(gateIc.ic.decide(NOT_BUSY), "stop");
  assert.equal(h.f.probes, 1);
});

test("Pi cacheWarming not idle: no ownership, no stream call, skipped pi_mode_not_idle traced once", async () => {
  const traces: Record<string, unknown>[] = [];
  let replays = 0;
  let idle = false;
  const clock = { t: 10_000_000 };
  const slots: { fn: () => void; at: number; dead: boolean }[] = [];
  const timers = {
    set: (fn: () => void, ms: number) => {
      const s = { fn, at: clock.t + ms, dead: false };
      slots.push(s);
      return s;
    },
    clear: (h: unknown) => {
      if (h) (h as { dead: boolean }).dead = true;
    },
  };
  const sw = new SelfWarm({
    now: () => clock.t,
    timers,
    isChild: false,
    policy: () => LONG,
    presence: new Presence({ now: () => clock.t, timers, config: () => ({ enabled: false, awayAfterMinutes: 11, command: null }), trace: () => {} }),
    busy: () => NOT_BUSY,
    piIdleMode: () => idle,
    rates: () => RATES,
    compact: () => null,
    trace: (r) => void traces.push(r),
    replayable: () => true,
    replay: async () => {
      replays += 1;
      return HIT;
    },
    record: () => null,
  });
  sw.capture([{ role: "system", content: "sys" }]);
  for (let i = 0; i < 2; i++) {
    sw.noteRequest(100_000);
    sw.start();
  }
  assert.equal(sw.owns(), false);
  assert.equal(slots.length, 0);
  assert.equal(replays, 0);
  assert.deepEqual(traces.filter((r) => r.outcome === "skipped").map((r) => r.reason), ["pi_mode_not_idle"]);
  idle = true;
  assert.equal(sw.owns(), true);
  sw.start();
  assert.equal(sw.state(), "watching");
});

test("owns() agrees with start(): a model Pi would not replay is not owned at 1001 s", () => {
  const policy = resolveWarmPolicy({ providers: { p: { cache: { ttlSeconds: 1001, billing: "token", keepalive: { enabled: true } } } } }, "p");
  assert.equal(policy.selfWarm, true);
  assert.equal(make({ policy, replayable: false }).sw.owns(), false);
  assert.equal(make({ policy, replayable: true }).sw.owns(), true);
});
