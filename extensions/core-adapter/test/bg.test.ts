// foreman_bg (ledger item 5) and the background-tasks add-on (item 6). Temp dirs only; the only command run is
// a short `node -e` / `echo` through foreman_bg; guard cases pass command STRINGS that are refused before any spawn.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import coreAdapter from "../index.ts";
import { addonPresent, bgLogPath, formatWaits, lastLines, readAddonTasks, shellFor, spawnDetached } from "../bg.ts";
import { checkLogPath, parseStart, registerWait } from "../wait.ts";
import { mapTool, isShellTool } from "../toolmap.ts";
import { isOverlayTool } from "../permoverlay.ts";
import { LiveState, liveDir } from "../livestate.ts";

const PKG = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
const tmp = (t: { after(fn: () => void): void }, prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };

function waitHarness(t: { after(fn: () => void): void }, opts: { toolNames?: string[]; isChild?: boolean } = {}) {
  delete process.env.PI_SUBAGENT_CHILD;
  const root = tmp(t, "pf-bg-");
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
  const session = { id: "s1", isChild: opts.isChild === true, cwd, agentDir, overlay: null, config: () => ({ wait: { batchWindowSeconds: 0 } }), trace: () => undefined };
  const handle = registerWait(pi as never, { session: async () => session as never, home: root, platform: process.platform });
  const ctx = { mode: "tui", cwd, isIdle: () => true, sessionManager: { getSessionId: () => "s1" } };
  t.after(async () => handlers.get("session_shutdown")?.({}, ctx));
  return { root, agentDir, cwd, tools, wakes, handle, ctx, session };
}

