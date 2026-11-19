// The background-tasks add-on beside the core adapter (readers, `/foreman waits`, doctor lines, guard parity of bg_run). Temp dirs only;
// guard cases pass command STRINGS that are refused before any spawn.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import coreAdapter from "../index.ts";
import { probeSpawner } from "./_probe-memo.ts";
import { mapTool, isShellTool } from "../toolmap.ts";
import { addonPresent, formatWaits, lastLines, readAddonTasks } from "../bg.ts";
import { checkLogPath, parseStart, registerWait } from "../wait.ts";
import { LiveState, liveDir } from "../livestate.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tmp = (t: { after(fn: () => void): void }, prefix: string, beforeRm?: (dir: string) => Promise<void>): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(async () => {
    await beforeRm?.(dir);
    rmTestTmp(dir);
  });
  return dir;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };

function waitHarness(t: { after(fn: () => void): void }, opts: { toolNames?: string[]; isChild?: boolean } = {}) {
  delete process.env.PI_SUBAGENT_CHILD;
  let shutdown: (() => Promise<unknown>) | undefined;
  const root = tmp(t, "pf-bg-", async (dir) => {
    try { await shutdown?.(); } catch { /* best effort */ }
    await waitQuiet(path.join(dir, "agent", "pi-foreman", "state"));
  });
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "proj");
  fs.mkdirSync(cwd, { recursive: true });
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Handler>();
  const wakes: { content: string }[] = [];
  const pi = {
    on: (n: string, h: Handler) => void handlers.set(n, h),
    registerTool: (tool: Tool) => void tools.set(tool.name, tool),
    sendMessage: (m: { content: string }) => void wakes.push(m),
    getAllTools: () => (opts.toolNames ?? []).map((name) => ({ name })),
  };
  const session = { id: "s1", isChild: opts.isChild === true, cwd, agentDir, roots: null, config: () => ({ wait: { batchWindowSeconds: 0 } }), trace: () => undefined };
  const handle = registerWait(pi as never, { session: async () => session as never, home: root, platform: process.platform });
  const ctx = { mode: "tui", cwd, isIdle: () => true, sessionManager: { getSessionId: () => "s1" } };
  shutdown = async () => handlers.get("session_shutdown")?.({}, ctx);
  return { root, agentDir, cwd, tools, wakes, handle, ctx, session };
}

test("foreman_bg is not registered: foreman_wait is the only tool registerWait adds", (t) => {
  const h = waitHarness(t);
  assert.deepEqual([...h.tools.keys()], ["foreman_wait"]);
});

test("registerWait registers no tool in a child session", (t) => {
  process.env.PI_SUBAGENT_CHILD = "1";
  t.after(() => delete process.env.PI_SUBAGENT_CHILD);
  const tools: string[] = [];
  registerWait({ on: () => undefined, registerTool: (x: Tool) => void tools.push(x.name) } as never, { session: async () => ({}) as never, home: "/h", platform: process.platform });
  assert.deepEqual(tools, []);
});

test("foreman_wait pid and ci accept log; a log outside the bound is refused", (t) => {
  const root = tmp(t, "pf-bglog-");
  const cwd = path.join(root, "proj");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  const bound = { cwd, home: root, agentDir, platform: process.platform, roots: null };
  const limits = { batchWindowSeconds: 0, maxSeconds: 3600, maxActive: 4, ci: true };
  const scratchLog = path.join(agentDir, "pi-foreman", "state", "scratch", "s1", "wait-w1.log");
  const pid = parseStart({ kind: "pid", pid: 4242, note: "n", log: scratchLog }, limits, bound);
  assert.deepEqual(pid, { kind: "pid", pid: 4242, note: "n", log: scratchLog });
  const ci = parseStart({ kind: "ci", runId: "123", log: scratchLog }, limits, bound);
  assert.deepEqual(ci, { kind: "ci", runId: "123", note: "", log: scratchLog });
  assert.deepEqual(parseStart({ kind: "pid", pid: 4242 }, limits, bound), { kind: "pid", pid: 4242, note: "" });
  const bad = parseStart({ kind: "pid", pid: 4242, log: path.join(os.tmpdir(), "elsewhere.log") }, limits, bound);
  assert.ok("error" in bad && /log on .*refused/.test(bad.error), JSON.stringify(bad));
  assert.deepEqual(checkLogPath("", bound), {});
});

