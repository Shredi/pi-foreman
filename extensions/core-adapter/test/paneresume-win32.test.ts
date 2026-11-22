// Crash restart on Windows (D1-D5, D13): the platform is a parameter or an injected seam everywhere, so every case here runs on every OS and on the Windows
// runner. Nothing starts a real Pi, powershell or hc.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { isGitBashLauncherChild, piCommand, resolvePi, runPaneResume } from "../paneresume-cli.ts";
import type { PaneResumeDeps, PiChild, ProcInfo } from "../paneresume-cli.ts";
import { buildSpawnEnv, notePath, readLiveStartedMs, readNoteRaw, validateNote, writeNote } from "../paneresume-core.ts";
import type { PaneNote } from "../paneresume-core.ts";
import { shimScript } from "../pi-shim.mjs";
import { captureIdentity } from "../identity.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

type Mod = typeof import("../paneresume.ts");
const SID = "11111111-2222-3333-4444-555555555555";
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let importN = 0;
const fresh = (): Promise<Mod> => import(`../paneresume.ts?v=win32-${++importN}`) as Promise<Mod>;
async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await wait(10);
  }
}

function world(t: TestContext, socket: string | null = "/s/sock") {
  const root = fs.realpathSync(mkTestTmp("pf-prw-"));
  t.after(() => rmTestTmp(root));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const sessionFile = path.join(agentDir, "sessions", "--p--", `2026_${SID}.jsonl`);
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: SID })}\n`);
  const startedAt = Date.now() - 600_000;
  const note: PaneNote = { v: 1, sessionId: SID, sessionFile, cwd, terminal: "t1", socket, createdMs: 1000, rootPid: 50, writtenAt: Date.now() - 10_000 };
  writeNote(agentDir, note);
  fs.mkdirSync(path.join(agentDir, "pi-foreman", "state", "live"), { recursive: true });
  const live = (o: Record<string, unknown> = {}): void =>
    fs.writeFileSync(path.join(agentDir, "pi-foreman", "state", "live", `${SID}.json`), JSON.stringify({ state: "working", hcTerminal: "t1", pid: 4242, startedAt: new Date(startedAt).toISOString(), heartbeatAt: new Date(Date.now() - 5000).toISOString(), cwd, ...o }));
  live();
  return { root, agentDir, cwd, sessionFile, note, startedAt, live };
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
}

function cliRig(t: TestContext, socket: string | null = "/s/sock") {
  const w = world(t, socket);
  const out: string[] = [];
  const spawns: { args: string[]; child: EventEmitter }[] = [];
  const spawnPi = (args: string[]): PiChild => {
    const child = new EventEmitter();
    spawns.push({ args, child });
    setImmediate(() => child.emit("spawn"));
    return child as unknown as PiChild;
  };
  const deps = (over: Partial<PaneResumeDeps> = {}): Partial<PaneResumeDeps> => ({
    env: { HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "/s/sock", PATH: process.env.PATH },
    agentDir: w.agentDir, platform: "win32", now: () => Date.now(), uptimeS: () => 3600, stdin: new FakeStdin() as unknown as PaneResumeDeps["stdin"], stdoutIsTty: true,
    out: (l) => void out.push(l), hcGet: async () => ({ createdMs: 1000, pid: 777 }), pidAlive: () => false, countdownMs: 5, spawnPi,
    procStartMs: () => { throw new Error("procStartMs not injected for this case"); }, procParent: () => { throw new Error("procParent not injected for this case"); }, ...over,
  });
  const finish = async (p: Promise<number>): Promise<number> => {
    await wait(80);
    for (const s of spawns) s.child.emit("exit", 0, null);
    return p;
  };
  return { ...w, out, spawns, deps, argv: ["--shell-pid", "777"], finish };
}

// ---------------------------------------------------------------- D1: the note on win32

test("win32: a tui start writes the note, installs no signal listeners, and only a normal quit deletes it", async (t) => {
  const w = world(t);
  fs.rmSync(notePath(w.agentDir, "t1"));
  const mod = await fresh();
  const env: Record<string, string | undefined> = { HC_TERMINAL_SOCKET: "\\\\.\\pipe\\hc-x" };
  const init = (o: Record<string, unknown> = {}) => ({ agentDir: w.agentDir, sessionId: SID, sessionFile: w.sessionFile, cwd: w.cwd, mode: "tui", platform: "win32", env, reason: "startup", hcTerminal: "t1", setting: "auto", send: () => {}, trace: () => {}, delayMs: 60_000, hcGet: async () => ({ createdMs: 1000, pid: 777 }), ...o }) as Parameters<Mod["PaneResume"]["start"]>[0];
  const before = [process.listenerCount("SIGHUP"), process.listenerCount("SIGTERM")];
  for (const reason of ["reload", "new", "resume", "fork", undefined]) {
    const p = mod.PaneResume.start(init());
    assert.ok(p, "a win32 start is not null");
    await until(() => readNoteRaw(w.agentDir, "t1") !== undefined);
    assert.deepEqual([process.listenerCount("SIGHUP"), process.listenerCount("SIGTERM")], before, "no listeners on win32");
    assert.equal(mod.signalEnded(), undefined);
    p?.stop(reason);
    assert.ok(readNoteRaw(w.agentDir, "t1"), `${reason}: the note stays`);
  }
  const n = readNoteRaw(w.agentDir, "t1") as PaneNote;
  assert.equal(n.socket, "\\\\.\\pipe\\hc-x");
  assert.equal(n.createdMs, 1000);
  const p = mod.PaneResume.start(init());
  await until(() => readNoteRaw(w.agentDir, "t1") !== undefined);
  p?.stop("quit");
  assert.equal(readNoteRaw(w.agentDir, "t1"), undefined, "quit deletes it");
});

test("win32: the start notice runs (restart message after a crash restart)", async (t) => {
  const w = world(t);
  const mod = await fresh();
  const sent: string[] = [];
  const env: Record<string, string | undefined> = { PI_FOREMAN_RESUMED: String(Date.UTC(2026, 10, 16, 8, 30)) };
  const p = mod.PaneResume.start({ agentDir: w.agentDir, sessionId: SID, sessionFile: w.sessionFile, cwd: w.cwd, mode: "tui", platform: "win32", env, reason: "startup", hcTerminal: "t1", setting: "auto", send: (x: string) => void sent.push(x), trace: () => {}, delayMs: 10, runsDir: path.join(w.root, "none"), uptimeS: () => 3600, hcGet: async () => "error" } as unknown as Parameters<Mod["PaneResume"]["start"]>[0]);
  await until(() => sent.length > 0);
  assert.match(sent[0], /restarted after a crash \(last sign of life 2026-11-16 08:30 UTC\)/);
  assert.equal(env.PI_FOREMAN_RESUMED, undefined);
  p?.stop("reload");
});

test("win32: off, a print mode, a subagent child and an invalid terminal id write no note", async (t) => {
  const w = world(t);
  fs.rmSync(notePath(w.agentDir, "t1"));
  const mod = await fresh();
  const base = { agentDir: w.agentDir, sessionId: SID, sessionFile: w.sessionFile, cwd: w.cwd, mode: "tui", platform: "win32", reason: "startup", hcTerminal: "t1", setting: "auto", send: () => {}, trace: () => {}, delayMs: 60_000, hcGet: async () => ({ createdMs: 1, pid: 2 }) };
  const none = async (o: Record<string, unknown>, env: Record<string, string | undefined> = {}): Promise<void> => {
    const p = mod.PaneResume.start({ ...base, env, ...o } as unknown as Parameters<Mod["PaneResume"]["start"]>[0]);
    await wait(30);
    p?.stop("reload");
    assert.equal(readNoteRaw(w.agentDir, "t1"), undefined);
  };
  await none({ setting: "off" });
  await none({ mode: "print" });
  await none({ hcTerminal: "../x" });
  await none({}, { PI_SUBAGENT_CHILD: "1" });
});

// ---------------------------------------------------------------- D2: socket case, note paths

test("win32: a socket that differs only in case is the same terminal; on posix it is a reused terminal", async (t) => {
  const win = cliRig(t, "\\\\.\\pipe\\hc-Administrator-1");
  const env = { HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "\\\\.\\pipe\\hc-administrator-1", PATH: process.env.PATH };
  const done = runPaneResume(win.argv, win.deps({ env }));
  assert.equal(await win.finish(done), 0);
  assert.equal(win.spawns.length, 1, "restarted");
  const posix = cliRig(t, "\\\\.\\pipe\\hc-Administrator-1");
  const d2 = runPaneResume(posix.argv, posix.deps({ env, platform: "linux" }));
  assert.equal(await posix.finish(d2), 0);
  assert.equal(posix.spawns.length, 0, "posix compares exactly");
  assert.equal(readNoteRaw(posix.agentDir, "t1"), undefined, "terminal_reused clears the note");
  const other = cliRig(t, "\\\\.\\pipe\\hc-Administrator-1");
  const d3 = runPaneResume(other.argv, other.deps({ env: { ...env, HC_TERMINAL_SOCKET: "\\\\.\\pipe\\hc-someone-2" } }));
  assert.equal(await other.finish(d3), 0);
  assert.equal(other.spawns.length, 0, "another socket is another terminal");
});

test("win32: validateNote compares the session folder without regard to case; posix compares exactly", (t) => {
  const w = world(t);
  const swapped = w.sessionFile.replace(`${path.sep}sessions${path.sep}`, `${path.sep}SESSIONS${path.sep}`);
  const raw = { ...w.note, sessionFile: swapped };
  const win = validateNote(raw, w.agentDir, "t1", "win32");
  assert.ok(win.ok || (win.ok === false && win.reason !== "custom_session_dir"), "win32: still under the agent dir's sessions folder");
  const posix = validateNote(raw, w.agentDir, "t1", "linux");
  assert.equal(posix.ok, false);
  assert.equal(posix.ok === false ? posix.reason : "", "custom_session_dir");
  assert.equal(validateNote(w.note, w.agentDir, "t1", "win32").ok, true);
  assert.equal(validateNote({ ...w.note, sessionFile: path.join(os.tmpdir(), "elsewhere", "x.jsonl") }, w.agentDir, "t1", "win32").ok, false);
});

// ---------------------------------------------------------------- D3: a pid the system gave out again

test("win32: an alive pid whose process started after the session is a reused pid, so Pi is gone and the session restarts", async (t) => {
  const r = cliRig(t);
  const done = runPaneResume(r.argv, r.deps({ pidAlive: () => true, procStartMs: () => r.startedAt + 60_000 }));
  assert.equal(await r.finish(done), 0);
  assert.equal(r.spawns.length, 1);
});

test("win32: the same process (started before the session record, or within 2 s) keeps; a failed query keeps", async (t) => {
  for (const [label, start] of [["earlier", (s: number) => s - 1000], ["within 2 s", (s: number) => s + 1500], ["query failed", () => null]] as const) {
    const r = cliRig(t);
    const done = runPaneResume(r.argv, r.deps({ pidAlive: () => true, procStartMs: () => start(r.startedAt) }));
    assert.equal(await r.finish(done), 0, label);
    assert.equal(r.spawns.length, 0, label);
    assert.ok(readNoteRaw(r.agentDir, "t1"), `${label}: note kept`);
  }
});

test("win32: a dead pid is not queried; posix never queries", async (t) => {
  let calls = 0;
  const a = cliRig(t);
  assert.equal(await a.finish(runPaneResume(a.argv, a.deps({ pidAlive: () => false, procStartMs: () => (calls++, null) }))), 0);
  assert.equal(calls, 0);
  const b = cliRig(t);
  assert.equal(await b.finish(runPaneResume(b.argv, b.deps({ platform: "linux", pidAlive: () => true, procStartMs: () => (calls++, 1), procParent: () => (calls++, null) }))), 0);
  assert.equal(calls, 0);
});

test("readLiveStartedMs reads startedAt of a live record; a missing record, a bad id or a bad date is null", (t) => {
  const w = world(t);
  assert.equal(readLiveStartedMs(w.agentDir, SID), w.startedAt);
  assert.equal(readLiveStartedMs(w.agentDir, "../x"), null);
  assert.equal(readLiveStartedMs(w.agentDir, "99999999-2222-3333-4444-555555555555"), null);
  w.live({ startedAt: "nope" });
  assert.equal(readLiveStartedMs(w.agentDir, SID), null);
});

// ---------------------------------------------------------------- D4: starting Pi without a shell

const NPM_SHIM = [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
  "IF EXIST \"%dp0%\\node.exe\" (", "  SET \"_prog=%dp0%\\node.exe\"", ") ELSE (", "  SET \"_prog=node\"", "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
  "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js\" %*", "",
].join("\r\n");

test("shimScript reads the JS entry of an npm shim (also next to a scoop node); a shim that is not an npm shim gives null", (t) => {
  const root = fs.realpathSync(mkTestTmp("pf-shim-"));
  t.after(() => rmTestTmp(root));
  const cmd = path.join(root, "pi.cmd");
  fs.writeFileSync(cmd, NPM_SHIM);
  const entry = shimScript(cmd, root) as string;
  assert.ok(entry.replace(/\\/g, "/").endsWith("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), entry);
  fs.writeFileSync(cmd, NPM_SHIM.replace("%dp0%\\node.exe", "%dp0%\\..\\..\\apps\\nodejs\\current\\node.exe").replace(/SET "_prog=%dp0%[^"]*"/, "SET \"_prog=C:\\scoop\\apps\\nodejs\\current\\node.exe\""));
  assert.equal((shimScript(cmd, root) as string).replace(/\\/g, "/").endsWith("pi-coding-agent/dist/bundle/cli.js"), true);
  fs.writeFileSync(cmd, "@echo off\r\n\"C:\\scoop\\apps\\pi\\current\\pi.exe\" %*\r\n");
  assert.equal(shimScript(cmd, root), null);
});

test("resolvePi: a pi.cmd shim in PATH order gives its entry, else pi.exe, else null; a shim without a readable entry falls through", () => {
  const files = new Set(["C:\\a\\pi.cmd", "C:\\a\\cli.js", "C:\\b\\pi.exe", "C:\\c\\pi.cmd"]);
  const exists = (f: string): boolean => files.has(f);
  const read = (cmd: string): string | null => (cmd === "C:\\a\\pi.cmd" ? "C:\\a\\cli.js" : cmd === "C:\\c\\pi.cmd" ? "C:\\c\\missing.js" : null);
  assert.deepEqual(resolvePi({ Path: "C:\\x;C:\\a;C:\\b" }, exists, read), { kind: "shim", entry: "C:\\a\\cli.js" });
  assert.deepEqual(resolvePi({ PATH: "C:\\x;\"C:\\b\";C:\\a" }, exists, read), { kind: "exe", file: "C:\\b\\pi.exe" });
  assert.deepEqual(resolvePi({ PATH: "C:\\c;C:\\b" }, exists, read), { kind: "exe", file: "C:\\b\\pi.exe" }, "a shim whose entry is gone is skipped");
  assert.equal(resolvePi({ PATH: "C:\\x;C:\\c" }, exists, read), null);
  assert.equal(resolvePi({}, exists, read), null);
  assert.equal(resolvePi({ PATH: "C:\\a" }, exists, () => { throw new Error("unreadable"); }), null, "a throwing reader is a miss");
});

test("piCommand: win32 shim runs this Node on the entry, pi.exe runs itself, nothing found throws; posix is pi with the args", () => {
  const args = ["--session", "C:\\s\\x.jsonl"];
  assert.deepEqual(piCommand({ kind: "shim", entry: "C:\\a\\cli.js" }, args, "win32"), { program: process.execPath, argv: ["C:\\a\\cli.js", ...args] });
  assert.deepEqual(piCommand({ kind: "exe", file: "C:\\b\\pi.exe" }, args, "win32"), { program: "C:\\b\\pi.exe", argv: args });
  assert.throws(() => piCommand(null, args, "win32"), /pi was not found/);
  assert.deepEqual(piCommand(null, args, "linux"), { program: "pi", argv: args });
  assert.deepEqual(piCommand({ kind: "exe", file: "x" }, args, "darwin"), { program: "pi", argv: args });
});

// ---------------------------------------------------------------- D5: the Git Bash shell pid

const LAUNCHER = "C:\\Program Files\\Git\\bin\\bash.exe";
const SHELL = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";
const gitBash = (o: Partial<ProcInfo> = {}): ProcInfo => ({ parentPid: 888, image: SHELL, parentImage: LAUNCHER, ...o });

test("isGitBashLauncherChild: the shell under the launcher of the same Git root, only", () => {
  assert.equal(isGitBashLauncherChild(888, gitBash()), true);
  assert.equal(isGitBashLauncherChild(888, gitBash({ parentImage: LAUNCHER.toUpperCase(), image: SHELL.toLowerCase() })), true, "case does not matter");
  assert.equal(isGitBashLauncherChild(888, gitBash({ parentPid: 999 })), false, "parent is not the terminal's program");
  assert.equal(isGitBashLauncherChild(888, gitBash({ parentImage: SHELL })), false, "a bash typed inside the pane");
  assert.equal(isGitBashLauncherChild(888, gitBash({ image: LAUNCHER })), false, "the shell is not usr\\bin\\bash.exe");
  assert.equal(isGitBashLauncherChild(888, gitBash({ image: "D:\\Other\\usr\\bin\\bash.exe" })), false, "another Git root");
  assert.equal(isGitBashLauncherChild(888, gitBash({ image: "", parentImage: "" })), false);
  assert.equal(isGitBashLauncherChild(888, null), false);
});

test("win32 Git Bash: the shell whose parent is hc's launcher restarts; a nested bash keeps; a failed query keeps; PowerShell's own pid needs no query", async (t) => {
  const hc = async () => ({ createdMs: 1000, pid: 888 });
  const ok = cliRig(t);
  assert.equal(await ok.finish(runPaneResume(ok.argv, ok.deps({ hcGet: hc, procParent: () => gitBash() }))), 0);
  assert.equal(ok.spawns.length, 1, "launcher case resumes");
  const nested = cliRig(t);
  assert.equal(await nested.finish(runPaneResume(nested.argv, nested.deps({ hcGet: hc, procParent: () => gitBash({ parentPid: 999, parentImage: SHELL }) }))), 0);
  assert.equal(nested.spawns.length, 0, "nested_shell");
  assert.ok(readNoteRaw(nested.agentDir, "t1"));
  const failed = cliRig(t);
  assert.equal(await failed.finish(runPaneResume(failed.argv, failed.deps({ hcGet: hc, procParent: () => null }))), 0);
  assert.equal(failed.spawns.length, 0);
  const direct = cliRig(t);
  assert.equal(await direct.finish(runPaneResume(["--shell-pid", "888"], direct.deps({ hcGet: hc }))), 0);
  assert.equal(direct.spawns.length, 1, "pid equals hc's pid: procParent was never called (it throws here)");
  const posix = cliRig(t);
  assert.equal(await posix.finish(runPaneResume(posix.argv, posix.deps({ platform: "linux", hcGet: hc }))), 0);
  assert.equal(posix.spawns.length, 0, "posix: a different pid is a nested shell, no query");
});

// ---------------------------------------------------------------- D13: PI_BG_* on win32

test("buildSpawnEnv on win32 keeps the shell's PI_BG_SHELL and PI_BG_SHELL_PATH and drops other PI_BG_*; posix drops all of them", () => {
  const base = { PI_BG_SHELL: "bash", PI_BG_SHELL_PATH: "C:\\Git\\bin\\bash.exe", PI_BG_OLD: "x", PI_BG_FEATURES: "shell-bg", PATH: "p" };
  const launch = { bgEnv: { PI_BG_FOO: "1" } };
  const win = buildSpawnEnv(base, launch, 5, "win32");
  assert.deepEqual(Object.keys(win).filter((k) => k.startsWith("PI_BG_")).sort(), ["PI_BG_FOO", "PI_BG_SHELL", "PI_BG_SHELL_PATH"]);
  assert.equal(win.PI_BG_SHELL_PATH, "C:\\Git\\bin\\bash.exe");
  const posix = buildSpawnEnv(base, launch, 5, "linux");
  assert.deepEqual(Object.keys(posix).filter((k) => k.startsWith("PI_BG_")), ["PI_BG_FOO"]);
  assert.deepEqual(buildSpawnEnv(base, null, 5, "win32").PI_BG_OLD, "x", "a plain session keeps everything");
});

test("captureIdentity captures PI_BG_* everywhere; on win32 not PI_BG_SHELL and PI_BG_SHELL_PATH", () => {
  const env = { PI_FOREMAN_HANDOFF_DIR: "/h/handoff", PI_INTERCOM_STABLE_ID: "child-1", PI_BG_SHELL: "bash", PI_BG_SHELL_PATH: "C:\\Git\\bin\\bash.exe", PI_BG_FOO: "x" };
  const e = captureIdentity(env, "s1", undefined);
  if (process.platform === "win32") assert.deepEqual(e?.bgEnv, { PI_BG_FOO: "x" });
  else assert.deepEqual(e?.bgEnv, { PI_BG_FOO: "x", PI_BG_SHELL: "bash" }, "posix: the path value fails the pattern as before, the plain one is kept");
});
