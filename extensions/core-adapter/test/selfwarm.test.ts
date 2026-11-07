// Warm owner (selfwarm.ts, docs/cache.md): tick timing, the activity rule (tiers), the cost rule, the final-warm compaction,
// in-flight handling and the replay. Fake clock, fake timers, fake probe and replay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SelfWarm, warmDelayMs, settleGraceMs, AWAY_GRACE_MS, type WarmReply, type WarmSignals } from "../selfwarm.ts";
import { Presence } from "../presence.ts";
import { resolveWarmPolicy, type CachePolicy } from "../cachepolicy.ts";
import { replayWarm, replayable, splitSystem } from "../warmreplay.ts";
import type { UsageLine } from "../usage.ts";

const MIN = 60_000;
const RATES = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 };
const HIT: WarmReply = { provider: "p", model: "m", usage: { input: 5, output: 1, cacheRead: 100_000, cacheWrite: 0 }, timestamp: 0 };
const NONE: WarmSignals = { strongA: null, turn: false, question: false, dialog: false, command: false };
const policy = (ttl: number | null, over: Partial<CachePolicy> = {}): CachePolicy => ({
  active: false, ttlSeconds: ttl, billing: "token", intervalSeconds: 0, windowMinutes: 0, effectiveWindowMinutes: 0, warmCompact: true, budgetShare: 0.5, keepaliveOwned: ttl !== null && ttl > 10, ...over,
});

