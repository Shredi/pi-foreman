// Session-wide warm state (docs/cache.md, Keep-alive): two SelfWarm instances of one process share one owner, the miss flag and the
// budget; any completed warm that did not read the cache is a miss; `next` carries the last measured warm across stretches; a bridge
// child does not warm unless keepalive.children is true. Usage shapes are taken from a recorded bridge trace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SelfWarm, type WarmReply, type WarmSignals } from "../selfwarm.ts";
import { Presence } from "../presence.ts";
import { WarmBudget } from "../warmbudget.ts";
import { bridgeChildrenOn, createWarm } from "../warmwire.ts";
import type { CachePolicy } from "../cachepolicy.ts";
import type { UsageLine } from "../usage.ts";

const RATES = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const NONE: WarmSignals = { strongA: null, turn: false, question: false, dialog: false, command: false };
const MISS: WarmReply = { provider: "p", model: "m", usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 69740 }, timestamp: 0 };
const HIT: WarmReply = { provider: "p", model: "m", usage: { input: 3, output: 1, cacheRead: 132423, cacheWrite: 12452 }, timestamp: 0 };
const policy: CachePolicy = { active: true, ttlSeconds: 300, intervalSeconds: 0, windowMinutes: 0, effectiveWindowMinutes: 0, warmCompact: true, budgetShare: 1, keepaliveOwned: true };
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
let seq = 0;

