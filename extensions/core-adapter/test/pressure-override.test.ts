// Owner-approved override of one deferred launch at critical load, through the real adapter hooks (index.ts tool_call, tool_execution_end, input).
// Rig of pressure-launch.test.ts with a recording owner dialog; pressure file injected, sampler and clock faked.
import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import * as os from "node:os";
import * as path from "node:path";
import coreAdapter from "../index.ts";
import { probeSpawner } from "./_probe-memo.ts";
import { dialogsJson } from "../dialogs.ts";
import { overrideHint, pressurePath, takePressureOverride } from "../pressure.ts";
import { strRaw } from "../strof.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Answer = string | undefined;

const NOW = Date.parse("2026-03-01T10:00:00Z");
let rigs = 0;
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const ROLES = ["explorer", "builder", "reviewer"];
const HOST = { loadPerCore: 4, load1PerCore: 3.5, freeMemMB: 16000, freeDiskGB: 500 };
const BASE = "pressure critical (load): launch deferred; you will be woken when it drops";
const FIELD = "pressureOverride";
// One session serves the tests of this file (each rig costs about seven child processes): a test starts with reset(), which gives it a new
// id and task salt, an empty trace view, no dialogs or wakes and the owner prompt that clears a recent decline.
let salt = 0;

interface Rig {
  handlers: Map<string, Handler>;
  ctx: Record<string, unknown>;
  wakes: { customType: string; content: string }[];
  dialogs: { title: string; options: string[] }[];
  answer: { next: () => Promise<Answer> };
  agentDir: string;
  traceFile(): string;
  setLevel(level: "ok" | "high" | "critical", reasons?: string[]): void;
  trace(): Record<string, unknown>[];
  reset(): Promise<void>;
  launch(id: string, input: Record<string, unknown>): Promise<{ block?: boolean; reason?: string } | undefined>;
  assistant(ids: string[], args: (i: number) => Record<string, unknown>): Promise<void>;
  started(id: string, input: Record<string, unknown>, runId: string): Promise<void>;
  end(id: string, isError: boolean): Promise<void>;
  ended(runId: string): void;
  typed(source: string): Promise<void>;
  project: string;
}

