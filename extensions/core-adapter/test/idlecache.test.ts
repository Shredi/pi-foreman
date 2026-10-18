// Idle cache keep-alive state machine (idlecache.ts): fake clock, fake one-slot timers.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import coreAdapter from "../index.ts";
import { CompactionGate } from "../compaction.ts";
import { IdleCache, type Busy } from "../idlecache.ts";
import type { CachePolicy } from "../cachepolicy.ts";
import { TRACE_FIELDS } from "../trace.ts";

const POLICY: CachePolicy = { active: true, ttlSeconds: 300, billing: "token", intervalSeconds: 270, windowMinutes: 45, effectiveWindowMinutes: 30, warmCompact: true };
const SHORT: CachePolicy = { ...POLICY, windowMinutes: 1, effectiveWindowMinutes: 1 };
const NOT_BUSY: Busy = { childRun: false, wait: false, launchWait: false, pendingMessages: false, notIdle: false };
const MIN = 60_000;

interface Slot {
  fn: () => void;
  at: number;
  dead: boolean;
}

function make(over: { policy?: CachePolicy | null; isChild?: boolean; compactImpl?: () => { tier: string; model: string | null } | null } = {}) {
  const clock = { t: 1_000_000 };
  const slots: Slot[] = [];
  let sets = 0;
  const timers = {
    set(fn: () => void, ms: number) {
      sets += 1;
      const s: Slot = { fn, at: clock.t + ms, dead: false };
      slots.push(s);
      return s;
    },
    clear(h: unknown) {
      if (h) (h as Slot).dead = true;
    },
  };
  const traces: Record<string, unknown>[] = [];
  const glyph: boolean[] = [];
  const f = {
    policy: over.policy === undefined ? POLICY : over.policy,
    pi: true,
    pc: true,
    busy: { ...NOT_BUSY },
    sync: { newEntries: 0, lastReadAt: null as number | null },
    assistantAt: null as number | null,
    compactResult: { tier: "premium", model: "p/m" } as { tier: string; model: string | null } | null,
    compactCalls: 0,
    order: [] as string[],
    throwSync: false,
  };
  const ic = new IdleCache({
    now: () => clock.t,
    timers,
    policy: () => f.policy,
    piIdleMode: () => f.pi,
    hasPromptCache: () => f.pc,
    busy: () => {
      f.order.push("busy");
      return f.busy;
    },
    trace: (r) => void traces.push(r),
    compact: () => {
      f.order.push("compact");
      f.compactCalls += 1;
      return over.compactImpl ? over.compactImpl() : f.compactResult;
    },
    setGlyph: (on) => void glyph.push(on),
    syncKeepalives: () => {
      f.order.push("sync");
      if (f.throwSync) throw new Error("boom");
      return f.sync;
    },
    lastAssistantAt: () => f.assistantAt,
    isChild: over.isChild ?? false,
  });
  const live = (): Slot[] => slots.filter((s) => !s.dead);
  const advance = (ms: number): void => {
    const target = clock.t + ms;
    for (;;) {
      const due = live().filter((s) => s.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.dead = true;
      clock.t = Math.max(clock.t, due.at);
      due.fn();
    }
    clock.t = target;
  };
  const t0 = clock.t;
  const advanceTo = (rel: number): void => advance(t0 + rel - clock.t);
  /** What Pi does on a tick: ask the hook, then append the entry. */
  const tick = (): void => {
    ic.noteDecision(ic.decide(NOT_BUSY));
    f.sync.lastReadAt = clock.t;
  };
  /** Pi ticks every 270 s until `rel`. */
  const warmUntil = (rel: number): void => {
    for (let k = 1; k * 270_000 <= rel; k++) {
      advanceTo(k * 270_000);
      tick();
    }
  };
  const reasons = (outcome = "window_end"): unknown[] => traces.filter((r) => r.event === "keepalive" && r.outcome === outcome).map((r) => r.reason);
  return { ic, f, clock, traces, glyph, live, advance, advanceTo, tick, warmUntil, reasons, sets: () => sets, t0 };
}

test("start on settled: watching, glyph on, one timer; repeated start adds no second timer", () => {
  const h = make();
  h.ic.start();
  assert.equal(h.ic.state(), "watching");
  assert.deepEqual(h.glyph, [true]);
  assert.equal(h.live().length, 1);
  assert.equal(h.sets(), 1);
  h.ic.start();
  h.ic.start();
  assert.equal(h.sets(), 1);
  assert.equal(h.live().length, 1);
});

for (const key of ["childRun", "wait", "launchWait", "pendingMessages", "notIdle"] as const) {
  test(`start refused while busy via ${key}: traced once per idle, retried at the next settle`, () => {
    const h = make();
    h.f.busy[key] = true;
    h.ic.start();
    h.ic.start();
    assert.equal(h.ic.state(), "off");
    assert.equal(h.live().length, 0);
    assert.deepEqual(h.reasons("skipped"), ["busy"]);
    h.f.busy[key] = false;
    h.ic.start();
    assert.equal(h.ic.state(), "watching");
    h.ic.end("activity");
    h.ic.onAgentStart();
    h.f.busy[key] = true;
    h.ic.start();
    assert.deepEqual(h.reasons("skipped"), ["busy", "busy"], "a new idle traces again");
  });
}

test("check order: child and no_entry return silently before any busy trace", () => {
  const noEntry: CachePolicy = { ...POLICY, active: false, skip: "no_entry" };
  const a = make({ policy: noEntry });
  a.f.busy.childRun = true;
  a.ic.start();
  assert.deepEqual(a.traces, []);
  const b = make({ policy: null });
  b.ic.start();
  assert.deepEqual(b.traces, []);
  const c = make({ isChild: true, policy: { ...POLICY, active: false, skip: "billing_request" } });
  c.ic.start();
  assert.deepEqual(c.traces, []);
  assert.equal(c.ic.state(), "off");
});

test("a child session with an active policy stays silent: no trace, no timer", () => {
  const h = make({ isChild: true });
  h.f.assistantAt = h.clock.t;
  h.ic.start();
  assert.deepEqual(h.traces, []);
  assert.equal(h.ic.state(), "off");
  assert.equal(h.sets(), 0);
  assert.equal(h.live().length, 0);
});

test("skips are traced once per reason per session", () => {
  for (const skip of ["billing_request", "ttl_long", "ttl_unknown", "disabled"] as const) {
    const h = make({ policy: { ...POLICY, active: false, skip } });
    h.ic.start();
    h.ic.start();
    assert.deepEqual(h.traces, [{ event: "keepalive", outcome: "skipped", reason: skip }]);
    assert.equal(h.ic.state(), "off");
  }
  const pi = make();
  pi.f.pi = false;
  pi.ic.start();
  pi.ic.start();
  assert.deepEqual(pi.traces, [{ event: "keepalive", outcome: "skipped", reason: "pi_mode_not_idle" }]);
  const pc = make();
  pc.f.pc = false;
  pc.ic.start();
  pc.ic.start();
  assert.deepEqual(pc.traces, [{ event: "keepalive", outcome: "skipped", reason: "no_prompt_cache" }]);
});

test("end on each activity event and the resulting state; glyph off on every path", () => {
  const cases: [string, (h: ReturnType<typeof make>) => void, string, string][] = [
    ["activity", (h) => h.ic.onActivity(), "off", "activity"],
    ["agent_start", (h) => h.ic.onAgentStart(), "off", "activity"],
    ["compact", (h) => h.ic.onCompact(), "ended", "compact"],
    ["shutdown", (h) => h.ic.onShutdown(), "off", "shutdown"],
    ["error", (h) => h.ic.end("error"), "off", "error"],
    ["hook_stop", (h) => h.ic.end("hook_stop"), "off", "hook_stop"],
    ["window", (h) => h.ic.end("window"), "ended", "window"],
    ["warmer_stopped", (h) => h.ic.end("warmer_stopped"), "off", "warmer_stopped"],
  ];
  for (const [name, fn, state, reason] of cases) {
    const h = make();
    h.ic.start();
    fn(h);
    assert.equal(h.ic.state(), state, name);
    assert.deepEqual(h.reasons(), [reason], name);
    assert.equal(h.glyph[h.glyph.length - 1], false, name);
    assert.equal(h.live().length, 0, name);
    fn(h); // idempotent
    assert.deepEqual(h.reasons(), [reason], name);
  }
});

test("ended is sticky until agent_start resets it to off", () => {
  const h = make();
  h.ic.start();
  h.ic.onCompact();
  assert.equal(h.ic.state(), "ended");
  h.ic.start();
  assert.equal(h.ic.state(), "ended", "no second window in the same idle");
  h.ic.onAgentStart();
  assert.equal(h.ic.state(), "off");
  h.ic.start();
  assert.equal(h.ic.state(), "watching");
  const w = make();
  w.ic.end("compact"); // a compaction while off changes nothing
  assert.equal(w.ic.state(), "off");
});

test("compactAt is windowEnd - interval: window 45 -> 30 min checks at 25.5 min, not 40.5", () => {
  const h = make();
  h.ic.noteTurnStart(h.clock.t);
  h.ic.start();
  h.warmUntil(22.5 * MIN);
  h.advanceTo(25.4 * MIN);
  assert.equal(h.f.compactCalls, 0);
  h.advanceTo(25.5 * MIN);
  assert.equal(h.f.compactCalls, 1);
  assert.deepEqual(h.traces.filter((r) => r.event === "compaction"), [{ event: "compaction", reason: "warm_idle", tier: "premium", model: "p/m" }]);
  assert.equal(h.ic.decide(NOT_BUSY), undefined, "watching after the compaction started");
  h.ic.onCompact();
  assert.equal(h.ic.state(), "ended");
  assert.deepEqual(h.reasons(), ["compact"]);
  h.advanceTo(41 * MIN);
  assert.equal(h.f.compactCalls, 1, "one compaction per idle");
});

test("windowEndAt is bounded by lastTurnStartAt + 30 min", () => {
  const h = make();
  h.f.compactResult = null;
  h.ic.noteTurnStart(h.clock.t - 10 * MIN); // window end = start + 20 min, compactAt = 15.5 min
  h.ic.start();
  h.warmUntil(15 * MIN);
  h.advanceTo(15.4 * MIN);
  assert.equal(h.f.compactCalls, 0);
  h.advanceTo(15.5 * MIN);
  assert.equal(h.f.compactCalls, 1);
  h.warmUntil(19.9 * MIN);
  assert.equal(h.ic.state(), "watching");
  h.advanceTo(20 * MIN);
  assert.equal(h.ic.state(), "ended");
  assert.deepEqual(h.reasons(), ["below_floor", "window"]);
});

test("window_end trace when the window runs out", () => {
  const h = make({ policy: SHORT });
  h.f.compactResult = null;
  h.f.assistantAt = h.clock.t;
  h.ic.start();
  h.advanceTo(59_000);
  assert.equal(h.ic.state(), "watching");
  h.advanceTo(60_000);
  assert.equal(h.ic.state(), "ended");
  assert.deepEqual(h.reasons(), ["below_floor", "window"]);
  assert.deepEqual(h.glyph, [true, false]);
});

test("compaction gates in order, each with its reason; the floor gate runs last", () => {
  const run = (setup: (h: ReturnType<typeof make>) => void, policy: CachePolicy = SHORT) => {
    const h = make({ policy });
    h.f.assistantAt = h.clock.t;
    setup(h);
    h.ic.start();
    h.f.order.length = 0;
    h.advanceTo(30_000);
    return h;
  };
  const off = run((h) => (h.f.policy = { ...SHORT, warmCompact: false }));
  assert.deepEqual(off.reasons(), ["warm_compact_off"]);
  assert.deepEqual(off.f.order, ["sync"]);
  assert.equal(off.f.compactCalls, 0);

  const busy = run((h) => (h.f.busy.wait = true));
  assert.deepEqual(busy.reasons(), []);
  // start itself is refused while busy, so the busy gate needs a child run that starts after start()
  const late = make({ policy: SHORT });
  late.f.assistantAt = late.clock.t;
  late.ic.start();
  late.f.busy.childRun = true;
  late.f.order.length = 0;
  late.advanceTo(30_000);
  assert.deepEqual(late.reasons(), ["busy"]);
  assert.deepEqual(late.f.order, ["sync", "busy"]);
  assert.equal(late.f.compactCalls, 0);

  const cold = run((h) => (h.f.assistantAt = h.clock.t - 400_000));
  assert.deepEqual(cold.reasons(), ["cold"]);
  assert.deepEqual(cold.f.order, ["sync", "busy"]);
  assert.equal(cold.f.compactCalls, 0);

  const floor = run((h) => (h.f.compactResult = null));
  assert.deepEqual(floor.reasons(), ["below_floor"]);
  assert.deepEqual(floor.f.order, ["sync", "busy", "compact"]);

  const done = make({ policy: SHORT });
  done.f.assistantAt = done.clock.t;
  done.ic.start();
  (done.ic as unknown as { compactedForIdle: boolean }).compactedForIdle = true;
  done.advanceTo(30_000);
  assert.deepEqual(done.reasons(), ["already_compacted"]);
});

test("sync runs before the cold check: a fresh keep-alive entry makes it warm", () => {
  const h = make({ policy: SHORT });
  h.f.assistantAt = h.clock.t - 400_000;
  h.ic.start();
  h.f.sync = { newEntries: 1, lastReadAt: h.clock.t + 20_000 };
  h.f.order.length = 0;
  h.advanceTo(30_000);
  assert.deepEqual(h.f.order, ["sync", "busy", "compact"]);
  assert.equal(h.f.compactCalls, 1);
});

test("decideIdle is evaluated last: a failing cheaper gate leaves the latch unset", () => {
  const gate = new CompactionGate();
  const cfg = { tiers: { cheap: 1, standard: 5 }, thresholds: { premium: 0.6 } };
  const model = { cost: { input: 15 } };
  const usage = { tokens: 40_000, contextWindow: 100_000 };
  const compactImpl = () => {
    const tier = gate.decideIdle("s", model, usage, cfg);
    return tier ? { tier, model: "p/m" } : null;
  };
  const cold = make({ policy: SHORT, compactImpl });
  cold.f.assistantAt = cold.clock.t - 400_000;
  cold.ic.start();
  cold.advanceTo(30_000);
  assert.deepEqual(cold.reasons(), ["cold"]);
  assert.equal(gate.decideIdle("s", model, { tokens: 1, contextWindow: 100_000 }, cfg), null);
  const ok = make({ policy: SHORT, compactImpl });
  ok.f.assistantAt = ok.clock.t;
  ok.ic.start();
  ok.advanceTo(30_000);
  assert.equal(ok.traces.filter((r) => r.event === "compaction").length, 1);
  assert.equal(gate.decideIdle("s", model, usage, cfg), null, "latched by the warm compaction");
});

test("hook rules R1-R5", () => {
  const off = make();
  assert.equal(off.ic.decide(NOT_BUSY), undefined, "off");
  const h = make();
  h.ic.start();
  assert.equal(h.ic.decide(NOT_BUSY), "warm", "watching in the window");
  for (const key of ["childRun", "wait", "launchWait", "pendingMessages"] as const) assert.equal(h.ic.decide({ ...NOT_BUSY, [key]: true }), undefined, key);
  assert.equal(h.ic.decide({ ...NOT_BUSY, notIdle: true }), undefined, "only notIdle");
  h.clock.t += 31 * MIN;
  assert.equal(h.ic.decide(NOT_BUSY), undefined, "watching past the window end");
  const e = make();
  e.ic.start();
  e.ic.onCompact();
  assert.equal(e.ic.decide(NOT_BUSY), "stop", "ended");
  assert.equal(e.ic.decide({ ...NOT_BUSY, childRun: true }), undefined, "ended + child run");
  assert.equal(e.ic.decide({ ...NOT_BUSY, notIdle: true }), undefined);
  e.ic.onAgentStart();
  assert.equal(e.ic.decide(NOT_BUSY), undefined, "off after agent_start");
});

test("watchdog: the warmer never asked -> warmer_stopped after max(interval, piTick) + 60 s", () => {
  const h = make();
  h.ic.start();
  h.advanceTo(329_000);
  assert.equal(h.ic.state(), "watching");
  h.advanceTo(331_000);
  assert.equal(h.ic.state(), "off");
  assert.deepEqual(h.reasons(), ["warmer_stopped"]);
  const g = make();
  g.ic.start();
  g.warmUntil(540_000); // two ticks, then Pi stops calling the hook
  assert.equal(g.ic.state(), "watching");
  g.advanceTo(540_000 + 331_000);
  assert.deepEqual(g.reasons(), ["warmer_stopped"]);
});

test("lastDecisionAt moves only on warm", () => {
  const h = make();
  h.ic.start();
  h.advanceTo(300_000);
  h.ic.noteDecision(undefined);
  assert.equal(h.ic.state(), "watching");
  h.advanceTo(331_000);
  assert.equal(h.ic.state(), "off", "the undefined answer did not postpone the watchdog");
});

test("confirm: hook called every tick but no entry appended -> warmer_stopped; entries arriving keep it alive", () => {
  const h = make();
  h.ic.start();
  h.advanceTo(270_000);
  h.ic.noteDecision("warm"); // no entry follows
  h.advanceTo(359_000);
  assert.equal(h.ic.state(), "watching");
  h.advanceTo(361_000);
  assert.equal(h.ic.state(), "off");
  assert.deepEqual(h.reasons(), ["warmer_stopped"]);

  const ok = make();
  ok.ic.noteTurnStart(ok.clock.t);
  ok.f.compactResult = null;
  ok.ic.start();
  ok.warmUntil(20 * MIN);
  assert.equal(ok.ic.state(), "watching");
  assert.deepEqual(ok.reasons(), []);
});

test("an exception in the timer callback ends with error and never compacts", () => {
  const h = make({ policy: SHORT });
  h.f.assistantAt = h.clock.t;
  h.ic.start();
  h.f.throwSync = true;
  h.advanceTo(30_000);
  assert.equal(h.ic.state(), "off");
  assert.deepEqual(h.reasons(), ["error"]);
  assert.equal(h.f.compactCalls, 0);
});

test("trace records use only TRACE_FIELDS", () => {
  const h = make({ policy: SHORT });
  h.f.assistantAt = h.clock.t;
  h.ic.start();
  h.advanceTo(60_000);
  const b = make({ policy: { ...POLICY, active: false, skip: "ttl_long" } });
  b.ic.start();
  const allowed = new Set<string>(TRACE_FIELDS);
  for (const r of [...h.traces, ...b.traces]) for (const k of Object.keys(r)) assert.ok(allowed.has(k), k);
  assert.ok(h.traces.length >= 2);
});

// ---------------------------------------------------------------- the adapter's hook (index.ts)

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

test("cache_warming_decision: R0 drift stop first, children and policy-less sessions stay silent, watching warms", async (t) => {
  const keys = ["PATH", "Path", "PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "CLAUDE_CONFIG_DIR"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-idle-")));
  let shutdown: (() => Promise<unknown>) | undefined;
  t.after(async () => {
    try { await shutdown?.(); } catch { /* best effort */ }
    await waitQuiet(path.join(root, "agent", "pi-foreman", "state"));
    rmTestTmp(root);
  });
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  delete process.env.PI_SUBAGENT_CHILD;
  const handlers = new Map<string, Handler[]>();
  const pi = { on: (n: string, h: Handler) => void handlers.set(n, [...(handlers.get(n) ?? []), h]), registerCommand: () => undefined, registerTool: () => undefined, getActiveTools: () => [] as string[], setActiveTools: () => undefined, setModel: async () => true, setThinkingLevel: () => undefined, getSettings: () => ({ cacheWarming: "idle" }) };
  coreAdapter(pi as never);
  const fire = async (name: string, ev: unknown, ctx: unknown): Promise<unknown> => {
    let out: unknown;
    for (const h of handlers.get(name) ?? []) out = (await h(ev, ctx)) ?? out;
    return out;
  };
  const ctx = (provider: string) => ({
    sessionManager: { getSessionId: () => "idle-hook", getSessionFile: () => undefined, getEntries: () => [] as unknown[] },
    cwd: project,
    model: { provider, id: "m", promptCache: { short: 300 } },
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => undefined,
    compact: () => undefined,
    modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: () => undefined, confirm: async () => false, setStatus: () => undefined },
  });
  await fire("session_start", { reason: "startup" }, ctx("claude-bridge"));
  shutdown = async () => fire("session_shutdown", {}, ctx("claude-bridge"));
  assert.equal(await fire("cache_warming_decision", {}, ctx("claude-bridge")), undefined, "off before the first settle");
  await fire("agent_settled", {}, ctx("claude-bridge"));
  assert.deepEqual(await fire("cache_warming_decision", {}, ctx("claude-bridge")), { action: "warm" }, "watching in the window");
  assert.equal(await fire("cache_warming_decision", {}, ctx("some-other-provider")), undefined, "no active policy");
  await fire("input", { source: "interactive", text: "hi" }, ctx("claude-bridge"));
  assert.equal(await fire("cache_warming_decision", {}, ctx("claude-bridge")), undefined, "input ended the window");
  await fire("agent_settled", {}, ctx("claude-bridge"));
  assert.deepEqual(await fire("cache_warming_decision", {}, ctx("claude-bridge")), { action: "warm" });
  fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(project, ".pi", "claude-bridge.json"), JSON.stringify({ provider: { pathToClaudeCodeExecutable: path.join(root, "no-such-cc") } }));
  assert.deepEqual(await fire("cache_warming_decision", {}, ctx("claude-bridge")), { action: "stop" }, "R0: drift pending");
});