test("a pid wait with a log lists it; the wake line names it", async (t) => {
  const h = waitHarness(t);
  const wait = h.tools.get("foreman_wait")!;
  const log = path.join(h.agentDir, "pi-foreman", "state", "scratch", "s1", "x.log");
  const r = await wait.execute("c", { action: "start", kind: "pid", pid: process.pid, note: "me", log }, undefined, undefined, h.ctx);
  assert.ok(!r.isError, r.content[0].text);
  assert.equal(h.handle.active("s1")[0].log, log);
});

test("lastLines: the last 5 non-empty lines of a log; a missing file gives none", (t) => {
  const dir = tmp(t, "pf-bgsp-");
  const log = path.join(dir, "b.log");
  fs.writeFileSync(log, `${Array.from({ length: 9 }, (_, i) => `l${i + 1}`).join("\n")}\n`);
  assert.deepEqual(lastLines(log), ["l5", "l6", "l7", "l8", "l9"]);
  assert.deepEqual(lastLines(path.join(dir, "missing.log")), []);
});

function fakeTasks(cwd: string): void {
  const dir = path.join(cwd, ".pi", "tasks", "sess-1-4321");
  fs.mkdirSync(dir, { recursive: true });
  const rec = (id: string, status: string, extra: Record<string, unknown> = {}) =>
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, command: `cmd-${id}`, status, pid: 99, startTime: Date.now() - 12_000, outputPath: path.join(".pi", "tasks", "sess-1-4321", `${id}.output`), ...extra }));
  rec("t1", "running", { name: "dev server" });
  rec("t2", "completed");
  rec("t3", "running", { outputPath: "../../../etc/hosts" });
  fs.writeFileSync(path.join(dir, "t1.output"), "a\nb\nc\nd\ne\nf\ng\n");
  fs.writeFileSync(path.join(dir, "broken.json"), "{not json");
}

test("readAddonTasks: running records of .pi/tasks with the last 5 output lines; foreign output paths are not read", (t) => {
  const cwd = tmp(t, "pf-bgtasks-");
  assert.deepEqual(readAddonTasks(cwd), [], "no .pi/tasks");
  fakeTasks(cwd);
  const tasks = readAddonTasks(cwd);
  assert.deepEqual(tasks.map((x) => x.id).sort(), ["t1", "t3"]);
  const t1 = tasks.find((x) => x.id === "t1")!;
  assert.deepEqual([t1.label, t1.pid, t1.tail], ["dev server", 99, ["c", "d", "e", "f", "g"]]);
  assert.ok(t1.ageSeconds >= 12);
  assert.deepEqual(tasks.find((x) => x.id === "t3")!.tail, []);
});

test("addonPresent: tool name or package directory; absent otherwise", (t) => {
  const root = tmp(t, "pf-bgpres-");
  const dirs = { agentDir: path.join(root, "agent"), cwd: path.join(root, "proj") };
  assert.equal(addonPresent(["bash", "foreman_wait"], dirs), false);
  assert.equal(addonPresent(["bg_run"], dirs), true);
  fs.mkdirSync(path.join(dirs.agentDir, "npm", "node_modules", "pi-background-tasks"), { recursive: true });
  assert.equal(addonPresent([], dirs), false, "a directory without package.json is not an install");
  fs.writeFileSync(path.join(dirs.agentDir, "npm", "node_modules", "pi-background-tasks", "package.json"), "{}");
  assert.equal(addonPresent([], dirs), true);
});