async function makeRig(t: { after(fn: () => unknown): void }, o: { mode?: string; hasUI?: boolean; child?: boolean } = {}): Promise<Rig> {
  const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_FOREMAN_PRESSURE_FIXTURE"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-press-ovr-")));
  let shutdown: (() => Promise<unknown>) | undefined;
  t.after(async () => {
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
  delete process.env.PI_FOREMAN_PRESSURE_FIXTURE;
  if (o.child) process.env.PI_SUBAGENT_CHILD = "1";
  else delete process.env.PI_SUBAGENT_CHILD;
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({
    providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(ROLES.map((r) => [r, { model: `fake/${r}` }])) } },
    trace: { enabled: true },
    ceremony: { launchWait: "detach" },
    presence: { enabled: false },
  }));
  fs.mkdirSync(path.join(agentDir, "pi-foreman"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "pi-foreman", "permissions.json"), JSON.stringify({ allow: ["subagent"] }));
  const handlers = new Map<string, Handler>();
  const every = new Map<string, Handler[]>(); // each handler on its own: the chain above stops at the first result
  const wakes: { customType: string; content: string }[] = [];
  const channels = new Map<string, (d: unknown) => void>();
  const pi = {
    events: { on: (n: string, h: (d: unknown) => void) => void channels.set(n, h), emit: () => undefined },
    on: (n: string, h: Handler) => {
      every.set(n, [...(every.get(n) ?? []), h]);
      const prev = handlers.get(n);
      handlers.set(n, prev ? async (e, c) => (await prev(e, c)) ?? (await h(e, c)) : h);
    },
    registerCommand: () => undefined,
    registerTool: () => undefined,
    getActiveTools: () => [] as string[],
    getAllTools: () => [{ name: "bash" }, { name: "subagent" }],
    setActiveTools: () => undefined,
    setModel: async () => true,
    setThinkingLevel: () => undefined,
    sendMessage: (m: { customType: string; content: string }) => void wakes.push(m),
  };
  const clock = { now: NOW };
  const sessionId = `press-ovr-session-${++rigs}`;
  coreAdapter(pi as never, { pressureNow: () => clock.now, pressureRun: async () => ({ ok: true, text: "" }), spawner: probeSpawner() });
  const dialogs: { title: string; options: string[] }[] = [];
  const answer = { next: async (): Promise<Answer> => "Yes" };
  const ctx: Record<string, unknown> = {
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
    cwd: project,
    model: { provider: "fake", id: "foreman" },
    mode: o.mode ?? "tui",
    hasUI: o.hasUI ?? true,
    signal: undefined,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
    ui: {
      notify: () => undefined,
      confirm: async () => false,
      select: async (title: string, options: string[]) => {
        dialogs.push({ title, options });
        return answer.next();
      },
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
  };
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  shutdown = async () => handlers.get("session_shutdown")?.({}, ctx);
  const file = pressurePath(agentDir);
  let skip = 0;
  const key = (id: string): string => `${salt}:${id}`;
  const traceFile = (): string => {
    const dir = path.join(agentDir, "pi-foreman", "state");
    const f = fs.readdirSync(dir).find((n) => n.startsWith("trace-") && n.endsWith(".jsonl"));
    return f ? path.join(dir, f) : path.join(dir, "none.jsonl");
  };
  return {
    handlers,
    ctx,
    wakes,
    dialogs,
    answer,
    agentDir,
    project,
    traceFile,
    setLevel(level, reasons = level === "ok" ? [] : ["load"]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ level, reasons, at: iso(clock.now), host: HOST }));
    },
    trace() {
      try {
        return fs.readFileSync(traceFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).slice(skip);
      } catch {
        return [];
      }
    },
    async reset(this: Rig) {
      salt += 1;
      skip = 0;
      skip = this.trace().length;
      wakes.length = 0;
      dialogs.length = 0;
      answer.next = async () => "Yes";
      ctx.signal = undefined;
      ctx.hasUI = true;
      ctx.mode = "tui";
      this.setLevel("ok");
      for (const h of every.get("input") ?? []) await h({ source: "interactive", text: "go on" }, ctx);
    },
    launch: (id, input) => handlers.get("tool_call")!({ toolName: "subagent", toolCallId: key(id), input }, ctx) as never,
    async assistant(ids, args) {
      await handlers.get("message_end")!({ message: { role: "assistant", content: ids.map((id, i) => ({ type: "toolCall", id: key(id), name: "subagent", arguments: args(i) })) } }, ctx);
    },
    async started(id, input, runId) {
      await handlers.get("tool_result")!({ toolName: "subagent", toolCallId: key(id), input, details: { runId }, content: [{ type: "text", text: "started" }], isError: false }, ctx);
    },
    async end(id, isError) {
      await handlers.get("tool_execution_end")!({ toolName: "subagent", toolCallId: key(id), result: {}, isError }, ctx);
    },
    ended(runId) {
      channels.get("subagent:async-complete")!({ runId, agent: "builder", success: true, summary: "done" });
    },
    async typed(source) {
      for (const h of every.get("input") ?? []) await h({ source, text: "go on" }, ctx);
    },
  };
}

let shared: Promise<Rig> | undefined;
const cleanups: (() => unknown)[] = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});
async function rig(t: TestContext, o: { mode?: string; hasUI?: boolean; child?: boolean } = {}): Promise<Rig> {
  if (o.child) return makeRig(t, o);
  shared ??= makeRig({ after: (fn) => void cleanups.push(fn) });
  const a = await shared;
  await a.reset();
  // every test runs on mocked timers (a wait's timer must not outlive its test); the tests' own enable call is then a no-op
  t.mock.timers.enable(TIMERS);
  t.mock.timers.enable = () => undefined;
  // the test's open waits end here, so they do not count against wait.maxActive in the next test
  t.after(() => {
    a.setLevel("ok");
    try { t.mock.timers.tick(700_000); } catch { /* timers were not mocked */ }
  });
  if (o.mode !== undefined) a.ctx.mode = o.mode;
  if (o.hasUI !== undefined) a.ctx.hasUI = o.hasUI;
  return a;
}