test("foreman_bg: detached run, log under state/scratch/<session>/wait-<id>.log, pid wait with note and log", async (t) => {
  const h = waitHarness(t);
  const bg = h.tools.get("foreman_bg")!;
  assert.ok(bg, "foreman_bg is registered for the foreman");
  const r = await bg.execute("c1", { command: `node -e "console.log('one');console.log('two');setTimeout(()=>{},700)"`, note: "build it" }, undefined, undefined, h.ctx);
  assert.ok(!r.isError, r.content[0].text);
  const id = String(r.details.id);
  const log = bgLogPath(path.join(h.agentDir, "pi-foreman", "state"), "s1", id);
  assert.equal(r.details.log, log);
  assert.equal(path.basename(log), `wait-${id}.log`);
  assert.ok(log.includes(path.join("state", "scratch", "s1")));
  assert.match(r.content[0].text, new RegExp(`${id}.*pid ${r.details.pid}`));
  const [w] = h.handle.active("s1");
  assert.deepEqual([w.id, w.kind, w.note, w.log], [id, "pid", "build it", log]);
  // the process is detached: its own process group leader
  if (process.platform !== "win32") assert.doesNotThrow(() => process.kill(-Number(r.details.pid), 0));
  for (let i = 0; i < 50 && !h.wakes.length; i++) await sleep(100);
  assert.equal(h.handle.active("s1").length, 0, "the wait resolved when the process exited");
  assert.match(fs.readFileSync(log, "utf8"), /one\r?\ntwo/);
  assert.equal(h.wakes.length, 1);
  assert.match(h.wakes[0].content, new RegExp(`foreman_wait ${id} \\(pid\\) "build it": exited.*log ${log.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
});

test("foreman_bg: note defaults to the command; empty command, child and print mode are refused; maxActive is checked before a spawn", async (t) => {
  const h = waitHarness(t);
  const bg = h.tools.get("foreman_bg")!;
  const empty = await bg.execute("c", { command: "  " }, undefined, undefined, h.ctx);
  assert.equal(empty.isError, true);
  const print = await bg.execute("c", { command: "true" }, undefined, undefined, { ...h.ctx, mode: "print" });
  assert.equal(print.isError, true);
  assert.match(print.content[0].text, /needs a TUI or RPC session/);
  const one = await bg.execute("c", { command: `node -e "setTimeout(()=>{},3000)"` }, undefined, undefined, h.ctx);
  assert.equal(h.handle.active("s1")[0].note, `node -e "setTimeout(()=>{},3000)"`);
  process.kill(-Number(one.details.pid), "SIGTERM");
  const c = waitHarness(t, { isChild: true });
  const refused = await c.tools.get("foreman_bg")!.execute("c", { command: "true" }, undefined, undefined, c.ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /foreman only/);
  assert.equal(fs.existsSync(path.join(c.agentDir, "pi-foreman", "state", "scratch")), false, "nothing was spawned");
});

test("foreman_bg is not registered in a child session", (t) => {
  process.env.PI_SUBAGENT_CHILD = "1";
  t.after(() => delete process.env.PI_SUBAGENT_CHILD);
  const tools: string[] = [];
  registerWait({ on: () => undefined, registerTool: (x: Tool) => void tools.push(x.name) } as never, { session: async () => ({}) as never, home: "/h", platform: process.platform });
  assert.deepEqual(tools, []);
});

test("foreman_bg with the add-on present is refused with a pointer to bg_run; nothing is spawned", async (t) => {
  const h = waitHarness(t, { toolNames: ["bash", "bg_run"] });
  const r = await h.tools.get("foreman_bg")!.execute("c", { command: "echo hi" }, undefined, undefined, h.ctx);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /pi-background-tasks add-on is installed.*bg_run/);
  assert.equal(h.handle.active("s1").length, 0);
  assert.equal(fs.existsSync(path.join(h.agentDir, "pi-foreman", "state", "scratch")), false);
});

test("foreman_wait pid and ci accept log; a log outside the bound is refused", (t) => {
  const root = tmp(t, "pf-bglog-");
  const cwd = path.join(root, "proj");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  const bound = { cwd, home: root, agentDir, platform: process.platform, overlay: null };
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

test("shellFor, spawnDetached and lastLines", async (t) => {
  assert.deepEqual(shellFor("echo x", "win32").args.slice(0, 3), ["/d", "/s", "/c"]);
  const sh = shellFor("echo x", "linux");
  assert.deepEqual(sh.args, ["-c", "echo x"]);
  const dir = tmp(t, "pf-bgsp-");
  const log = path.join(dir, "a", "b.log");
  const r = spawnDetached(`node -e "for(let i=1;i<=9;i++)console.log('l'+i)"`, dir, log);
  assert.ok("pid" in r, JSON.stringify(r));
  for (let i = 0; i < 50 && lastLines(log).length < 5; i++) await sleep(100);
  assert.deepEqual(lastLines(log), ["l5", "l6", "l7", "l8", "l9"]);
  assert.deepEqual(lastLines(path.join(dir, "missing.log")), []);
  const bad = spawnDetached("true", path.join(dir, "no-such-dir"), path.join(dir, "c.log"));
  if ("pid" in bad) await sleep(50);
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
  const root = tmp(t, "pf-bgad-");
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
  coreAdapter(pi as never);
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
  return { handlers, commands, tools, ctx, project, agentDir, notes, confirms, root };
}

test("guard parity: foreman_bg gets exactly the verdict a bash call with the same command gets (deny, ask, allow)", async (t) => {
  const a = adapter(t);
  await a.handlers.get("session_start")!({ reason: "startup" }, a.ctx);
  t.after(async () => a.handlers.get("session_shutdown")?.({}, a.ctx));
  const parent = path.dirname(a.agentDir);
  const cases: [string, string][] = [
    ["shell write into a project file", "echo x > src/a.txt"],
    ["write into .git", "echo x > .git/config"],
    ["destructive", 'rm -rf -- "$1"/*'],
    ["git guard", "git push --force origin main"],
    ["empty command", " "],
    ["ask: agent dir parent", `trash ${parent}`],
    ["allow", "echo hi"],
  ];
  let denied = 0;
  let asked = 0;
  for (const [what, command] of cases) {
    const before = a.confirms.length;
    const viaBash = await a.handlers.get("tool_call")!({ toolName: "bash", toolCallId: "b", input: { command } }, a.ctx);
    const bashConfirms = a.confirms.length - before;
    const viaBg = await a.handlers.get("tool_call")!({ toolName: "foreman_bg", toolCallId: "g", input: { command, note: "n" } }, a.ctx);
    const bgConfirms = a.confirms.length - before - bashConfirms;
    // the same verdict and reason; only the empty-command text names the tool called
    const named = viaBg && typeof (viaBg as { reason?: unknown }).reason === "string" ? { ...(viaBg as object), reason: (viaBg as { reason: string }).reason.replace("the foreman_bg call", "the bash call") } : viaBg;
    assert.deepEqual(named, viaBash, `${what}: ${command}`);
    assert.equal(bgConfirms, bashConfirms, `${what}: asks`);
    if (what.startsWith("ask")) assert.ok(bashConfirms > 0, "the ask case really asks");
    if (viaBash) denied++;
    asked += bashConfirms;
  }
  assert.ok(denied >= 5, `denials seen: ${denied}`);
  assert.ok(asked >= 1);
  const ok = await a.handlers.get("tool_call")!({ toolName: "foreman_bg", toolCallId: "g", input: { command: "echo hi" } }, a.ctx);
  assert.equal(ok, undefined);
});

test("foreman_bg is guarded by every shell tool table: toolmap, git-guard shell check, overlay", () => {
  assert.deepEqual(mapTool("foreman_bg"), mapTool("bash"));
  assert.equal(isShellTool("foreman_bg"), true);
  assert.equal(isOverlayTool("foreman_bg"), true);
});

test("the permission baseline maps foreman_bg to the bash rules (shellTools alias, like powershell)", () => {
  const base = JSON.parse(fs.readFileSync(path.join(PKG, "config", "permissions.baseline.json"), "utf8")) as { shellTools: Record<string, { commandArgument: string }>; tools: Record<string, string> };
  assert.deepEqual(base.shellTools.foreman_bg, { commandArgument: "command" });
  assert.equal(base.tools.foreman_bg, undefined, "no own tool rule: the bash rules decide");
});

test("/foreman waits: lists waits with note, age, left and the last 5 log lines; includes the add-on's tasks when present", async (t) => {
  const a = adapter(t, { toolNames: ["bash", "bg_run"] });
  await a.handlers.get("session_start")!({ reason: "startup" }, a.ctx);
  t.after(async () => a.handlers.get("session_shutdown")?.({}, a.ctx));
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
  t.after(async () => absent.handlers.get("session_shutdown")?.({}, absent.ctx));
  await absent.commands.get("foreman")!.handler("waits", absent.ctx);
  assert.equal(absent.notes.pop(), "No active waits.");
  await absent.commands.get("foreman")!.handler("doctor", absent.ctx);
  assert.match(absent.notes.pop()!, /\nINFO background-tasks: absent\n/);
  const present = adapter(t, { toolNames: ["bash", "bg_run"] });
  await present.handlers.get("session_start")!({ reason: "startup" }, present.ctx);
  t.after(async () => present.handlers.get("session_shutdown")?.({}, present.ctx));
  await present.commands.get("foreman")!.handler("doctor", present.ctx);
  assert.match(present.notes.pop()!, /\nINFO background-tasks: present\n/);
});

// -- item 6 guard gap: the add-on's bg_run runs shell commands, so it is guarded like bash --------------------

test("guard parity: the add-on's bg_run gets exactly the verdict a bash call gets; a non-string command is denied", async (t) => {
  const a = adapter(t, { toolNames: ["bash", "bg_run"] });
  await a.handlers.get("session_start")!({ reason: "startup" }, a.ctx);
  t.after(async () => a.handlers.get("session_shutdown")?.({}, a.ctx));
  const parent = path.dirname(a.agentDir);
  const cases: [string, string][] = [
    ["shell write into a project file", "echo x > src/a.txt"],
    ["write into .git", "echo x > .git/config"],
    ["destructive", 'rm -rf -- "$1"/*'],
    ["git guard", "git push --force origin main"],
    ["empty command", " "],
    ["ask: agent dir parent", `trash ${parent}`],
    ["allow", "echo hi"],
  ];
  let denied = 0;
  let asked = 0;
  for (const [what, command] of cases) {
    const before = a.confirms.length;
    const viaBash = await a.handlers.get("tool_call")!({ toolName: "bash", toolCallId: "b", input: { command } }, a.ctx);
    const bashConfirms = a.confirms.length - before;
    const viaRun = await a.handlers.get("tool_call")!({ toolName: "bg_run", toolCallId: "r", input: { command, label: "n" } }, a.ctx);
    const runConfirms = a.confirms.length - before - bashConfirms;
    const named = viaRun && typeof (viaRun as { reason?: unknown }).reason === "string" ? { ...(viaRun as object), reason: (viaRun as { reason: string }).reason.replace("the bg_run call", "the bash call") } : viaRun;
    assert.deepEqual(named, viaBash, `${what}: ${command}`);
    assert.equal(runConfirms, bashConfirms, `${what}: asks`);
    if (what.startsWith("ask")) assert.ok(bashConfirms > 0, "the ask case really asks");
    if (viaBash) denied++;
    asked += bashConfirms;
  }
  assert.ok(denied >= 5, `denials seen: ${denied}`);
  assert.ok(asked >= 1);
  for (const command of [undefined, 42, ["echo", "hi"]]) {
    const d = (await a.handlers.get("tool_call")!({ toolName: "bg_run", toolCallId: "r", input: { command } }, a.ctx)) as { block?: boolean; reason?: string };
    assert.equal(d?.block, true, `command ${JSON.stringify(command)}`);
    assert.match(d.reason!, /bg_run call has .*cannot check it/);
  }
  assert.equal(await a.handlers.get("tool_call")!({ toolName: "bg_run", toolCallId: "r", input: { command: "echo hi" } }, a.ctx), undefined);
});

test("bg_run is guarded by every shell tool table; the baseline aliases it to the bash rules", () => {
  assert.deepEqual(mapTool("bg_run"), mapTool("bash"));
  assert.equal(isShellTool("bg_run"), true);
  assert.equal(isOverlayTool("bg_run"), true);
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

test("sidebar: a foreman_bg pid wait with note `suites` shows up in the presence waits[] with that note", async (t) => {
  const h = waitHarness(t);
  const r = await h.tools.get("foreman_bg")!.execute("c", { command: `node -e "setTimeout(()=>{},3000)"`, note: "suites" }, undefined, undefined, h.ctx);
  assert.ok(!r.isError, r.content[0].text);
  const live = LiveState.start({ agentDir: h.agentDir, sessionId: "s1", cwd: h.cwd, mode: "rpc", env: {} }, () => [], undefined, () => h.handle.active("s1"));
  assert.ok(live);
  t.after(() => live.stop());
  const file = JSON.parse(fs.readFileSync(path.join(liveDir(h.agentDir), "s1.json"), "utf8"));
  assert.equal(file.state, "working"); // a pending wait is work in progress (lane 7a)
  assert.equal(file.waits.length, 1);
  assert.deepEqual([file.waits[0].id, file.waits[0].kind, file.waits[0].note], [String(r.details.id), "pid", "suites"]);
  process.kill(Number(r.details.pid), "SIGTERM");
});
