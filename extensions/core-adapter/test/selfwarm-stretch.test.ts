// A miss (or an error) ends warming for the idle stretch it happened in only: the next real request opens a new stretch
// with warming on again, for every instance of the session; there is no per-session stop and no attempt cap (docs/cache.md, Keep-alive).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SelfWarm, type WarmReply, type WarmSignals } from "../selfwarm.ts";
import { Presence } from "../presence.ts";
import type { CachePolicy } from "../cachepolicy.ts";
import type { UsageLine } from "../usage.ts";

const RATES = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const NONE: WarmSignals = { strongA: null, turn: false, question: false, dialog: false, command: false };
const MISS: WarmReply = { provider: "p", model: "m", usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 1000 }, timestamp: 0 };
const HIT: WarmReply = { provider: "p", model: "m", usage: { input: 3, output: 1, cacheRead: 100000, cacheWrite: 10 }, timestamp: 0 };
/** A miss that wrote the whole 100k prompt: its cost is above the quarter share, so it would refuse the next warm if it were priced in. */
const COLD_MISS: WarmReply = { provider: "p", model: "m", usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 100000 }, timestamp: 0 };
/** A hit that cost more than the quarter share (0.425 against 0.3125 at a 100k prompt), though the half share covers it. */
const BIG_HIT: WarmReply = { provider: "p", model: "m", usage: { input: 3, output: 1, cacheRead: 100000, cacheWrite: 60000 }, timestamp: 0 };
const STRONG: WarmSignals = { ...NONE, strongA: "subagent" };
const policy: CachePolicy = { active: true, ttlSeconds: 300, billing: "token", intervalSeconds: 0, windowMinutes: 0, effectiveWindowMinutes: 0, warmCompact: true, budgetShare: 1, keepaliveOwned: true };
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
let seq = 0;

/** `outcomes`: what each replay does in order (a reply, or null = an errored call); the last one repeats. */
function rig(outcomes: (WarmReply | null)[], instances = 2, sig: { v: WarmSignals } = { v: NONE }) {
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
  const key = `stretch-${++seq}-${Date.now()}`;
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
      signals: () => sig.v,
      queued: () => false,
      rates: () => RATES,
      compact: () => null,
      sessionKey: () => key,
      trace: (r) => void traces.push(r),
      replayable: () => true,
      replay: async () => outcomes[Math.min(fired.n++, outcomes.length - 1)] ?? null,
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
  const request = (): void => {
    for (const sw of sws) sw.capture([{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
    for (const sw of sws) sw.noteRequest(100_000);
  };
  const ends = () => traces.filter((r) => r.event === "keepalive" && r.outcome === "window_end").map((r) => r.reason);
  return { sws, advance, request, fired, ends };
}

test("a miss ends the stretch it happened in: no more warms until the next real request", async () => {
  const h = rig([MISS]);
  h.request();
  await h.advance(270_000);
  assert.equal(h.fired.n, 1);
  assert.equal(h.sws[0].missed(), true);
  assert.equal(h.sws[0].snapshot().endedBy, "miss");
  await h.advance(60 * 60_000);
  assert.equal(h.fired.n, 1);
  assert.deepEqual(h.ends(), ["self_warm_miss"]);
});

test("the next real request re-arms warming on every instance; the new stretch's miss ends only the new stretch", async () => {
  const h = rig([MISS, HIT, MISS]);
  h.request();
  await h.advance(270_000);
  assert.deepEqual(h.sws.map((s) => s.snapshot().endedBy), ["miss", "miss"]);
  h.request();
  assert.deepEqual(h.sws.map((s) => [s.snapshot().endedBy, s.missed()]), [[null, false], [null, false]]);
  await h.advance(270_000);
  assert.equal(h.fired.n, 2, "the new stretch warms again");
  assert.equal(h.sws[0].missed(), false, "a hit does not end it");
  await h.advance(270_000);
  assert.equal(h.fired.n, 3);
  assert.equal(h.sws[0].missed(), true);
  assert.deepEqual(h.ends(), ["self_warm_miss", "self_warm_miss"], "one window_end per ended stretch");
  await h.advance(60 * 60_000);
  assert.equal(h.fired.n, 3);
  h.request();
  await h.advance(270_000);
  assert.equal(h.fired.n, 4, "and again after the next request: no attempt cap");
});

test("a second instance of the session owns the new stretch's warms: one warm per tick", async () => {
  const h = rig([MISS, HIT]);
  h.request();
  await h.advance(270_000);
  h.request();
  await h.advance(270_000);
  assert.equal(h.fired.n, 2);
});

test("a miss does not price the next stretch out: its warm is priced at the estimate and fires where a hit fits", async () => {
  const h = rig([COLD_MISS, HIT]);
  h.request();
  await h.advance(270_000);
  assert.equal(h.fired.n, 1);
  assert.equal(h.sws[0].snapshot().endedBy, "miss");
  h.request();
  await h.advance(270_000);
  assert.equal(h.fired.n, 2, "the new stretch warms: the missed warm's cost is not its estimate");
  assert.equal(h.sws[0].missed(), false);
});

test("where even a hit does not fit the next stretch's budget, that stretch fires nothing", async () => {
  const sig = { v: STRONG };
  const h = rig([BIG_HIT, COLD_MISS], 1, sig);
  h.request();
  await h.advance(270_000); // half tier: the big hit ends the stretch by budget (its doubled cost is over the share)
  assert.equal(h.fired.n, 1);
  h.request();
  await h.advance(270_000); // half tier again: the hit's cost fits, the missed warm ends the stretch
  assert.equal(h.fired.n, 2);
  assert.equal(h.sws[0].missed(), true);
  sig.v = NONE;
  h.request(); // quarter tier: the last hit costs 0.425, above the 0.3125 share
  await h.advance(60 * 60_000);
  assert.equal(h.fired.n, 2);
  assert.deepEqual(h.ends(), ["budget", "self_warm_miss", "budget"]);
});

test("an error ending shows as endedBy error until the next real request", async () => {
  const h = rig([null, HIT]);
  h.request();
  await h.advance(270_000);
  assert.deepEqual(h.ends(), ["error"]);
  assert.equal(h.sws[0].snapshot().endedBy, "error");
  assert.equal(h.sws[0].missed(), false);
  h.request();
  assert.equal(h.sws[0].snapshot().endedBy, null);
});

test("when no warm ever hit, a new stretch prices next at the price-table estimate for a hit, not at the miss cost", async () => {
  const h = rig([COLD_MISS]);
  h.request();
  await h.advance(270_000);
  assert.equal(h.fired.n, 1);
  assert.equal(h.sws[0].snapshot().endedBy, "miss");
  h.request();
  const estimate = (100_000 * RATES.cacheRead + 1 * RATES.output) / 1e6;
  const missCost = (3 * RATES.input + 100_000 * RATES.cacheWrite + 1 * RATES.output) / 1e6;
  const next = h.sws[0].snapshot().budget!.next;
  assert.ok(Math.abs(next - estimate) < 1e-9, `next ${next} should be the hit estimate ${estimate}`);
  assert.ok(Math.abs(next - missCost) > 0.1, `next ${next} must not be the miss cost ${missCost}`);
});