function rig(replies: WarmReply[], instances = 2, key: string | null = `session-${++seq}-${Date.now()}`) {
  const clock = { t: 10_000_000 };
  const mode = { replayable: true };
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
  const traces: Record<string, unknown>[] = [];
  const fired = { n: 0 };
  const sws = Array.from({ length: instances }, () => {
    const presence = new Presence({ now: () => clock.t, timers, config: () => ({ enabled: false, awayAfterMinutes: 11, command: null }), probe: async () => 0, trace: () => {} });
    return new SelfWarm({
      now: () => clock.t,
      timers,
      isChild: true,
      policy: () => policy,
      presence,
      signals: () => NONE,
      queued: () => false,
      rates: () => RATES,
      compact: () => null,
      sessionKey: key === null ? undefined : () => key,
      trace: (r) => void traces.push(r),
      replayable: () => mode.replayable,
      replay: async () => replies[Math.min(fired.n++, replies.length - 1)] ?? null,
      record: () => ({ cost: { total: 0.05 } }) as UsageLine,
    });
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
  /** A real request seen by every instance (the adapter is loaded twice in a bridge child). */
  const request = (prompt = 100_000): void => {
    for (const sw of sws) sw.capture([{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
    for (const sw of sws) sw.noteRequest(prompt);
  };
  const ev = (event: string, outcome?: string) => traces.filter((r) => r.event === event && (outcome === undefined || r.outcome === outcome));
  return { sws, advance, request, ev, fired, traces, mode };
}

test("two instances of one session: one fires, the other never does; the miss is traced once and ends the stretch for both, the next real request re-arms them", async () => {
  const h = rig([MISS]);
  h.request();
  await h.advance(270_000);
  assert.equal(h.fired.n, 1);
  await h.advance(20 * 60_000);
  assert.equal(h.fired.n, 1);
  assert.deepEqual(h.ev("keepalive", "window_end").map((r) => r.reason), ["self_warm_miss"]);
  assert.deepEqual(h.sws.map((s) => [s.missed(), s.owns()]), [[true, false], [true, false]]);
  h.request(); // a new idle stretch: the owner warms again (its miss does not carry over)
  await h.advance(10 * 60_000);
  assert.equal(h.fired.n, 2);
  assert.equal(h.ev("keepalive", "fired").length, 2);
});

test("the passive instance takes over when the owner shuts down", async () => {
  const h = rig([HIT]);
  h.request();
  h.sws[0].onShutdown();
  h.request();
  await h.advance(270_000);
  assert.equal(h.fired.n, 1);
});

test("a second warm with cacheRead 0 is a miss too", async () => {
  const h = rig([HIT, MISS], 1, null);
  h.request();
  await h.advance(270_000);
  assert.equal(h.sws[0].missed(), false);
  assert.equal(h.fired.n, 1);
  await h.advance(270_000);
  assert.equal(h.fired.n, 2);
  assert.equal(h.sws[0].missed(), true);
  assert.deepEqual(h.ev("keepalive", "window_end").map((r) => r.reason), ["self_warm_miss"]);
  await h.advance(60 * 60_000);
  assert.equal(h.fired.n, 2);
});

test("after a miss warmsLeft is 0 on every instance and warmsFresh is the count a fresh stretch would allow", async () => {
  const h = rig([MISS]);
  h.request();
  const fresh = h.sws[1].snapshot().warmsFresh;
  assert.ok(fresh > 0);
  await h.advance(270_000);
  for (const sw of h.sws) {
    const s = sw.snapshot();
    assert.equal(s.warmsLeft, 0);
    assert.equal(s.warmsFresh, fresh);
  }
});

test("next uses the measured cost of the last warm when the stretch has none yet; spent counts every warm", () => {
  const b = new WarmBudget();
  b.reset(144_875);
  const cold = b.check(RATES, 1)!;
  assert.equal(cold.spent, 0);
  b.note(HIT.usage as never);
  const hit = b.check(RATES, 1)!;
  const hitCost = (3 * 5 + 132423 * 0.5 + 12452 * 6.25 + 1 * 25) / 1e6;
  assert.ok(Math.abs(hit.next - hitCost) < 1e-9);
  assert.ok(Math.abs(hit.spent - hitCost) < 1e-9);
  b.note(MISS.usage as never);
  const missCost = (3 * 5 + 69740 * 6.25 + 25) / 1e6;
  assert.ok(Math.abs(b.check(RATES, 1)!.spent - (hitCost + missCost)) < 1e-9);
  // a new stretch: no warm yet, `next` is the measured last warm that hit (the miss does not count), scaled to the new prompt size
  b.reset(144_875);
  assert.equal(b.check(RATES, 1)!.spent, 0);
  assert.ok(Math.abs(b.check(RATES, 1)!.next - hitCost) < 1e-9);
  b.reset(289_750);
  const scaled = (3 * 5 * 2 + 132423 * 2 * 0.5 + 12452 * 2 * 6.25 + 1 * 25) / 1e6;
  assert.ok(Math.abs(b.check(RATES, 1)!.next - scaled) < 1e-9);
});

test("snapshot of a new stretch prices next from the last measured warm", async () => {
  const h = rig([HIT], 1, null);
  h.request(144_875);
  const before = h.sws[0].snapshot().budget!.next;
  await h.advance(270_000);
  h.request(144_875);
  const after = h.sws[0].snapshot().budget!.next;
  assert.ok(after > before, `measured ${after} should exceed the cacheRead-only guess ${before}`);
});

test("noteWarmLine is noted by the owning instance only (no double count in the shared budget)", () => {
  const h = rig([HIT]);
  h.request();
  const line = { ts: new Date(10_000_000).toISOString(), ...HIT.usage } as unknown as UsageLine;
  for (const sw of h.sws) sw.noteWarmLine(line);
  const one = (3 * 5 + 132423 * 0.5 + 12452 * 6.25 + 1 * 25) / 1e6;
  const spent = h.sws[0].snapshot().budget!.spent;
  assert.ok(Math.abs(spent - one) < 1e-9, `counted once, got ${spent}`);
});

test("an owner that stops owning (not_owned) releases the claim so another instance can take over", async () => {
  const h = rig([HIT]);
  h.request();
  h.mode.replayable = false;
  h.sws[0].noteRequest(100_000);
  assert.equal(h.sws[0].state(), "off");
  h.mode.replayable = true;
  h.sws[1].noteRequest(100_000);
  assert.equal(h.sws[1].state(), "watching");
  await h.advance(270_000);
  assert.equal(h.fired.n, 1);
});

test("not_replayable is traced by one instance only", () => {
  const h = rig([HIT]);
  h.mode.replayable = false;
  h.request();
  assert.equal(h.ev("keepalive", "skipped").filter((r) => r.reason === "not_replayable").length, 1);
});

// ---- child sessions on claude-bridge ---------------------------------------------------------------------

function wire(config: unknown, isChild: boolean, provider = "claude-bridge") {
  const traces: Record<string, unknown>[] = [];
  const id = `wire-${++seq}-${Date.now()}`;
  const { selfWarm } = createWarm({
    pi: { getAllTools: () => [], getActiveTools: () => [], getThinkingLevel: () => "off", getSettings: () => ({}) } as never,
    pkgRoot: "/nonexistent",
    isChild,
    bridgeTtl: () => 300,
    ctx: () => ({ model: { provider, id: "claude-opus-4-7" }, sessionManager: { getSessionId: () => id }, modelRegistry: {} }) as never,
    config: () => config,
    usage: () => ({ file: "/nonexistent/usage.jsonl", line: {} as never }),
    trace: (r) => void traces.push(r),
    signals: () => NONE,
    queued: () => false,
    compact: () => null,
  });
  selfWarm.capture([{ role: "system", content: "s" }]);
  selfWarm.noteRequest(100_000);
  return { selfWarm, traces };
}

test("a child on claude-bridge does not warm by default: skipped bridge_child_off, traced once", () => {
  const h = wire({}, true);
  assert.equal(h.selfWarm.owns(), false);
  h.selfWarm.noteRequest(100_000);
  assert.equal(h.traces.filter((r) => r.reason === "bridge_child_off").length, 1);
  assert.equal(h.selfWarm.state(), "off");
});

test("keepalive.children: true switches the child on; the foreman and other providers are unaffected", () => {
  const on = { providers: { "claude-bridge": { cache: { keepalive: { children: true } } } } };
  assert.equal(bridgeChildrenOn(on), true);
  assert.equal(bridgeChildrenOn({}), false);
  const c = wire(on, true);
  assert.equal(c.selfWarm.owns(), true);
  assert.equal(c.traces.some((r) => r.reason === "bridge_child_off"), false);
  assert.equal(c.selfWarm.state(), "watching");
  const f = wire({}, false);
  assert.equal(f.selfWarm.owns(), true);
  assert.equal(f.traces.some((r) => r.reason === "bridge_child_off"), false);
});