const events = (a: Rig, name: string): Record<string, unknown>[] => a.trace().filter((r) => r.event === name);
const ov = (a: Rig): string[] => events(a, "pressure_override").map((r) => `${strRaw(r.decision)}${r.reason ? `:${strRaw(r.reason)}` : ""}`);
const waitStarts = (a: Rig): number => events(a, "wait").filter((r) => r.decision === "start").length;
const worker = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ agent: "builder", task: `look ${salt}-${n}`, ...extra });
const TIMERS = { apis: ["setTimeout" as const] };

test("Yes: the launch passes without the field, one approval traced, no wait, pi-subagents never sees the field", async (t) => {
  const a = await rig(t);
  a.setLevel("critical", ["load"]);
  t.mock.timers.enable(TIMERS);
  const input = worker(1, { [FIELD]: "the build is blocked" });
  await a.assistant(["c1"], () => input);
  assert.equal(await a.launch("c1", input), undefined);
  assert.equal(FIELD in input, false);
  assert.deepEqual(a.dialogs.map((d) => d.options), [["Yes", "No"]]);
  assert.deepEqual(ov(a), ["approved"]);
  assert.deepEqual(events(a, "launch_deferred"), []);
  assert.equal(waitStarts(a), 0);
  assert.deepEqual(events(a, "dialog").map((r) => r.surface), ["pressure_override"]);
});

test("the dialog shows agent, task head, reason (cut) and both load values with the limit", async (t) => {
  const a = await rig(t);
  a.setLevel("critical", ["load"]);
  const task = `first   line ${"x".repeat(400)}\nsecond line`;
  const long = `why ${"y".repeat(400)}`;
  const input = { agent: "builder", task, [FIELD]: long };
  await a.assistant(["c1"], () => input);
  await a.launch("c1", input);
  const title = a.dialogs[0].title;
  assert.match(title, /Start this launch despite high load\?/);
  assert.match(title, /Yes starts this one launch now; No keeps it waiting/);
  assert.match(title, /Agent:\s+builder/);
  assert.match(title, /Task:\s+first line xxx/);
  assert.ok(!title.includes("x".repeat(300)), "the task is cut");
  assert.ok(!title.includes("second line"), "the task head is the first line");
  assert.match(title, /Task:[^\n]*…/);
  assert.match(title, /Reason:\s+why y+…/);
  assert.ok(!title.includes("y".repeat(300)), "the reason is cut");
  assert.match(title, /1 min 3\.50\/core, 5 min 4\/core, limit 1\.50\/core/);
  assert.match(title, /Yes: this one launch starts now {3}No: it waits until the load drops/);
});

test("No: deferred, the wait starts, declined is traced and the refusal names the decline", async (t) => {
  const a = await rig(t);
  a.setLevel("critical", ["load"]);
  t.mock.timers.enable(TIMERS);
  a.answer.next = async () => "No";
  const input = worker(1, { [FIELD]: "urgent" });
  await a.assistant(["c1"], () => input);
  const d = await a.launch("c1", input);
  assert.equal(d?.block, true);
  assert.equal(d?.reason, `${BASE} (the owner did not approve this launch; do not ask again unless the owner says so)`);
  assert.deepEqual(ov(a), ["declined"]);
  assert.equal(waitStarts(a), 1);
  assert.equal(events(a, "launch_deferred").length, 1);
});

for (const [name, setup] of [["undefined", async () => undefined], ["a thrown dialog", async (): Promise<Answer> => { throw new Error("gone"); }]] as const) {
  test(`${name}: deferred and traced dismissed, not declined`, async (t) => {
    const a = await rig(t);
    a.setLevel("critical", ["load"]);
    t.mock.timers.enable(TIMERS);
    a.answer.next = setup;
    const input = worker(1, { [FIELD]: "urgent" });
    await a.assistant(["c1"], () => input);
    const d = await a.launch("c1", input);
    assert.equal(d?.block, true);
    assert.match(d?.reason ?? "", /the owner did not approve this launch/);
    assert.deepEqual(ov(a), ["dismissed"]);
    assert.equal(waitStarts(a), 1);
  });
}

