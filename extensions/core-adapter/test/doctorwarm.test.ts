import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveWarmPolicy } from "../cachepolicy.ts";
import { doctorWarm, PROBE_PREFIX_TOKENS, type DoctorWarmDeps } from "../doctorwarm.ts";
import { replayWarm, type ReplayApi } from "../warmreplay.ts";
import { r11Rig } from "./_r11rig.ts";

type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
const RATES = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const cfg = { providers: { p: { cache: { ttlSeconds: 300, keepalive: { enabled: true } } } } };

function rig(usages: Usage[], over: Partial<DoctorWarmDeps> = {}) {
  const events: string[] = [];
  const sent: { model: unknown; context: { messages: unknown[] }; options: Record<string, unknown> }[] = [];
  const traces: Record<string, unknown>[] = [];
  const confirms: string[] = [];
  const api: ReplayApi = {
    convertToLlm: (m) => m,
    thinkingLevel: () => "off",
    sessionId: () => "sess",
    cacheRetention: () => "short",
    streamSimple: (model, context, options) => {
      events.push("send");
      sent.push({ model, context: context as never, options: options as never });
      const u = usages[sent.length - 1];
      return { result: async () => (u === undefined ? { stopReason: "error", errorMessage: "boom\nfailed" } : { stopReason: "stop", provider: "p", model: "m", usage: u }) };
    },
  };
  const deps: DoctorWarmDeps = {
    model: () => ({ provider: "p", id: "m" }),
    policy: () => resolveWarmPolicy(cfg, "p", "m"),
    busy: () => false,
    hasUI: true,
    confirm: async (_t, msg) => (events.push("confirm"), confirms.push(msg), true),
    rates: () => RATES,
    api: async () => api,
    trace: (r) => traces.push(r),
    ...over,
  };
  return { deps, events, sent, traces, confirms };
}

const FRESH = { input: 10, output: 1, cacheWrite: 5000, cacheRead: 0 };
const HIT = { input: 10, output: 1, cacheRead: 5000, cacheWrite: 0 };
const MISS = { input: 5010, output: 1, cacheRead: 0, cacheWrite: 0 };

test("hit: two requests, both token counts and costs, one trace record with its own event name", async () => {
  const r = rig([FRESH, HIT]);
  const res = await doctorWarm(r.deps);
  assert.equal(res.sent, 2);
  assert.equal(r.sent.length, 2);
  assert.match(res.text, /^doctor warm: HIT on p\/m/);
  assert.match(res.text, /fresh: cacheRead 0, cacheWrite 5000, cost \$0\.0188/);
  assert.match(res.text, /warm: {2}cacheRead 5000, cacheWrite 0, cost \$0\.0015/);
  assert.match(res.text, /total cost \$0\.0203/);
  assert.deepEqual(r.traces.map((t) => [t.event, t.outcome]), [["doctor_warm", "hit"]]);
});

test("miss: names the reason as the trace does, with cacheRead and cacheWrite", async () => {
  const r = rig([FRESH, MISS]);
  const res = await doctorWarm(r.deps);
  assert.equal(res.sent, 2);
  assert.match(res.text, /^doctor warm: MISS on p\/m/);
  assert.match(res.text, /reason: self_warm_miss/);
  assert.match(res.text, /cacheRead 0 of 5000 written/);
  assert.equal(res.level, "warning");
  assert.equal(r.traces[0].reason, "self_warm_miss");
});