test("formatWaits: id, kind, note, age, left and the last 5 log lines; the add-on's tasks follow; empty text", () => {
  assert.equal(formatWaits([], []), "No active waits.");
  const text = formatWaits(
    [{ id: "w1", kind: "pid", note: "build", ageSeconds: 30, leftSeconds: 86370, log: "/l/wait-w1.log" }, { id: "w2", kind: "timer", note: "", ageSeconds: 1, leftSeconds: 59 }],
    [{ id: "t1", label: "dev server", pid: 99, ageSeconds: 12, tail: ["x", "y"] }],
    (f) => (f === "/l/wait-w1.log" ? ["1", "2", "3", "4", "5"] : []),
  );
  assert.equal(text.split("\n").length, 1 + 5 + 1 + 1 + 2);
  assert.match(text, /^w1 pid "build": 30s waited, times out in 86370s, log \/l\/wait-w1\.log\n  \| 1\n/);
  assert.match(text, /\nw2 timer: 1s waited, times out in 59s\n/);
  assert.match(text, /bg_run t1 "dev server": running 12s, pid 99\n  \| x\n  \| y$/);
});

// -- guard parity through the real adapter hooks -----------------------------------------------------------

function adapter(t: { after(fn: () => void): void }, opts: { confirm?: () => Promise<boolean>; toolNames?: string[] } = {}) {
  const keys = ["PATH", "Path", "PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "GIT_CONFIG_COUNT"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  let shutdown: (() => Promise<unknown>) | undefined;
  const root = tmp(t, "pf-bgad-", async (dir) => {
    try { await shutdown?.(); } catch { /* best effort */ }
    await waitQuiet(path.join(dir, "x", "agent", "pi-foreman", "state"));
  });
  const project = path.join(root, "project");
  const agentDir = path.join(root, "x", "agent");
  fs.mkdirSync(path.join(project, ".workflow"), { recursive: true });
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_SUBAGENT_CHILD;
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const tools = new Map<string, Tool>();
  const pi = {
    on: (n: string, h: Handler) => void handlers.set(n, h),
    registerCommand: (n: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => void commands.set(n, c),
    registerTool: (x: Tool) => void tools.set(x.name, x),
    getActiveTools: () => [] as string[],
    getAllTools: () => (opts.toolNames ?? ["bash"]).map((name) => ({ name })),
    setActiveTools: () => undefined,
    setModel: async () => true,
    setThinkingLevel: () => undefined,
    sendMessage: () => undefined,
  };
  coreAdapter(pi as never, { spawner: probeSpawner() });
  const notes: string[] = [];
  const confirms: string[] = [];
  const ctx = {
    sessionManager: { getSessionId: () => "bg-session-1", getSessionFile: () => undefined },
    cwd: project,
    model: undefined,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: (m: string) => void notes.push(m), confirm: async (title: string) => (confirms.push(title), opts.confirm ? opts.confirm() : false) },
  };
  shutdown = async () => handlers.get("session_shutdown")?.({}, ctx);
  return { handlers, commands, tools, ctx, project, agentDir, notes, confirms, root };
}

test("foreman_bg is gone: no shell-tool table, no permission baseline alias, no registered tool", () => {
  assert.deepEqual(mapTool("foreman_bg"), mapTool("unknown_tool"));
  assert.equal(isShellTool("foreman_bg"), false);
  const base = JSON.parse(fs.readFileSync(path.join(PKG, "config", "permissions.baseline.json"), "utf8")) as { shellTools: Record<string, unknown>; tools: Record<string, string> };
  assert.equal(base.shellTools.foreman_bg, undefined);
  assert.equal(base.tools.foreman_bg, undefined);
});

test("/foreman waits: lists waits with note, age, left and the last 5 log lines; includes the add-on's tasks when present", async (t) => {
  const a = adapter(t, { toolNames: ["bash", "bg_run"] });
  await a.handlers.get("session_start")!({ reason: "startup" }, a.ctx);
  const waits = a.commands.get("foreman")!;
  await waits.handler("waits", a.ctx);
  assert.equal(a.notes.pop(), "No active waits.");
  fakeTasks(a.project);
  await waits.handler("waits", a.ctx);
  assert.match(a.notes.pop()!, /bg_run t1 "dev server": running \d+s, pid 99\n  \| c\n  \| d\n  \| e\n  \| f\n  \| g/);
  // a foreman wait with a log
  const log = path.join(a.agentDir, "pi-foreman", "state", "scratch", "bg-session-1", "wait-w1.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, "1\n2\n3\n4\n5\n6\n7\n");
  const r = await a.tools.get("foreman_wait")!.execute("c", { action: "start", kind: "pid", pid: process.pid, note: "tests", log }, undefined, undefined, a.ctx);
  assert.ok(!r.isError, r.content[0].text);
  await waits.handler("waits", a.ctx);
  const text = a.notes.pop()!;
  assert.match(text, /^w1 pid "tests": \d+s waited, times out in \d+s, log .*wait-w1\.log\n  \| 3\n  \| 4\n  \| 5\n  \| 6\n  \| 7\n/);
  assert.ok(!text.includes("| 2"), "only the last 5 lines");
});

test("/foreman waits without the add-on ignores .pi/tasks; doctor prints INFO background-tasks present / absent", async (t) => {
  const absent = adapter(t, { toolNames: ["bash"] });
  fakeTasks(absent.project);
  await absent.handlers.get("session_start")!({ reason: "startup" }, absent.ctx);
  await absent.commands.get("foreman")!.handler("waits", absent.ctx);
  assert.equal(absent.notes.pop(), "No active waits.");
  await absent.commands.get("foreman")!.handler("doctor", absent.ctx);
  assert.match(absent.notes.pop()!, /\nINFO background-tasks: absent\n/);
  const present = adapter(t, { toolNames: ["bash", "bg_run"] });
  await present.handlers.get("session_start")!({ reason: "startup" }, present.ctx);
  await present.commands.get("foreman")!.handler("doctor", present.ctx);
  assert.match(present.notes.pop()!, /\nINFO background-tasks: present\n/);
});

test("doctor prints the recorded profile and the deviations line", async (t) => {
  const a = adapter(t);
  fs.writeFileSync(path.join(a.agentDir, "foreman.json"), `${JSON.stringify({ version: 1, profile: "standard", providers: {} })}\n`);
  await a.handlers.get("session_start")!({ reason: "startup" }, a.ctx);
  await a.commands.get("foreman")!.handler("doctor", a.ctx);
  assert.match(a.notes.pop()!, /\nINFO profile: standard\nINFO profile deviations: none\n?/);
});

// -- item 6 guard gap: the add-on's bg_run runs shell commands, so it is guarded like bash --------------------

test("guard parity: the add-on's bg_run gets exactly the verdict a bash call gets; a non-string command is denied", async (t) => {
  const a = adapter(t, { toolNames: ["bash", "bg_run"] });
  await a.handlers.get("session_start")!({ reason: "startup" }, a.ctx);
  const parent = path.dirname(a.agentDir);
  const cases: [string, string][] = [
    ["shell write into a project file", "echo x > src/a.txt"],
    ["write into .git", "echo x > .git/config"],
    ["destructive", 'rm -rf -- "$1"/*'],
    ["git guard", "git push --force origin main"],
    ["empty command", " "],
    ["floor: agent dir parent", `trash ${parent}`],
    ["agent dir parent via python", `python3 -c "import shutil; shutil.rmtree('${parent}')"`],
    ["allow", "echo hi"],
  ];
  let denied = 0;
  for (const [what, command] of cases) {
    const before = a.confirms.length;
    const viaBash = await a.handlers.get("tool_call")!({ toolName: "bash", toolCallId: "b", input: { command } }, a.ctx);
    const bashConfirms = a.confirms.length - before;
    const viaRun = await a.handlers.get("tool_call")!({ toolName: "bg_run", toolCallId: "r", input: { command, label: "n" } }, a.ctx);
    const runConfirms = a.confirms.length - before - bashConfirms;
    const named = viaRun && typeof (viaRun as { reason?: unknown }).reason === "string" ? { ...(viaRun as object), reason: (viaRun as { reason: string }).reason.replace("the bg_run call", "the bash call") } : viaRun;
    assert.deepEqual(named, viaBash, `${what}: ${command}`);
    assert.equal(runConfirms, bashConfirms, `${what}: asks`);
    if (viaBash) denied++;
  }
  assert.ok(denied >= 4, `denials seen: ${denied}`); // the python case is no denial now (HEAD: 5, when it was an overlay ask that the rig denied); only parity is checked on it
  for (const command of [undefined, 42, ["echo", "hi"]]) {
    const d = (await a.handlers.get("tool_call")!({ toolName: "bg_run", toolCallId: "r", input: { command } }, a.ctx)) as { block?: boolean; reason?: string };
    assert.equal(d?.block, true, `command ${JSON.stringify(command)}`);
    assert.match(d.reason!, /bg_run call has .*cannot read it/);
  }
  assert.equal(await a.handlers.get("tool_call")!({ toolName: "bg_run", toolCallId: "r", input: { command: "echo hi" } }, a.ctx), undefined);
});

test("bg_run is guarded by every shell tool table; the baseline aliases it to the bash rules", () => {
  assert.deepEqual(mapTool("bg_run"), mapTool("bash"));
  assert.equal(isShellTool("bg_run"), true);
  const base = JSON.parse(fs.readFileSync(path.join(PKG, "config", "permissions.baseline.json"), "utf8")) as { shellTools: Record<string, { commandArgument: string }>; tools: Record<string, string> };
  assert.deepEqual(base.shellTools.bg_run, { commandArgument: "command" });
  assert.equal(base.tools.bg_run, undefined);
});

test("foreman_wait tool: a log outside the bound or of the wrong type is rejected, no wait is registered", async (t) => {
  const h = waitHarness(t);
  const wait = h.tools.get("foreman_wait")!;
  for (const log of [path.join(os.tmpdir(), "elsewhere.log"), 42]) {
    const r = await wait.execute("c", { action: "start", kind: "pid", pid: process.pid, note: "x", log }, undefined, undefined, h.ctx);
    assert.equal(r.isError, true, JSON.stringify(log));
    assert.match(r.content[0].text, /foreman_wait:? log/);
  }
  assert.equal(h.handle.active("s1").length, 0);
});

test("sidebar: a foreman_wait pid wait with note `suites` shows up in the presence waits[] with that note", async (t) => {
  const h = waitHarness(t);
  const r = await h.tools.get("foreman_wait")!.execute("c", { action: "start", kind: "pid", pid: process.pid, note: "suites" }, undefined, undefined, h.ctx);
  assert.ok(!r.isError, r.content[0].text);
  const live = LiveState.start({ agentDir: h.agentDir, sessionId: "s1", cwd: h.cwd, mode: "rpc", env: {} }, () => [], undefined, () => h.handle.active("s1"));
  assert.ok(live);
  t.after(() => live.stop());
  const file = JSON.parse(fs.readFileSync(path.join(liveDir(h.agentDir), "s1.json"), "utf8"));
  assert.equal(file.state, "working"); // a pending wait is work in progress (lane 7a)
  assert.equal(file.waits.length, 1);
  assert.deepEqual([file.waits[0].id, file.waits[0].kind, file.waits[0].note], [String(r.details.id), "pid", "suites"]);
});