test("an aborted call: dismissed, no wait is started", async (t) => {
  const a = await rig(t);
  a.setLevel("critical", ["load"]);
  t.mock.timers.enable(TIMERS);
  const ac = new AbortController();
  a.ctx.signal = ac.signal;
  a.answer.next = async () => (ac.abort(), undefined);
  const input = worker(1, { [FIELD]: "urgent" });
  await a.assistant(["c1"], () => input);
  assert.equal((await a.launch("c1", input))?.block, true);
  assert.deepEqual(ov(a), ["dismissed"]);
  assert.equal(waitStarts(a), 0);
});

for (const [name, mode, hasUI] of [["no UI", "tui", false], ["print mode", "print", true]] as const) {
  test(`${name}: no dialog, unavailable/no_ui and its text`, async (t) => {
    const a = await rig(t, { mode, hasUI });
    a.setLevel("critical", ["load"]);
    t.mock.timers.enable(TIMERS);
    const input = worker(1, { [FIELD]: "urgent" });
    await a.assistant(["c1"], () => input);
    const d = await a.launch("c1", input);
    assert.equal(d?.reason, `${BASE} (${FIELD}: no owner can answer at this pane, so no approval is possible; wait)`);
    assert.deepEqual(a.dialogs, []);
    assert.deepEqual(ov(a), ["unavailable:no_ui"]);
    assert.equal(waitStarts(a), 1);
  });
}

for (const reasons of [["mem"], ["disk"], ["load", "mem"]]) {
  test(`reasons ${reasons.join(",")}: no dialog, unavailable/cause`, async (t) => {
    const a = await rig(t);
    a.setLevel("critical", reasons);
    const input = worker(1, { [FIELD]: "urgent" });
    await a.assistant(["c1"], () => input);
    const d = await a.launch("c1", input);
    assert.equal(d?.reason, `pressure critical (${reasons.join(", ")}): launch deferred; you will be woken when it drops (${FIELD}: the cause is memory or disk; an approval cannot help there; wait)`);
    assert.deepEqual(a.dialogs, []);
    assert.deepEqual(ov(a), ["unavailable:cause"]);
  });
}

/** A launch that ran at ok, so run-1 is a run of this session and a resume of it reaches the pressure gate. */
async function ranOnce(a: Rig): Promise<void> {
  a.setLevel("ok");
  const first = worker(0);
  await a.assistant(["r0"], () => first);
  assert.equal(await a.launch("r0", first), undefined);
  await a.started("r0", first, "run-1");
}

const SHAPE = `${BASE} (${FIELD}: only a new launch of one agent can be approved: launch the urgent one alone with pressureOverride, or wait (a resume cannot be approved))`;
for (const [name, input] of [
  ["tasks", { tasks: [worker(1), worker(2)], [FIELD]: "urgent" }],
  ["chain", { chain: [worker(1), worker(2)], [FIELD]: "urgent" }],
  ["a field only inside a tasks entry", { tasks: [worker(1, { [FIELD]: "urgent" }), worker(2)] }],
  ["a resume", { action: "resume", id: "run-1", message: "go", [FIELD]: "urgent" }],
] as const) {
  test(`shape: ${name}: no dialog, unavailable/shape`, async (t) => {
    const a = await rig(t);
    if (name === "a resume") await ranOnce(a);
    a.setLevel("critical", ["load"]);
    const call = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    await a.assistant(["c1"], () => call);
    const d = await a.launch("c1", call);
    assert.equal(d?.reason, SHAPE);
    assert.deepEqual(a.dialogs, []);
    assert.deepEqual(ov(a), ["unavailable:shape"]);
  });
}

test("one approval is one launch: the same arguments with the field open a new dialog; a different launch has its own, a No there defers it", async (t) => {
  const a = await rig(t);
  a.setLevel("critical", ["load"]);
  t.mock.timers.enable(TIMERS);
  const mk = (n: number): Record<string, unknown> => worker(n, { [FIELD]: "urgent" });
  await a.assistant(["c1", "c2", "c3"], () => mk(1));
  assert.equal(await a.launch("c1", mk(1)), undefined);
  assert.equal(await a.launch("c2", mk(1)), undefined);
  assert.equal(a.dialogs.length, 2, "no approval carried over");
  assert.equal(await a.launch("c3", mk(2)), undefined);
  assert.equal(a.dialogs.length, 3);
  a.answer.next = async () => "No";
  assert.equal((await a.launch("c4", mk(3)))?.block, true);
  assert.equal(a.dialogs.length, 4);
  assert.equal((await a.launch("c5", worker(3)))?.block, true, "without the field it stays deferred");
  assert.deepEqual(ov(a), ["approved", "approved", "approved", "declined"]);
});

