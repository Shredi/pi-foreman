// Pressure gate on child launches through the real adapter hooks (index.ts tool_call): pressure file injected, sampler and clock faked.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { rmTestTmp } from "./_tmpbase.ts";
import * as os from "node:os";
import * as path from "node:path";
import coreAdapter from "../index.ts";
import { pressurePath } from "../pressure.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Tool = { name: string; execute: (...a: unknown[]) => Promise<unknown> };

const NOW = Date.parse("2026-03-01T10:00:00Z");
let rigs = 0;
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const ROLES = ["explorer", "planner", "builder", "reviewer", "senior-reviewer", "finalizer"];

// Captured at load: tests mock setTimeout via t.mock.timers, and the after hook can still run under the mock.
const realSetTimeout = globalThis.setTimeout;

/** Poll until the state dir listing (names + sizes) is unchanged for two polls, at most 5 s. */
async function waitQuiet(dir: string): Promise<void> {
  const snap = (): string => {
    try { return fs.readdirSync(dir).sort().map((n) => `${n}:${fs.statSync(path.join(dir, n)).size}`).join("|"); } catch { return ""; }
  };
  let prev = snap();
  let stable = 0;
  for (let waited = 0; waited < 5000 && stable < 2; waited += 100) {
    await new Promise((r) => realSetTimeout(r, 100));
    const cur = snap();
    stable = cur === prev ? stable + 1 : 0;
    prev = cur;
  }
}

function tmp(t: { after(fn: () => void): void }, prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => rmTestTmp(dir));
  return dir;
}

interface Rig {
  handlers: Map<string, Handler>;
  tools: Map<string, Tool>;
  ctx: unknown;
  agentDir: string;
  project: string;
  wakes: { customType: string; content: string }[];
  sampler: string[][];
  setLevel(level: "ok" | "high" | "critical", reasons?: string[]): void;
  trace(): Record<string, unknown>[];
  launch(id: string, input: Record<string, unknown>): Promise<{ block?: boolean; reason?: string } | undefined>;
  assistant(ids: string[], args: (i: number) => Record<string, unknown>): Promise<void>;
  /** A launch's tool_result: the run it started. */
  started(id: string, input: Record<string, unknown>, runId: string): Promise<void>;
  /** A run-end event. */
  ended(runId: string, summary?: string): void;
  clock: { now: number };
}