interface Slot {
  fn: () => void;
  at: number;
  dead: boolean;
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

interface Opts {
  ttl?: number;
  policy?: Partial<CachePolicy>;
  idle?: number | null;
  presence?: boolean;
  compact?: { point: number | null; model: string | null } | null;
  replayable?: boolean;
  rates?: typeof RATES | null;
  reply?: () => Promise<WarmReply | null>;
  isChild?: boolean;
  tokens?: number | null;
  window?: number | null;
  drift?: boolean;
}

function make(o: Opts = {}) {
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
  const f = { sig: { ...NONE } as WarmSignals, queued: false, drift: o.drift ?? false, replays: 0, signals: [] as AbortSignal[], recorded: [] as WarmReply[], compacts: 0, probes: 0, idle: o.idle === undefined ? 0 : o.idle, glyph: [] as boolean[] };
  const presence = new Presence({
    now: () => clock.t,
    timers,
    config: () => ({ enabled: o.presence ?? true, awayAfterMinutes: 11, command: null }),
    probe: async () => {
      f.probes += 1;
      return f.idle;
    },
    trace: (r) => void traces.push(r),
  });
  const pol = policy(o.ttl ?? 3600, o.policy);
  const sw = new SelfWarm({
    now: () => clock.t,
    timers,
    isChild: o.isChild ?? false,
    policy: () => pol,
    presence,
    signals: () => f.sig,
    queued: () => f.queued,
    rates: () => (o.rates === undefined ? RATES : o.rates),
    compact: () => {
      f.compacts += 1;
      return o.compact === undefined ? { point: 100000, model: "p/m" } : o.compact;
    },
    contextTokens: () => (o.tokens === undefined ? 700_000 : o.tokens),
    contextWindow: () => (o.window === undefined ? 1_000_000 : o.window),
    driftPending: () => f.drift,
    setGlyph: (on) => void f.glyph.push(on),
    trace: (r) => void traces.push(r),
    replayable: () => o.replayable ?? true,
    replay: async (_m, signal) => {
      f.replays += 1;
      f.signals.push(signal);
      return o.reply ? o.reply() : HIT;
    },
    record: (reply) => {
      f.recorded.push(reply);
      return { cost: { total: 0.05 } } as UsageLine;
    },
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
  /** A real request: captured at the request, ended with its usage. */
  const request = (prompt = 100_000): void => {
    sw.capture([{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
    sw.noteRequest(prompt);
  };
  const open = (prompt = 100_000): void => {
    request(prompt);
    sw.start();
  };
  const ev = (event: string, outcome?: string) => traces.filter((r) => r.event === event && (outcome === undefined || r.outcome === outcome));
  const reasons = (outcome: string): unknown[] => ev("keepalive", outcome).map((r) => r.reason);
  return { sw, f, clock, t0, traces, advance, open, request, ev, reasons, slots };
}

// ---- tick timing -------------------------------------------------------------------------------------------

test("warmDelayMs: min(0.9 x TTL, TTL - 10 s); null for a TTL of 10 s or less", () => {
  assert.equal(warmDelayMs(20), 10_000);
  assert.equal(warmDelayMs(300), 270_000);
  assert.equal(warmDelayMs(3600), 3_240_000);
  assert.equal(warmDelayMs(11), 1000);
  assert.equal(warmDelayMs(10), null);
  assert.equal(warmDelayMs(5), null);
  assert.equal(warmDelayMs(null), null);
});

for (const [ttl, tick] of [[20, 10], [300, 270], [3600, 3240]] as const) {
  test(`${ttl} s TTL: the first warm goes out ${tick} s after the request end, then every ${tick} s, recorded as source foreman`, async () => {
    const h = make({ ttl });
    h.open();
    await h.advance((tick - 1) * 1000);
    assert.equal(h.f.replays, 0);
    await h.advance(1000);
    assert.equal(h.f.replays, 1);
    assert.equal(h.f.recorded.length, 1);
    assert.deepEqual(h.ev("keepalive", "fired").map((r) => [r.source, r.cacheRead, r.cacheWrite]), [["foreman", 100_000, 0]]);
    assert.equal(h.sw.lastCacheTouch(), h.t0 + tick * 1000);
    await h.advance(tick * 1000);
    assert.equal(h.f.replays, 2);
  });
}

test("a TTL of 10 s or less: no ownership, nothing scheduled, no warm", async () => {
  for (const ttl of [10, 5]) {
    const h = make({ ttl });
    h.open();
    await h.advance(60 * MIN);
    assert.equal(h.sw.owns(), false);
    assert.equal(h.f.replays, 0);
  }
});

test("not owned: keepalive off, a child's missing switch or a model that cannot be replayed", async () => {
  for (const o of [{ policy: { keepaliveOwned: false } }, { replayable: false }] as Opts[]) {
    const h = make(o);
    h.open();
    await h.advance(200 * MIN);
    assert.equal(h.sw.owns(), false);
    assert.equal(h.f.replays, 0);
  }
  const h = make({ replayable: false });
  h.open();
  h.open();
  assert.deepEqual(h.reasons("skipped"), ["not_replayable"], "traced once");
});

test("a child session is wired like the parent: it warms, with no presence probe", async () => {
  const h = make({ isChild: true });
  h.open();
  await h.advance(54 * MIN);
  assert.equal(h.f.replays, 1);
  assert.equal(h.f.probes, 0);
});

test("the footer glyph is on while watching and off when the stretch ends", async () => {
  const h = make({ policy: { budgetShare: 0.01 } });
  h.open();
  assert.deepEqual(h.f.glyph, [true]);
  await h.advance(54 * MIN);
  assert.equal(h.f.glyph.at(-1), false);
});

// ---- the activity rule -------------------------------------------------------------------------------------

const REASONS: [Partial<WarmSignals>, string][] = [
  [{ strongA: "subagent" }, "subagent"],
  [{ strongA: "bg_task" }, "bg_task"],
  [{ strongA: "wait" }, "wait"],
  [{ question: true }, "question"],
  [{ dialog: true }, "dialog"],
  [{ command: true }, "command"],
  [{ turn: true }, "turn"],
];

test("an owner who is present: every activity reason is the half tier, no reason is the quarter tier", () => {
  for (const [sig, reason] of REASONS) {
    const h = make({ idle: 0 });
    h.f.sig = { ...NONE, ...sig };
    assert.deepEqual([h.sw.tierAt(h.clock.t).tier, h.sw.tierAt(h.clock.t).reason], ["half", reason]);
  }
  const h = make();
  assert.deepEqual([h.sw.tierAt(h.clock.t).tier, h.sw.tierAt(h.clock.t).reason], ["quarter", "idle"]);
});

test("an owner who is away past the grace: a subagent, background task or wait stays the half tier, the rest drops to the quarter tier", async () => {
  const h = make({ idle: 20 * MIN / 1000 });
  h.open();
  await h.sw["deps"].presence.refresh();
  assert.equal(h.sw["deps"].presence.away(), true);
  const late = h.clock.t + 30 * MIN;
  for (const [sig, reason] of REASONS) {
    h.f.sig = { ...NONE, ...sig };
    const v = h.sw.tierAt(late);
    if (["subagent", "bg_task", "wait"].includes(reason)) assert.deepEqual([v.tier, v.reason, v.presence], ["half", reason, "away"], reason);
    else assert.deepEqual([v.tier, v.presence], ["quarter", "away"], reason);
  }
});

test("grace: an owner who went away less than 15 minutes before the due time still gets the half tier for a turn; after the grace the quarter tier", async () => {
  // away since (idle 11 min = the threshold) = the sample time when the idle time is exactly 11 minutes
  const h = make({ idle: 11 * 60 });
  h.open();
  await h.sw["deps"].presence.refresh();
  const since = h.sw["deps"].presence.awaySince()!;
  assert.equal(since, h.clock.t);
  h.f.sig = { ...NONE, turn: true };
  assert.equal(h.sw.tierAt(since + AWAY_GRACE_MS - 1).tier, "half");
  assert.equal(h.sw.tierAt(since + AWAY_GRACE_MS - 1).presence, "grace");
  assert.equal(h.sw.tierAt(since + AWAY_GRACE_MS).tier, "quarter");
  assert.equal(h.sw.tierAt(since + AWAY_GRACE_MS).presence, "away");
});

test("unknown presence (no probe result) counts as present for the tier", () => {
  const h = make({ idle: null });
  h.f.sig = { ...NONE, turn: true };
  assert.equal(h.sw.tierAt(h.clock.t).tier, "half");
});

test("a signals() that throws counts as no activity: the quarter tier", () => {
  const h = make();
  (h.sw["deps"] as { signals: () => WarmSignals }).signals = () => {
    throw new Error("stale");
  };
  assert.equal(h.sw.tierAt(h.clock.t).tier, "quarter");
});

// ---- the cost rule -----------------------------------------------------------------------------------------

test("quarter tier: 4 warms (spent + next <= 0.25 x cold), then the stretch ends and the last warm is followed by the final compaction", async () => {
  const h = make({ ttl: 300 });
  h.open();
  await h.advance(60 * MIN);
  assert.equal(h.f.replays, 4);
  assert.deepEqual(h.reasons("window_end"), ["budget"]);
  assert.deepEqual(h.ev("compaction").map((r) => [r.reason, r.trigger]), [["warm_idle", "final_warm"]]);
  assert.equal(h.f.compacts, 1);
  assert.deepEqual(h.ev("budget").map((r) => r.tier), ["quarter"]);
});

test("half tier: 9 warms while a subagent runs", async () => {
  const h = make({ ttl: 300 });
  h.f.sig = { ...NONE, strongA: "subagent" };
  h.open();
  await h.advance(120 * MIN);
  assert.equal(h.f.replays, 9);
  assert.deepEqual(h.ev("keepalive", "fired").map((r) => r.tier), Array(9).fill("half"));
});

test("the tier at each tick decides: activity ending after the quarter share is spent refuses the next warm and compacts", async () => {
  const h = make({ ttl: 300 });
  h.f.sig = { ...NONE, strongA: "wait" };
  h.open();
  await h.advance(6 * 270_000);
  assert.equal(h.f.replays, 6);
  h.f.sig = { ...NONE };
  await h.advance(270_000);
  assert.equal(h.f.replays, 6, "the quarter tier is spent");
  assert.deepEqual(h.reasons("window_end"), ["budget"]);
});

test("the next warm is refused before any warm: compaction after the settle grace instead of waiting for the first tick", async () => {
  const h = make({ ttl: 300, policy: { budgetShare: 0.01 } });
  h.open();
  await h.advance(settleGraceMs(300) - 1);
  assert.equal(h.f.compacts, 0);
  await h.advance(2);
  assert.equal(h.f.replays, 0);
  assert.equal(h.f.compacts, 1);
  assert.deepEqual(h.ev("compaction").map((r) => r.trigger), ["final_warm"]);
  assert.deepEqual(h.reasons("window_end"), ["budget"]);
});

test("activity within the settle grace: a new request leaves no compaction", async () => {
  const h = make({ ttl: 300, policy: { budgetShare: 0.01 } });
  h.open();
  await h.advance(10_000);
  h.open();
  await h.advance(10_000);
  assert.equal(h.f.compacts, 0);
});

test("budget unavailable (no rates): traced once, no warm is sent", async () => {
  const h = make({ rates: null, ttl: 300 });
  h.open();
  await h.advance(10 * 270_000);
  assert.equal(h.f.replays, 0, "no warm is sent when the cost is not computable");
  assert.deepEqual(h.reasons("skipped"), ["budget_unavailable"]);
});

test("a real request resets the budget", async () => {
  const h = make({ ttl: 300 });
  h.open();
  await h.advance(60 * MIN);
  assert.equal(h.f.replays, 4);
  h.open();
  await h.advance(60 * MIN);
  assert.equal(h.f.replays, 8, "a fresh stretch, a fresh budget");
});

// ---- the final-warm compaction -----------------------------------------------------------------------------

test("final compaction: 300 s TTL and a 3600 s TTL both compact right after the last warm", async () => {
  for (const ttl of [300, 3600]) {
    const h = make({ ttl });
    h.open();
    await h.advance(24 * 60 * MIN);
    assert.equal(h.f.compacts, 1, `ttl ${ttl}`);
    assert.deepEqual(h.ev("compaction").map((r) => r.trigger), ["final_warm"]);
  }
});

test("final compaction: below 0.6 x the context window, below compactMinTokens, busy or already compacted: none", async () => {
  const below = make({ ttl: 300, tokens: 500_000 });
  below.open();
  await below.advance(60 * MIN);
  assert.equal(below.f.compacts, 0);
  assert.ok(below.reasons("window_end").includes("budget"));
  const min = make({ ttl: 300, tokens: 700_000, policy: { compactMinTokens: 800_000 } });
  min.open();
  await min.advance(60 * MIN);
  assert.equal(min.f.compacts, 0);
  assert.equal(min.ev("compaction_skipped").length, 1);
  const busy = make({ ttl: 300 });
  busy.f.sig = { ...NONE, turn: false };
  busy.open();
  await busy.advance(3 * 270_000);
  busy.f.queued = true;
  await busy.advance(60 * MIN);
  assert.equal(busy.f.compacts, 0);
});

test("a compaction that is running holds the warms; its end ends the stretch", async () => {
  const h = make({ ttl: 300, policy: { budgetShare: 0.5 } });
  h.open();
  await h.advance(100_000);
  h.sw.onCompactStart();
  await h.advance(60 * MIN);
  assert.equal(h.f.replays, 0);
  h.sw.onCompact();
  assert.equal(h.sw.state(), "ended");
});

test("a failed compaction arms the warm again", async () => {
  const h = make({ ttl: 300 });
  h.open();
  h.sw.onCompactStart();
  h.sw.onCompactFailed();
  await h.advance(270_000);
  assert.equal(h.f.replays, 1);
});

// ---- in-flight, errors, drift ------------------------------------------------------------------------------

test("a real request starting aborts an in-flight warm: it is not recorded", async () => {
  let release: (r: WarmReply) => void = () => {};
  const h = make({ reply: () => new Promise<WarmReply | null>((res) => (release = res)) });
  h.open();
  await h.advance(54 * MIN);
  assert.equal(h.f.replays, 1);
  h.sw.capture([{ role: "system", content: "s" }]);
  assert.equal(h.f.signals[0].aborted, true);
  release(HIT);
  await flush();
  assert.equal(h.f.recorded.length, 0);
});

test("no warm while a real request is in flight; the request end re-arms", async () => {
  const h = make({ ttl: 300 });
  h.open();
  h.sw.capture([{ role: "system", content: "s" }]);
  await h.advance(60 * MIN);
  assert.equal(h.f.replays, 0);
  h.sw.noteRequest(100_000);
  await h.advance(270_000);
  assert.equal(h.f.replays, 1);
});

test("an errored request keeps the last touch, budget and capture: the warming goes on from the old touch", async () => {
  const h = make({ ttl: 300 });
  h.open();
  await h.advance(270_000);
  assert.equal(h.f.replays, 1);
  const touch = h.sw.lastCacheTouch();
  h.sw.capture([{ role: "system", content: "s" }, { role: "user", content: "never answered" }]);
  h.sw.requestFailed();
  assert.equal(h.sw.lastCacheTouch(), touch);
  await h.advance(270_000);
  assert.equal(h.f.replays, 2);
  assert.equal(h.sw.snapshot().budget!.spent > 0, true);
});

test("a queued message at fire time: no warm, tried again shortly", async () => {
  const h = make({ ttl: 300 });
  h.open();
  h.f.queued = true;
  await h.advance(275_000);
  assert.equal(h.f.replays, 0);
  h.f.queued = false;
  await h.advance(10_000);
  assert.equal(h.f.replays, 1);
});

test("pending claude-bridge config drift ends the stretch before the replay", async () => {
  const h = make({ ttl: 300, drift: true });
  h.open();
  await h.advance(300_000);
  assert.equal(h.f.replays, 0);
  assert.deepEqual(h.reasons("skipped"), ["claude_cfg_pending"]);
  assert.equal(h.sw.state(), "ended");
});

test("an errored warm ends the stretch and is not recorded", async () => {
  const h = make({ reply: async () => null });
  h.open();
  await h.advance(54 * MIN);
  assert.equal(h.f.recorded.length, 0);
  assert.deepEqual(h.reasons("window_end"), ["error"]);
});

test("model change, compaction and shutdown abort an in-flight warm", async () => {
  for (const act of ["onModelChange", "onCompact", "onShutdown"] as const) {
    const h = make({ reply: () => new Promise<WarmReply | null>(() => {}) });
    h.open();
    await h.advance(54 * MIN);
    h.sw[act]();
    assert.equal(h.f.signals[0].aborted, true, act);
  }
});

test("miss contingency: the first completed warm with cacheWrite >= cacheRead switches the warming off for the session", async () => {
  const h = make({ reply: async () => ({ ...HIT, usage: { ...HIT.usage, cacheRead: 0, cacheWrite: 100_000 } }) });
  h.open();
  await h.advance(54 * MIN);
  assert.equal(h.f.recorded.length, 1, "the call is still recorded");
  assert.deepEqual(h.reasons("window_end"), ["self_warm_miss"]);
  assert.equal(h.sw.owns(), false);
  assert.equal(h.sw.missed(), true);
});

test("a late timer (more than half the margin past due) skips the warm", async () => {
  const h = make();
  h.open();
  h.clock.t += 54 * MIN + 4 * MIN; // margin is 6 min, half is 3
  const slot = h.slots.filter((s) => !s.dead).sort((a, b) => b.at - a.at)[0];
  slot.dead = true;
  slot.fn();
  await flush();
  assert.equal(h.f.replays, 0);
  assert.deepEqual(h.reasons("skipped"), ["late"]);
});

test("noteWarmLine (a stray Pi-sent warm) moves the cache touch and counts toward the budget", () => {
  const h = make();
  h.sw.noteRequest(100_000);
  const ts = new Date(h.clock.t + 5 * MIN).toISOString();
  h.sw.noteWarmLine({ ts, input: 0, output: 0, cacheRead: 100_000, cacheWrite: 0 } as UsageLine);
  assert.equal(h.sw.lastCacheTouch(), Date.parse(ts));
  assert.ok(h.sw.snapshot().budget!.spent > 0);
});

test("snapshot: tier, warms left, span end and tick", async () => {
  const h = make({ ttl: 300 });
  h.open();
  const s = h.sw.snapshot();
  assert.equal(s.tickMs, 270_000);
  assert.equal(s.nextWarmAt, h.t0 + 270_000);
  assert.deepEqual([s.tier?.tier, s.warmsLeft, s.budget?.share], ["quarter", 4, 0.25]);
  assert.equal(s.spanEndAt, h.t0 + 4 * 270_000 + 300_000);
  assert.equal(s.warmsFresh, 4);
});

test("snapshot: the fresh warm count ignores what the stretch has spent", async () => {
  const h = make({ ttl: 300 });
  h.open();
  await h.advance(280_000);
  const s = h.sw.snapshot();
  assert.ok(s.warmsLeft < 4, "a warm was spent");
  assert.equal(s.warmsFresh, 4);
});

// ---- policy: deprecated keys ------------------------------------------------------------------------------

test("keepalive.enabled is the only switch: deprecated keys are accepted and change nothing", () => {
  const cfg = (ka: unknown, extra: Record<string, unknown> = {}) => ({ providers: { "claude-bridge": { cache: { ttlSeconds: 3600, keepalive: ka, ...extra } } } });
  assert.equal(resolveWarmPolicy(cfg({ enabled: true }), "claude-bridge").keepaliveOwned, true);
  assert.equal(resolveWarmPolicy(cfg({}), "claude-bridge").keepaliveOwned, false);
  assert.equal(resolveWarmPolicy(cfg({ enabled: false }), "claude-bridge").keepaliveOwned, false);
  assert.equal(resolveWarmPolicy(cfg({ enabled: true }, { billing: "request" }), "claude-bridge").keepaliveOwned, false);
  assert.equal(resolveWarmPolicy({ providers: { "claude-bridge": { cache: { ttlSeconds: 10, keepalive: { enabled: true } } } } }, "claude-bridge").keepaliveOwned, false);
  assert.equal(resolveWarmPolicy({ providers: { "claude-bridge": { cache: { ttlSeconds: 11, keepalive: { enabled: true } } } } }, "claude-bridge").keepaliveOwned, true);
  const dep = { enabled: true, beyondPiCap: false, windowMinutes: 5, selfWarmWindowMinutes: 5, awayTicks: 3, whileWaiting: false, intervalSeconds: 60 };
  const p = resolveWarmPolicy(cfg(dep), "claude-bridge");
  assert.equal(p.keepaliveOwned, true);
  assert.equal(resolveWarmPolicy({}, "other").skip, "no_entry");
});

test("deprecated keys do not change when the warm goes out or how many", async () => {
  const dep = resolveWarmPolicy({ providers: { p: { cache: { ttlSeconds: 300, billing: "token", keepalive: { enabled: true, windowMinutes: 1, awayTicks: 0, whileWaiting: false, intervalSeconds: 5, selfWarmWindowMinutes: 1, beyondPiCap: false } } } } }, "p");
  const h = make({ ttl: 300, policy: dep });
  h.open();
  await h.advance(60 * MIN);
  assert.equal(h.f.replays, 4);
  assert.equal(h.sw.owns(), true);
});

// ---- replay ------------------------------------------------------------------------------------------------

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