test("after a No a request is declined_recently without a dialog; an extension input does not clear it, an interactive one does", async (t) => {
  const a = await rig(t);
  a.setLevel("critical", ["load"]);
  t.mock.timers.enable(TIMERS);
  a.answer.next = async () => "No";
  const mk = (): Record<string, unknown> => worker(1, { [FIELD]: "urgent" });
  await a.assistant(["c1"], mk);
  await a.launch("c1", mk());
  const d = await a.launch("c2", mk());
  assert.equal(d?.reason, `${BASE} (${FIELD}: the owner declined or dismissed an approval; do not ask again until the owner writes)`);
  assert.equal(a.dialogs.length, 1);
  await a.typed("extension");
  await a.launch("c3", mk());
  assert.equal(a.dialogs.length, 1, "an extension message is no owner prompt");
  await a.typed("interactive");
  a.answer.next = async () => "Yes";
  assert.equal(await a.launch("c4", mk()), undefined);
  assert.equal(a.dialogs.length, 2);
  assert.deepEqual(ov(a), ["declined", "unavailable:declined_recently", "unavailable:declined_recently", "approved"]);
});

test("the field at ok and high is removed, opens no dialog and is traced not_needed; high still narrows; an explorer at critical passes", async (t) => {
  const a = await rig(t);
  t.mock.timers.enable(TIMERS);
  a.setLevel("ok");
  const one = worker(1, { [FIELD]: "urgent" });
  await a.assistant(["c1"], () => one);
  assert.equal(await a.launch("c1", one), undefined);
  assert.equal(FIELD in one, false);
  a.setLevel("high", ["load"]);
  const inputs = [worker(2, { [FIELD]: "urgent" }), worker(3, { [FIELD]: "urgent" })];
  await a.assistant(["d1", "d2"], (i) => inputs[i]);
  assert.equal(await a.launch("d1", inputs[0]), undefined);
  assert.match((await a.launch("d2", inputs[1]))?.reason ?? "", /^pressure high \(load\): child launches run one at a time/);
  a.setLevel("critical", ["load"]);
  const ex = { agent: "explorer", task: "look", [FIELD]: "urgent" };
  await a.assistant(["e1"], () => ex);
  assert.equal(await a.launch("e1", ex), undefined);
  assert.equal(FIELD in ex, false);
  assert.deepEqual(a.dialogs, []);
  assert.deepEqual(events(a, "pressure_override").map((r) => [r.decision, r.reason]), [["not_needed", "level"], ["not_needed", "level"], ["not_needed", "level"], ["not_needed", "explorer"]]);
  assert.equal(events(a, "launch_narrowed").length, 1);
});

test("refusal text without the field: first sentence unchanged, hint by availability", async (t) => {
  const a = await rig(t);
  await ranOnce(a);
  t.mock.timers.enable(TIMERS);
  const text = async (id: string, input: Record<string, unknown>): Promise<string> => {
    await a.assistant([id], () => input);
    return (await a.launch(id, input))?.reason ?? "";
  };
  a.setLevel("critical", ["load"]);
  const available = `${BASE}. ${overrideHint("ok", "single")}`;
  assert.equal(available, `${BASE}. If this launch cannot wait, relaunch it with the top-level key pressureOverride: "<why it cannot wait>"; the owner approves or declines it in a dialog. Do not retry it unchanged.`);
  assert.equal(await text("c1", worker(1)), available);
  assert.equal(await text("c2", { tasks: [worker(1), worker(2)] }), `${BASE}. If one of these launches cannot wait, launch it alone with pressureOverride: "<why>"; the owner approves or declines it in a dialog.`);
  assert.equal(await text("c3", { action: "resume", id: "run-1", message: "go" }), `${BASE}. A resume cannot get an owner approval; wait.`);
  a.setLevel("critical", ["disk"]);
  assert.equal(await text("c4", worker(2)), "pressure critical (disk): launch deferred; you will be woken when it drops. The cause is memory or disk; an owner approval cannot help; wait.");
});