async function rig(t: { after(fn: () => void): void }, o: { strong?: boolean } = {}): Promise<Rig> {
  const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_FOREMAN_PRESSURE_FIXTURE"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-press-launch-")));
  let shutdown: (() => Promise<unknown>) | undefined;
  t.after(async () => {
    // t.after hooks run in registration order: shutdown, then quiescence, then removal, then env restore, all in this one hook.
    try { await shutdown?.(); } catch { /* best effort */ }
    await waitQuiet(path.join(root, "agent", "pi-foreman", "state"));
    rmTestTmp(root);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  const project = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(path.join(project, ".workflow"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_FOREMAN_PRESSURE_FIXTURE;
  const l2 = {
    providers: { fake: { roles: Object.fromEntries(ROLES.map((r) => [r, { model: `fake/${r}`, ...(o.strong && r === "builder" ? { strong: { model: "fake/senior-reviewer" } } : {}) }])) } },
    trace: { enabled: true },
    ceremony: { launchWait: "detach" },
  };
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify(l2));
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const wakes: { customType: string; content: string }[] = [];
  const channels = new Map<string, (d: unknown) => void>();
  const pi = {
    events: { on: (n: string, h: (d: unknown) => void) => void channels.set(n, h), emit: () => undefined },
    // every handler of an event runs, in registration order; the first result (a tool_call block) wins
    on: (n: string, h: Handler) => {
      const prev = handlers.get(n);
      handlers.set(n, prev ? async (e, c) => (await prev(e, c)) ?? (await h(e, c)) : h);
    },
    registerCommand: () => undefined,
    registerTool: (x: Tool) => void tools.set(x.name, x),
    getActiveTools: () => [] as string[],
    getAllTools: () => [{ name: "bash" }, { name: "subagent" }],
    setActiveTools: () => undefined,
    setModel: async () => true,
    setThinkingLevel: () => undefined,
    sendMessage: (m: { customType: string; content: string }) => void wakes.push(m),
  };
  const clock = { now: NOW };
  const sessionId = `press-session-${++rigs}`; // the child-extension registry is process-wide: one id per rig
  const sampler: string[][] = [];
  coreAdapter(pi as never, { pressureNow: () => clock.now, pressureRun: async (args) => (sampler.push(args), { ok: true, text: "" }) });
  const ctx = {
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
    cwd: project,
    model: { provider: "fake", id: "foreman" },
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: () => undefined, confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined },
  };
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  shutdown = async () => handlers.get("session_shutdown")?.({}, ctx);
  const file = pressurePath(agentDir);
  const r: Rig = {
    handlers,
    tools,
    ctx,
    agentDir,
    project,
    wakes,
    sampler,
    clock,
    setLevel(level, reasons = level === "ok" ? [] : ["load"]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ level, reasons, at: iso(clock.now), host: {} }));
    },
    trace() {
      const f = fs.readdirSync(path.join(agentDir, "pi-foreman", "state")).find((n) => n.startsWith("trace-") && n.endsWith(".jsonl"));
      return f ? fs.readFileSync(path.join(agentDir, "pi-foreman", "state", f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
    },
    launch: (id, input) => handlers.get("tool_call")!({ toolName: "subagent", toolCallId: id, input }, ctx) as never,
    async assistant(ids, args) {
      await handlers.get("message_end")!({ message: { role: "assistant", content: ids.map((id, i) => ({ type: "toolCall", id, name: "subagent", arguments: args(i) })) } }, ctx);
    },
    async started(id, input, runId) {
      await handlers.get("tool_result")!({ toolName: "subagent", toolCallId: id, input, details: { runId }, content: [{ type: "text", text: "started" }], isError: false }, ctx);
    },
    ended(runId, summary = "done") {
      channels.get("subagent:async-complete")!({ runId, agent: "builder", success: true, summary });
    },
  };
  return r;
}

const events = (a: Rig, name: string): Record<string, unknown>[] => a.trace().filter((r) => r.event === name);
const PRESSURE_EVENTS = ["launch_narrowed", "launch_deferred", "climb_suppressed"];
const explorer = (n: number) => ({ agent: "explorer", task: `look ${n}` });

test("ok: three launches of one message all pass, nothing is rewritten or traced, no wait starts", async (t) => {
  const a = await rig(t);
  a.setLevel("ok");
  const inputs = [explorer(1), explorer(2), explorer(3)];
  await a.assistant(["c1", "c2", "c3"], (i) => inputs[i]);
  const seen: unknown[] = [];
  for (const [i, id] of ["c1", "c2", "c3"].entries()) {
    seen.push(await a.launch(id, inputs[i]));
  }
  assert.deepEqual(seen, [undefined, undefined, undefined]);
  for (const e of PRESSURE_EVENTS) assert.deepEqual(events(a, e), [], e);
  assert.equal(a.wakes.length, 0);
});

test("a missing or stale pressure file behaves like ok", async (t) => {
  const a = await rig(t);
  await a.assistant(["c1", "c2"], (i) => explorer(i));
  assert.equal(await a.launch("c1", explorer(0)), undefined);
  assert.equal(await a.launch("c2", explorer(1)), undefined, "no file");
  a.setLevel("critical", ["mem"]);
  a.clock.now += 91_000;
  assert.equal(await a.launch("c3", explorer(2)), undefined, "a file older than 3x sampleSeconds");
  assert.deepEqual(events(a, "launch_deferred"), []);
});

test("the sampler runs at session start through the injected runner with the merged limits", async (t) => {
  const a = await rig(t);
  assert.ok(a.sampler.length >= 1);
  const args = a.sampler[0];
  assert.equal(args[0], "sample");
  assert.equal(args[args.indexOf("--state") + 1], pressurePath(a.agentDir));
  assert.deepEqual(JSON.parse(args[args.indexOf("--limits") + 1]), { maxLoadPerCore: 1.5, minFreeMemMB: 1024, minFreeDiskGB: 5 });
});