test("miss with no cache write on the fresh request says the prefix may be too small", async () => {
  const r = rig([MISS, MISS]);
  assert.match((await doctorWarm(r.deps)).text, /below this model's minimum cacheable size/);
});

test("a partial read that does not cover the prefix is a miss", async () => {
  const r = rig([FRESH, { ...HIT, cacheRead: 1000 }]);
  assert.match((await doctorWarm(r.deps)).text, /^doctor warm: MISS/);
});

test("a failed fresh request ends the run after one request with the provider's reason", async () => {
  const r = rig([]);
  const res = await doctorWarm(r.deps);
  assert.equal(r.sent.length, 1);
  assert.equal(res.sent, 1);
  assert.match(res.text, /ERROR on the fresh request.*boom failed/);
});

test("no price: the confirmation says cost unknown and the result prints no dollar figure it cannot know", async () => {
  const r = rig([FRESH, HIT], { rates: () => null });
  const res = await doctorWarm(r.deps);
  assert.match(r.confirms[0], /cost unknown for this model/);
  assert.match(res.text, /total cost cost unknown/);
});

test("the cost statement is in the confirmation, and nothing is sent before it", async () => {
  const r = rig([FRESH, HIT]);
  await doctorWarm(r.deps);
  assert.deepEqual(r.events, ["confirm", "send", "send"]);
  assert.match(r.confirms[0], /estimated cost about \$0\.0\d+/);
  assert.match(r.confirms[0], /Two real provider requests/);
  assert.match(r.confirms[0], new RegExp(`~${PROBE_PREFIX_TOKENS}-token`));
});

test("exactly two requests per run, never a third, even on a miss", async () => {
  const r = rig([FRESH, MISS, HIT]);
  await doctorWarm(r.deps);
  assert.equal(r.sent.length, 2);
});

test("decline and a dismissed dialog send nothing", async () => {
  for (const confirm of [async () => false, async () => { throw new Error("dismissed"); }]) {
    const r = rig([FRESH, HIT], { confirm });
    const res = await doctorWarm(r.deps);
    assert.equal(r.sent.length, 0);
    assert.equal(res.sent, 0);
    assert.match(res.text, /nothing was sent/);
  }
});

test("no UI sends nothing and says so", async () => {
  const r = rig([FRESH, HIT], { hasUI: false });
  const res = await doctorWarm(r.deps);
  assert.equal(r.sent.length, 0);
  assert.deepEqual(r.confirms, []);
  assert.match(res.text, /needs a UI to ask for confirmation, so nothing was sent/);
});

test("refusals: no model, keep-alive off per skip reason with the fix, a turn in flight", async () => {
  const cases: [Partial<DoctorWarmDeps>, RegExp][] = [
    [{ model: () => null }, /refused \(no_model\)/],
    [{ policy: () => resolveWarmPolicy({}, "p", "m") }, /refused \(no_entry\).*providers\.p\.cache\.ttlSeconds and providers\.p\.cache\.keepalive\.enabled: true/],
    [{ policy: () => resolveWarmPolicy({ providers: { p: { cache: { ttlSeconds: 300, keepalive: { enabled: false } } } } }, "p", "m") }, /refused \(disabled\).*keepalive\.enabled: true/],
    [{ policy: () => resolveWarmPolicy({ providers: { p: { cache: { keepalive: { enabled: true } } } } }, "p", "m") }, /refused \(ttl_unknown\).*providers\.p\.cache\.ttlSeconds/],
    [{ policy: () => resolveWarmPolicy({ providers: { p: { cache: { ttlSeconds: 3600 } } } }, "p", "m") }, /refused \(ttl_long\)/],
    [{ policy: () => resolveWarmPolicy({ providers: { p: { cache: { ttlSeconds: 5, keepalive: { enabled: true } } } } }, "p", "m") }, /refused \(ttl_too_short\)/],
    [{ busy: () => true }, /refused \(busy\).*turn is in flight/],
  ];
  for (const [over, re] of cases) {
    const r = rig([FRESH, HIT], over);
    const res = await doctorWarm(r.deps);
    assert.match(res.text, re);
    assert.match(res.text, /No request was sent/);
    assert.equal(r.sent.length, 0);
    assert.deepEqual(r.confirms, []);
    assert.equal(r.traces[0].outcome, "refused");
  }
});

test("a turn that starts after the fresh request stops the warm", async () => {
  let n = 0;
  const r = rig([FRESH, HIT], { busy: () => ++n > 1 });
  const res = await doctorWarm(r.deps);
  assert.equal(r.sent.length, 1);
  assert.equal(res.sent, 1);
});

test("both requests go through the shared replay function, with the same unique-marker messages", async () => {
  let calls = 0;
  const r = rig([FRESH, HIT], { replay: (...a) => (calls++, replayWarm(...a)) });
  await doctorWarm(r.deps);
  assert.equal(calls, 2);
  assert.deepEqual(r.sent[0].context, r.sent[1].context);
  assert.equal(r.sent[0].options.maxTokens, 1);
  assert.equal(r.sent[0].options.sessionId, "sess");
  const text = JSON.stringify(r.sent[0].context);
  assert.match(text, /pi-foreman cache probe [0-9a-f-]{36}/);
  const again = rig([FRESH, HIT]);
  await doctorWarm(again.deps);
  assert.notEqual(text, JSON.stringify(again.sent[0].context));
});

// The adapter's /foreman doctor handler with a fake provider.
async function adapter(t: { after(fn: () => void | Promise<void>): void }, confirm: () => Promise<boolean>) {
  const requests: unknown[] = [];
  const usages = [FRESH, HIT];
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const notes: string[] = [];
  const h = await r11Rig(t, {}, {
    config: { providers: { fake: { roles: { explorer: { model: "fake/explorer" } }, cache: { ttlSeconds: 300, keepalive: { enabled: true } } } } },
    piExtra: { registerCommand: (n: string, d: { handler: typeof command }) => n === "foreman" && (command = d.handler) },
    ctx: {
      modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }), streamSimple: (_m: unknown, c: unknown) => (requests.push(c), { result: async () => ({ stopReason: "stop", usage: usages[requests.length - 1] }) }) },
      ui: { notify: (m: string) => void notes.push(m), confirm, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined },
    },
  });
  return { h, requests, notes, run: (a: string) => command!(a, h.ctx) };
}

test("plain /foreman doctor sends no request and mentions the option; doctor warm sends two after a yes and leaves the session alone", async (t) => {
  const a = await adapter(t, async () => true);
  await a.run("doctor");
  assert.equal(a.requests.length, 0);
  assert.match(a.notes.join("\n"), /\/foreman doctor warm proves the idle warm/);
  const entries = (a.h.ctx.sessionManager.getEntries() as unknown[]).length;
  a.notes.length = 0;
  await a.run("doctor warm");
  assert.equal(a.requests.length, 2);
  assert.match(a.notes.at(-1)!, /^doctor warm: HIT/);
  assert.equal((a.h.ctx.sessionManager.getEntries() as unknown[]).length, entries);
  assert.deepEqual(a.h.events("doctor_warm").map((r) => r.outcome), ["hit"]);
  assert.deepEqual(a.h.events("keepalive"), []);
});

test("/foreman doctor warm on a declined dialog sends nothing", async (t) => {
  const a = await adapter(t, async () => false);
  await a.run("doctor warm");
  assert.equal(a.requests.length, 0);
  assert.match(a.notes.at(-1)!, /declined, nothing was sent/);
});
