// An open question does not block idle warming; the footer shows the real warm state while a turn waits on the owner;
// a stopped stretch shows no warms; a failed replay traces a short cleaned message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SelfWarm, cleanError, type WarmReply, type WarmSignals } from "../selfwarm.ts";
import { Presence } from "../presence.ts";
import { cacheViewOf, type CacheSource } from "../footer.ts";
import { replayWarm } from "../warmreplay.ts";
import { sanitizeTrace } from "../trace.ts";
import type { CachePolicy } from "../cachepolicy.ts";
import type { UsageLine } from "../usage.ts";

const MIN = 60_000;
const RATES = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 };
const HIT: WarmReply = { provider: "p", model: "m", usage: { input: 5, output: 1, cacheRead: 100_000, cacheWrite: 0 }, timestamp: 0 };
const NONE: WarmSignals = { strongA: null, turn: false, question: false, dialog: false, command: false };
const pol = (ttl: number): CachePolicy => ({ active: false, ttlSeconds: ttl, intervalSeconds: 0, windowMinutes: 0, effectiveWindowMinutes: 0, warmCompact: true, budgetShare: 0.5, keepaliveOwned: true }) as CachePolicy;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

function make(replay: (onError?: (m: string) => void) => Promise<WarmReply | null>, sig: Partial<WarmSignals> = {}, idle: number | null = 0) {
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
  const traces: Record<string, unknown>[] = [];
  const presence = new Presence({ now: () => clock.t, timers, config: () => ({ enabled: true, awayAfterMinutes: 11, command: null }), probe: async () => idle, trace: (r) => void traces.push(r) });
  const p = pol(3600);
  const sw = new SelfWarm({
    now: () => clock.t,
    timers,
    isChild: false,
    policy: () => p,
    presence,
    signals: () => ({ ...NONE, ...sig }),
    queued: () => false,
    rates: () => RATES,
    compact: () => null,
    contextTokens: () => 700_000,
    contextWindow: () => 1_000_000,
    trace: (r) => void traces.push(r),
    replayable: () => true,
    replay: (_m, _s, onError) => replay(onError),
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
  sw.capture([{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
  sw.noteRequest(100_000);
  sw.start();
  return { sw, traces, advance };
}

test("an open question: a warm fires at its due time, reason question, half tier while the owner is present", async () => {
  const h = make(async () => HIT, { question: true });
  await h.advance(54 * MIN);
  const fired = h.traces.filter((r) => r.event === "keepalive" && r.outcome === "fired");
  assert.equal(fired.length, 1);
  assert.deepEqual([fired[0].reason, fired[0].tier], ["question", "half"]);
});

test("an open question with the owner away: the quarter tier", async () => {
  const h = make(async () => HIT, { question: true }, 20 * MIN * 1000 / 1000);
  await h.advance(54 * MIN);
  const fired = h.traces.filter((r) => r.event === "keepalive" && r.outcome === "fired");
  assert.equal(fired.length, 1);
  assert.equal(fired[0].tier, "quarter");
});

test("a failed replay ends the stretch: snapshot shows no warms and no next warm; the end traces the message", async () => {
  const h = make(async (onError) => (onError?.("overloaded\u0007\n  retry later " + "x".repeat(400)), null));
  assert.ok(h.sw.snapshot().warmsLeft > 0);
  assert.ok(h.sw.snapshot().nextWarmAt !== null);
  await h.advance(54 * MIN);
  const s = h.sw.snapshot();
  assert.equal(s.warmsLeft, 0);
  assert.equal(s.nextWarmAt, null);
  const end = h.traces.find((r) => r.event === "keepalive" && r.outcome === "window_end");
  assert.equal(end?.reason, "error");
  const msg = String(end?.message);
  assert.match(msg, /^overloaded retry later x+$/);
  assert.equal(msg.length, 200);
  assert.equal(sanitizeTrace(end!).message, msg, "the trace keeps the message of a window_end");
});

test("a thrown replay error is traced the same way; a window_end without a message has none", async () => {
  const h = make(async () => {
    throw new Error("boom");
  });
  await h.advance(54 * MIN);
  assert.equal(h.traces.find((r) => r.outcome === "window_end")?.message, "boom");
  const ok = make(async () => null);
  await ok.advance(54 * MIN);
  assert.equal("message" in (ok.traces.find((r) => r.outcome === "window_end") ?? {}), false);
});

test("replayWarm hands the provider's error text to onError", async () => {
  const seen: string[] = [];
  const out = await replayWarm({}, [], new AbortController().signal, {
    convertToLlm: () => [], thinkingLevel: () => "off", sessionId: () => "s", cacheRetention: () => undefined,
    onError: (m) => void seen.push(m),
    streamSimple: () => ({ result: async () => ({ usage: {}, stopReason: "error", errorMessage: "429 slow down" }) }),
  });
  assert.equal(out, null);
  assert.deepEqual(seen, ["429 slow down"]);
  assert.equal(cleanError("a\u0000b"), "a b");
});

const POLICY: CachePolicy = { active: true, ttlSeconds: 300, intervalSeconds: 270, windowMinutes: 45, effectiveWindowMinutes: 30, warmCompact: true, budgetShare: 0.5, awayTicks: 0 } as CachePolicy;
const T0 = 1_000_000_000;
const src = (over: Partial<CacheSource> = {}): CacheSource => ({
  policy: POLICY, now: T0, lastTouch: T0, stretchStartAt: T0, nextWarmAt: T0 + 270_000, spanEndAt: T0 + 3 * 270_000 + 300_000,
  warmsLeft: 3, warmsFresh: 5, tier: "half", running: false, downshifted: false, idleRung: null, enabled: true, symbols: "unicode", ...over,
});

test("footer: a running turn that waits shows the real warms and cold like an idle one; a running turn keeps the fresh count", () => {
  const idle = cacheViewOf(src())!;
  const waiting = cacheViewOf(src({ running: true, waiting: true }))!;
  assert.deepEqual(waiting.warms, idle.warms);
  assert.equal(waiting.cold, idle.cold);
  assert.equal(waiting.warms!.count, 3);
  const busy = cacheViewOf(src({ running: true }))!;
  assert.equal(busy.warms!.count, 5, "the fresh stretch's count");
  const busyCold = cacheViewOf(src({ running: true, waiting: false, now: T0 + 10 * 300_000 }))!;
  assert.equal(busyCold.cold, false, "running: never cold");
  assert.equal(cacheViewOf(src({ running: true, waiting: true, now: T0 + 10 * 300_000 }))!.cold, true);
});