test("the refusal without a UI says no owner can approve", async (t) => {
  const a = await rig(t, { hasUI: false });
  a.setLevel("critical", ["load"]);
  t.mock.timers.enable(TIMERS);
  await a.assistant(["c1"], () => worker(1));
  assert.equal((await a.launch("c1", worker(1)))?.reason, `${BASE}. No owner can approve it at this pane; wait.`);
});

test("the relaunch JSON of the wait and of the high queue never carries the field", async (t) => {
  const a = await rig(t);
  t.mock.timers.enable(TIMERS);
  a.setLevel("critical", ["load"]);
  a.answer.next = async () => "No";
  const top = { agent: "builder", task: "t1", [FIELD]: "urgent" };
  const boxed = { agent: "builder", task: "t2", options: { [FIELD]: "urgent", keep: 1 } };
  await a.assistant(["c1", "c2"], (i) => [top, boxed][i]);
  await a.launch("c1", top);
  await a.typed("interactive");
  await a.launch("c2", boxed);
  a.setLevel("ok");
  t.mock.timers.tick(30_000);
  assert.equal(a.wakes.length, 1);
  const wake = a.wakes[0].content;
  assert.ok(wake.includes(JSON.stringify({ agent: "builder", task: "t1" })), wake);
  assert.ok(wake.includes(JSON.stringify({ agent: "builder", task: "t2", options: { keep: 1 } })), wake);
  assert.ok(!wake.includes(FIELD), wake);

  const b = await makeRig(t);
  b.setLevel("high", ["load"]);
  const first = worker(1);
  const second = { agent: "builder", task: "second", [FIELD]: "urgent" };
  await b.assistant(["h1", "h2"], (i) => [first, second][i]);
  assert.equal(await b.launch("h1", first), undefined);
  assert.equal((await b.launch("h2", second))?.block, true);
  await b.started("h1", first, "run-1");
  b.ended("run-1");
  t.mock.timers.tick(30_000);
  const queued = b.wakes.at(-1)?.content ?? "";
  assert.ok(queued.includes(JSON.stringify([{ agent: "builder", task: "second" }])) || queued.includes(JSON.stringify({ agent: "builder", task: "second" })), queued);
  assert.ok(!queued.includes(FIELD), queued);
});

test("consumption: Yes and the launch ran is one launched; Yes and a failed launch is one not_launched", async (t) => {
  const a = await rig(t);
  a.setLevel("critical", ["load"]);
  t.mock.timers.enable(TIMERS);
  const ok = worker(1, { [FIELD]: "urgent" });
  await a.assistant(["c1"], () => ok);
  assert.equal(await a.launch("c1", ok), undefined);
  await a.end("c1", false);
  assert.deepEqual(ov(a), ["approved", "launched"]);
  const bad = worker(2, { [FIELD]: "urgent" });
  await a.assistant(["c2"], () => bad);
  assert.equal(await a.launch("c2", bad), undefined);
  await a.end("c2", true);
  await a.end("c2", true);
  assert.deepEqual(ov(a), ["approved", "launched", "approved", "not_launched"]);
});