test("high: three launches in one message -> the first runs, two are queued; one launch_narrowed per message", async (t) => {
  const a = await rig(t);
  a.setLevel("high", ["load", "mem"]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const inputs = [explorer(1), explorer(2), explorer(3)];
  await a.assistant(["c1", "c2", "c3"], (i) => inputs[i]);
  assert.equal(await a.launch("c1", inputs[0]), undefined);
  const q2 = await a.launch("c2", inputs[1]);
  const q3 = await a.launch("c3", inputs[2]);
  for (const q of [q2, q3]) {
    assert.equal(q?.block, true);
    assert.match(q?.reason ?? "", /^pressure high \(load, mem\): child launches run one at a time; this launch is queued/);
  }
  assert.deepEqual(events(a, "launch_narrowed").map((r) => [r.width, r.reasons]), [[1, "load,mem"]]);
  assert.deepEqual(events(a, "launch_refused"), [], "a queued launch is no refusal");
  assert.equal(a.wakes.length, 0);

  // the first run is active: the queue waits; its end releases both queued launches in one wake, with their arguments
  await a.started("c1", inputs[0], "run-1");
  t.mock.timers.tick(60_000);
  assert.equal(a.wakes.length, 0, "a run is still active");
  a.ended("run-1");
  t.mock.timers.tick(30_000);
  assert.equal(a.wakes.length, 1);
  assert.equal(a.wakes[0].customType, "foreman_wake");
  assert.ok(a.wakes[0].content.includes(`pressure: high, a run ended; relaunch the queued launches one at a time with: ${JSON.stringify([explorer(2), explorer(3)])}`), a.wakes[0].content);

  // the next message is narrowed (and traced) on its own
  await a.assistant(["d1", "d2"], (i) => explorer(10 + i));
  assert.equal(await a.launch("d1", explorer(10)), undefined);
  assert.equal((await a.launch("d2", explorer(11)))?.block, true);
  assert.equal(events(a, "launch_narrowed").length, 2);
});

test("high: a single launch is not narrowed; a tasks call keeps its first task and queues the rest", async (t) => {
  const a = await rig(t);
  a.setLevel("high");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const one = explorer(1);
  await a.assistant(["c1"], () => one);
  assert.equal(await a.launch("c1", one), undefined);
  assert.deepEqual(events(a, "launch_narrowed"), []);

  const many = { tasks: [explorer(1), explorer(2), explorer(3)] };
  await a.assistant(["t1"], () => many);
  assert.equal(await a.launch("t1", many), undefined);
  assert.deepEqual(many.tasks.map((x) => x.task), ["look 1"]);
  assert.equal(events(a, "launch_narrowed").length, 1);
  t.mock.timers.tick(30_000);
  assert.equal(a.wakes.length, 1, "no run is active: the queue is released at the next check");
  assert.match(a.wakes[0].content, /relaunch the queued launches one at a time with: \{"tasks":\[\{"agent":"explorer","task":"look 2"\},\{"agent":"explorer","task":"look 3"\}\]/);
});

test("high: a RUNG_UP strong relaunch stays on the bottom rung and is traced climb_suppressed; ok climbs", async (t) => {
  for (const level of ["ok", "high"] as const) {
    const a = await rig(t, { strong: true });
    a.setLevel(level, level === "ok" ? [] : ["disk"]);
    const first = { agent: "builder", task: "[[small]] fix item 1" };
    await a.assistant(["b1"], () => first);
    assert.equal(await a.launch("b1", first), undefined, level);
    await a.started("b1", first, "run-b");
    a.ended("run-b", "RUNG_UP: context\nDone: half\nRemaining: tests");
    const relaunch: Record<string, unknown> = { agent: "builder", task: "continue item 1", model: "strong" };
    await a.assistant(["b2"], () => relaunch);
    assert.equal(await a.launch("b2", relaunch), undefined, level);
    if (level === "ok") {
      assert.equal(relaunch.model, "fake/senior-reviewer");
      assert.equal(events(a, "rung_up").length, 1);
      assert.deepEqual(events(a, "climb_suppressed"), []);
      assert.match(String(relaunch.task), /rung-up handoff/);
    } else {
      assert.equal(relaunch.model, "fake/builder", "bottom rung");
      assert.deepEqual(events(a, "rung_up"), []);
      assert.deepEqual(events(a, "climb_suppressed").map((r) => [r.level, r.reasons]), [["high", "disk"]]);
      assert.doesNotMatch(String(relaunch.task), /rung-up handoff/);
    }
  }
});

test("high: an explicit non-keyword model of the owner is not rewritten", async (t) => {
  const a = await rig(t, { strong: true });
  a.setLevel("high");
  const input: Record<string, unknown> = { agent: "explorer", task: "look", model: "fake/explorer" };
  await a.assistant(["e1"], () => input);
  assert.equal(await a.launch("e1", input), undefined);
  assert.equal(input.model, "fake/explorer");
  assert.deepEqual(events(a, "climb_suppressed"), []);
});

test("critical: the launch is refused with the deferral text, a wait wakes the foreman with the original arguments when the level drops", async (t) => {
  const a = await rig(t);
  a.setLevel("critical", ["mem", "disk"]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const input = { agent: "builder", task: "[[small]] implement item 3", reason: "keep me" };
  const original = JSON.parse(JSON.stringify(input));
  await a.assistant(["c1"], () => input);
  const d = await a.launch("c1", input);
  assert.deepEqual(d, { block: true, reason: "pressure critical (mem, disk): launch deferred; you will be woken when it drops" });
  assert.deepEqual(events(a, "launch_deferred").map((r) => [r.level, r.reasons]), [["critical", "mem,disk"]]);
  for (const e of ["launch_refused", "revision", "role_launch", "launch_narrowed"]) assert.deepEqual(events(a, e), [], `${e}: a deferred launch is none of these`);

  t.mock.timers.tick(90_000);
  assert.equal(a.wakes.length, 0, "still critical");
  a.setLevel("high", ["load"]);
  t.mock.timers.tick(30_000);
  assert.equal(a.wakes.length, 1);
  assert.equal(a.wakes[0].customType, "foreman_wake");
  assert.ok(a.wakes[0].content.includes(`pressure: high, relaunch with: ${JSON.stringify(original)}`), a.wakes[0].content);
  assert.equal(events(a, "role_launch").length, 0, "nothing launched by itself");

  // the foreman relaunches with those arguments: the deferral left no state behind
  a.setLevel("ok");
  const again = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
  await a.assistant(["c2"], () => again);
  assert.equal(await a.launch("c2", again), undefined);
  assert.deepEqual(events(a, "launch_refused"), []);
});

test("critical: after 600 s of critical pressure the wait wakes with 'still critical' and the arguments", async (t) => {
  const a = await rig(t);
  a.setLevel("critical", ["load"]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const input = { agent: "explorer", task: "look around" };
  await a.assistant(["c1"], () => input);
  assert.equal((await a.launch("c1", input))?.block, true);
  t.mock.timers.tick(570_000);
  assert.equal(a.wakes.length, 0);
  t.mock.timers.tick(30_000);
  assert.equal(a.wakes.length, 1);
  assert.ok(a.wakes[0].content.includes(`pressure: still critical, relaunch with: ${JSON.stringify({ agent: "explorer", task: "look around" })}`), a.wakes[0].content);
  t.mock.timers.tick(3_600_000);
  assert.equal(a.wakes.length, 1);
});

test("critical: a management call (status) is not a launch and is not deferred", async (t) => {
  const a = await rig(t);
  a.setLevel("critical");
  assert.equal(await a.launch("s1", { action: "status" }), undefined);
  assert.deepEqual(events(a, "launch_deferred"), []);
});

test("critical and high do not gate foreman_bg or bash", async (t) => {
  const a = await rig(t);
  for (const level of ["high", "critical"] as const) {
    a.setLevel(level);
    for (const toolName of ["foreman_bg", "bash"]) {
      const d = await a.handlers.get("tool_call")!({ toolName, toolCallId: `x-${level}-${toolName}`, input: { command: "echo hi" } }, a.ctx);
      assert.equal(d, undefined, `${toolName} under ${level}`);
    }
  }
  for (const e of PRESSURE_EVENTS) assert.deepEqual(events(a, e), [], e);
});