test("wait dedupe: Yes and launched cancels the open wait, Yes and not_launched keeps it, No starts no second wait, an aborted call starts none", async (t) => {
  const a = await rig(t);
  a.setLevel("critical", ["load"]);
  t.mock.timers.enable(TIMERS);
  const plain = worker(1);
  const asked = (): Record<string, unknown> => worker(1, { [FIELD]: "urgent" });
  await a.assistant(["c1"], () => plain);
  assert.equal((await a.launch("c1", plain))?.block, true);
  assert.equal(waitStarts(a), 1);
  // Yes + not launched: the wait stays
  await a.launch("c2", asked());
  await a.end("c2", true);
  // No: no second wait
  a.answer.next = async () => "No";
  await a.launch("c3", asked());
  assert.equal(waitStarts(a), 1);
  await a.typed("interactive");
  // an aborted call: still none
  const ac = new AbortController();
  a.ctx.signal = ac.signal;
  a.answer.next = async () => (ac.abort(), undefined);
  await a.launch("c4", asked());
  assert.equal(waitStarts(a), 1);
  a.ctx.signal = undefined;
  // Yes + launched: the wait is cancelled, no wake follows
  await a.typed("interactive");
  a.answer.next = async () => "Yes";
  assert.equal(await a.launch("c5", asked()), undefined);
  await a.end("c5", false);
  assert.equal(events(a, "wait").filter((r) => r.decision === "cancelled").length, 1);
  a.setLevel("ok");
  t.mock.timers.tick(700_000);
  assert.deepEqual(a.wakes, []);
});

test("a subagent child: the field is removed, no dialog, the launch passes, not_needed/child is traced", async (t) => {
  const a = await rig(t, { child: true });
  a.setLevel("critical", ["load"]);
  const input = worker(1, { [FIELD]: "urgent" });
  await a.assistant(["c1"], () => input);
  assert.equal(await a.launch("c1", input), undefined);
  assert.equal(FIELD in input, false);
  assert.deepEqual(a.dialogs, []);
  assert.deepEqual(ov(a), ["not_needed:child"]);
});

test("the trace never holds the task or the reason text", async (t) => {
  const a = await rig(t);
  a.setLevel("critical", ["load"]);
  t.mock.timers.enable(TIMERS);
  const mk = (): Record<string, unknown> => ({ agent: "builder", task: "SECRET-TASK-TEXT build it", [FIELD]: "SECRET-REASON-TEXT now" });
  await a.assistant(["c1"], mk);
  await a.launch("c1", mk());
  a.answer.next = async () => "No";
  await a.launch("c2", mk());
  await a.end("c1", false);
  const raw = fs.readFileSync(a.traceFile(), "utf8");
  assert.ok(!raw.includes("SECRET-TASK-TEXT") && !raw.includes("SECRET-REASON-TEXT"));
  assert.match(String(events(a, "pressure_override")[0].hash), /^[0-9a-f]{16}$/);
});

test("/foreman dialogs lists a pressure_override dialog record", async (t) => {
  const a = await makeRig(t); // dialogsJson reads the whole trace file, so this one has its own
  a.setLevel("critical", ["load"]);
  const input = worker(1, { [FIELD]: "urgent" });
  await a.assistant(["c1"], () => input);
  await a.launch("c1", input);
  const rep = JSON.parse(dialogsJson({ file: a.traceFile() })) as Record<string, { count: number; lines: string[] }>;
  assert.equal(rep.checkpoint.count, 1);
  assert.deepEqual(rep.checkpoint.lines, ["pressure_override"]);
});

test("takePressureOverride: top level, options and args boxes, entries; a non-string or empty value is absent", () => {
  const top: Record<string, unknown> = { agent: "builder", task: "t", [FIELD]: "why" };
  assert.deepEqual(takePressureOverride(top), { text: "why", nested: false });
  assert.deepEqual(top, { agent: "builder", task: "t" });
  const boxed: Record<string, unknown> = { agent: "builder", task: "t", args: { [FIELD]: "why" }, options: { [FIELD]: "again", keep: 1 } };
  assert.deepEqual(takePressureOverride(boxed), { text: "again", nested: false }, "options is read before args");
  assert.deepEqual(boxed, { agent: "builder", task: "t", options: { keep: 1 } });
  const group: Record<string, unknown> = { tasks: [{ agent: "builder", task: "t", [FIELD]: "inner" }] };
  assert.deepEqual(takePressureOverride(group), { text: "inner", nested: true });
  assert.deepEqual(group, { tasks: [{ agent: "builder", task: "t" }] });
  for (const v of [5, "", "  ", null, true]) {
    const c: Record<string, unknown> = { agent: "builder", task: "t", [FIELD]: v };
    assert.deepEqual(takePressureOverride(c), { nested: false });
    assert.equal(FIELD in c, false);
  }
});
