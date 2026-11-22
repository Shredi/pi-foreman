// Crash restart, adapter side (paneresume.ts): the pane note with a fake `hc`, shutdown reasons, the signal slot with a persistent signal-exit style
// listener and a prepended Pi style handler, the 10 s timers, the 14-day sweep, dead runs and tasks, the restart message.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reconcileAsyncRun } from "../../../node_modules/pi-subagents/src/runs/background/stale-run-reconciler.js";
import { ASYNC_DIR, resolveTempScopeId } from "../../../node_modules/pi-subagents/src/shared/types.js";
import { spawnSync } from "node:child_process";
import { stepsOfRunEnd } from "../bound.ts";
import { LiveState, liveDir } from "../livestate.ts";
import { NOTE_MAX_AGE_MS, hcGet, notePath, panesDir, readNoteRaw, writeNote } from "../paneresume-core.ts";
import type { PaneNote } from "../paneresume-core.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

type Mod = typeof import("../paneresume.ts");
const SLOT = Symbol.for("pi-foreman.paneresume");
const SID = "11111111-2222-3333-4444-555555555555";
let importN = 0;
const fresh = (): Promise<Mod> => import(`../paneresume.ts?v=${++importN}`) as Promise<Mod>;
const NO = (): null => null;
const slotOf = (): { installed: boolean; ours: Record<string, () => void>; persistent: Record<string, unknown[]>; signalled: boolean } | undefined => (globalThis as unknown as Record<symbol, never>)[SLOT];
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await wait(10);
  }
}

/** The process-global slot gone, the adapter's listeners removed, and a persistent signal-exit style listener registered: a clean "first load". */
function signalWorld(t: TestContext) {
  const s = slotOf();
  if (s) for (const [sig, fn] of Object.entries(s.ours)) process.off(sig as NodeJS.Signals, fn);
  delete (globalThis as unknown as Record<symbol, unknown>)[SLOT];
  const persistentFn = (): void => {};
  const piHandlers: [NodeJS.Signals, () => void][] = [];
  const kills: [number, unknown][] = [];
  const realKill = process.kill.bind(process);
  t.mock.method(process, "kill", (pid: number, sig?: string | number) => {
    if (sig === 0 || sig === undefined) return realKill(pid, sig as number);
    kills.push([pid, sig]);
    return true;
  });
  process.on("SIGHUP", persistentFn);
  process.on("SIGTERM", persistentFn);
  const cleanup = (): void => {
    const cur = slotOf();
    if (cur) for (const [sig, fn] of Object.entries(cur.ours)) process.off(sig as NodeJS.Signals, fn);
    process.off("SIGHUP", persistentFn);
    process.off("SIGTERM", persistentFn);
    for (const [sig, fn] of piHandlers) process.off(sig, fn);
    delete (globalThis as unknown as Record<symbol, unknown>)[SLOT];
  };
  t.after(cleanup);
  /** Pi's init(): `process.prependListener` for both signals. */
  const piInstalls = (): (() => void) => {
    const fn = (): void => {};
    for (const sig of ["SIGHUP", "SIGTERM"] as const) {
      process.prependListener(sig, fn);
      piHandlers.push([sig, fn]);
    }
    return fn;
  };
  const piRemoves = (fn: () => void): void => {
    for (const sig of ["SIGHUP", "SIGTERM"] as const) process.off(sig, fn);
  };
  return { persistentFn, piInstalls, piRemoves, kills };
}

function rig(t: TestContext, over: { hc?: string } = {}) {
  const root = fs.realpathSync(mkTestTmp("pf-pra-"));
  t.after(() => rmTestTmp(root));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const sessionFile = path.join(agentDir, "sessions", "--p--", `2026_${SID}.jsonl`);
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: SID })}\n`);
  const hc = path.join(root, "hc");
  fs.writeFileSync(hc, over.hc ?? `#!/bin/sh\necho "$@" >> "${root}/hc.log"\nprintf '{"created_ms":1000,"pid":777}'\n`, { mode: 0o755 });
  const env: Record<string, string | undefined> = { HC_BIN: hc, HC_TERMINAL_SOCKET: "/s/sock" };
  const sent: string[] = [];
  const traces: Record<string, unknown>[] = [];
  const init = (mod: Mod, o: Record<string, unknown> = {}) => ({
    agentDir, sessionId: SID, sessionFile, cwd, mode: "tui", platform: "linux", env, reason: "startup", hcTerminal: "t1", setting: "auto",
    send: (x: string) => void sent.push(x), trace: (r: Record<string, unknown>) => void traces.push(r), delayMs: 60_000, ...o,
  }) as Parameters<typeof mod.PaneResume.start>[0];
  const note = (): PaneNote | null => (readNoteRaw(agentDir, "t1") ?? null) as PaneNote | null;
  return { root, agentDir, cwd, sessionFile, env, sent, traces, init, note };
}

const noteOf = (r: ReturnType<typeof rig>, over: Partial<PaneNote> = {}): PaneNote => ({ v: 1, sessionId: SID, sessionFile: r.sessionFile, cwd: r.cwd, terminal: "t1", socket: "/s/sock", createdMs: 1, rootPid: 2, writtenAt: Date.now(), ...over });

test("start writes the note from a fake hc; the fake was called with get <terminal> --json", { skip: posixOnly }, async (t) => {
  const r = rig(t);
  const mod = await fresh();
  signalWorld(t);
  const p = mod.PaneResume.start(r.init(mod));
  assert.ok(p);
  await until(() => r.note() !== null);
  const n = r.note() as PaneNote;
  assert.equal(n.v, 1);
  assert.equal(n.sessionId, SID);
  assert.equal(n.sessionFile, r.sessionFile);
  assert.equal(n.cwd, r.cwd);
  assert.equal(n.terminal, "t1");
  assert.equal(n.socket, "/s/sock");
  assert.equal(n.createdMs, 1000);
  assert.equal(n.rootPid, 777);
  assert.equal(typeof n.writtenAt, "number");
  assert.equal(JSON.stringify(Object.keys(n).sort()), JSON.stringify(["createdMs", "cwd", "rootPid", "sessionFile", "sessionId", "socket", "terminal", "v", "writtenAt"]), "no env in the note");
  assert.equal(fs.readFileSync(path.join(r.root, "hc.log"), "utf8").trim(), "get t1 --json");
  p?.stop("reload");
});

test("shutdown reasons reload, new, resume, fork keep the note; a next start overwrites; quit deletes only its own note", { skip: posixOnly }, async (t) => {
  const r = rig(t);
  const mod = await fresh();
  signalWorld(t);
  for (const reason of ["reload", "new", "resume", "fork"]) {
    const p = mod.PaneResume.start(r.init(mod));
    await until(() => r.note() !== null);
    p?.stop(reason);
    assert.ok(r.note(), `${reason} keeps the note`);
  }
  writeNote(r.agentDir, noteOf(r, { rootPid: 5 }));
  const p = mod.PaneResume.start(r.init(mod));
  await until(() => r.note()?.rootPid === 777);
  p?.stop("quit");
  assert.equal(r.note(), null, "quit deletes its own note");
  writeNote(r.agentDir, noteOf(r, { sessionId: "99999999-0000-0000-0000-000000000000" }));
  const q = mod.PaneResume.start(r.init(mod, { hcGet: async () => "error" }));
  q?.stop("quit");
  assert.equal(r.note()?.sessionId, "99999999-0000-0000-0000-000000000000", "a note naming another session stays");
});

test("a signal that Pi handles keeps the note and ends the live record with endedBy signal (SIGHUP and SIGTERM)", { skip: posixOnly }, async (t) => {
  for (const sig of ["SIGHUP", "SIGTERM"] as const) {
    const r = rig(t);
    const mod = await fresh();
    const w = signalWorld(t);
    const live = LiveState.start({ agentDir: r.agentDir, sessionId: SID, cwd: r.cwd, mode: "tui", env: {}, endedBy: mod.signalEnded }, () => [], NO, () => [], NO, () => []) as LiveState;
    const p = mod.PaneResume.start(r.init(mod));
    await until(() => r.note() !== null);
    w.piInstalls();
    process.emit(sig);
    assert.equal(mod.signalEnded(), "signal");
    p?.stop("quit"); // Pi's dispose then runs session_shutdown with reason quit
    live.stop();
    assert.ok(r.note(), `${sig}: the note stays`);
    const rec = JSON.parse(fs.readFileSync(path.join(liveDir(r.agentDir), `${SID}.json`), "utf8"));
    assert.equal(rec.state, "done");
    assert.equal(rec.endedBy, "signal");
    assert.deepEqual(w.kills, [], "nothing re-raised");
  }
});

test("listeners are installed once across two starts and two fresh imports", { skip: posixOnly }, async (t) => {
  const r = rig(t);
  signalWorld(t);
  const before = { SIGHUP: process.listenerCount("SIGHUP"), SIGTERM: process.listenerCount("SIGTERM") };
  const a = await fresh();
  const b = await fresh();
  assert.notEqual(a.PaneResume, b.PaneResume, "two module instances");
  a.PaneResume.start(r.init(a, { hcGet: async () => "error" }))?.stop("reload");
  a.PaneResume.start(r.init(a, { hcGet: async () => "error" }))?.stop("reload");
  b.PaneResume.start(r.init(b, { hcGet: async () => "error" }))?.stop("reload");
  assert.equal(process.listenerCount("SIGHUP"), before.SIGHUP + 1);
  assert.equal(process.listenerCount("SIGTERM"), before.SIGTERM + 1);
});

test("the flag set in one module instance is read by session_shutdown in another; persistent is recorded at the first load and kept", { skip: posixOnly }, async (t) => {
  const r = rig(t);
  const w = signalWorld(t);
  const a = await fresh();
  assert.ok(slotOf()?.persistent.SIGHUP.includes(w.persistentFn), "signal-exit's listener is in the persistent set");
  const late = (): void => {};
  process.on("SIGTERM", late); // registered after the first load: not persistent
  t.after(() => void process.off("SIGTERM", late));
  const b = await fresh();
  assert.ok(slotOf()?.persistent.SIGTERM.includes(w.persistentFn) && !slotOf()?.persistent.SIGTERM.includes(late), "a second fresh import keeps the set");
  const pa = a.PaneResume.start(r.init(a));
  await until(() => r.note() !== null);
  w.piInstalls();
  process.emit("SIGTERM");
  assert.equal(b.signalEnded(), "signal", "another instance reads the flag");
  const pb = b.PaneResume.start(r.init(b, { hcGet: async () => "error" }));
  pa?.stop("reload");
  pb?.stop("quit");
  assert.ok(r.note(), "the newer instance's shutdown keeps the note");
});

test("without Pi's handler a signal sets no flag, removes the adapter's listeners and re-raises; the normal quit still deletes the note", { skip: posixOnly }, async (t) => {
  const r = rig(t);
  const w = signalWorld(t);
  const mod = await fresh();
  const base = { SIGHUP: process.listenerCount("SIGHUP"), SIGTERM: process.listenerCount("SIGTERM") };
  const p = mod.PaneResume.start(r.init(mod));
  await until(() => r.note() !== null);
  assert.equal(process.listenerCount("SIGTERM"), base.SIGTERM + 1);
  const pi = w.piInstalls();
  w.piRemoves(pi); // Pi removes its handlers for a normal quit
  process.emit("SIGTERM");
  assert.equal(mod.signalEnded(), undefined, "no flag");
  assert.equal(process.listenerCount("SIGTERM"), base.SIGTERM, "the adapter's listener is gone");
  assert.equal(process.listenerCount("SIGHUP"), base.SIGHUP, "both listeners are gone");
  assert.deepEqual(w.kills, [[process.pid, "SIGTERM"]]);
  p?.stop("quit");
  assert.equal(r.note(), null, "the normal quit still deletes the note");
});

test("a Pi style handler registered again with a new function still counts as Pi's", { skip: posixOnly }, async (t) => {
  const r = rig(t);
  const w = signalWorld(t);
  const mod = await fresh();
  mod.PaneResume.start(r.init(mod, { hcGet: async () => "error" }));
  const first = w.piInstalls();
  w.piRemoves(first);
  w.piInstalls(); // a new function
  process.emit("SIGHUP");
  assert.equal(mod.signalEnded(), "signal");
  assert.deepEqual(w.kills, []);
});

test("signal listeners are not installed with off, outside tui, for a child, or with an invalid terminal id; those start writes nothing", { skip: posixOnly }, async (t) => {
  const r = rig(t);
  signalWorld(t);
  const mod = await fresh();
  const base = process.listenerCount("SIGTERM");
  const none = async (o: Record<string, unknown>, label: string): Promise<void> => {
    const p = mod.PaneResume.start(r.init(mod, { hcGet: async () => ({ createdMs: 1, pid: 2 }), ...o }));
    await wait(30);
    p?.stop("reload");
    assert.equal(process.listenerCount("SIGTERM"), base, `${label}: no listener`);
    assert.equal(r.note(), null, `${label}: no note`);
  };
  await none({ mode: "print" }, "print mode");
  await none({ mode: "json" }, "json mode");
  await none({ mode: undefined }, "no mode");
  await none({ setting: "off" }, "off");
  await none({ hcTerminal: "../x" }, "invalid terminal id");
  await none({ hcTerminal: null }, "no terminal");
  r.env.PI_SUBAGENT_CHILD = "1";
  await none({}, "subagent child");
  delete r.env.PI_SUBAGENT_CHILD;
  assert.equal(mod.PaneResume.start(r.init(mod, { mode: "print" })), null);
});

test("off deletes this terminal's note and writes none; the sweep still runs", { skip: posixOnly }, async (t) => {
  const r = rig(t);
  signalWorld(t);
  const mod = await fresh();
  writeNote(r.agentDir, noteOf(r));
  writeNote(r.agentDir, noteOf(r, { terminal: "t2", writtenAt: Date.now() - NOTE_MAX_AGE_MS - 1000 }));
  const p = mod.PaneResume.start(r.init(mod, { setting: "off", hcGet: async () => ({ createdMs: 1, pid: 2 }) }));
  await wait(30);
  p?.stop("reload");
  assert.equal(r.note(), null);
  assert.equal(readNoteRaw(r.agentDir, "t2"), undefined, "the old note of another terminal is swept");
});

test("a failing or hanging hc hits the timeout, traces, writes no note, throws nothing", { skip: posixOnly }, async (t) => {
  const r = rig(t, { hc: "#!/bin/sh\nexit 3\n" });
  signalWorld(t);
  const mod = await fresh();
  const p = mod.PaneResume.start(r.init(mod));
  await until(() => r.traces.length > 0);
  assert.equal(r.traces[0].event, "pane_note_skipped");
  assert.equal(r.traces[0].reason, "hc_get_failed");
  assert.equal(r.note(), null);
  p?.stop("reload");
  // the timeout the adapter passes, and the real hcGet's kill on a hang
  let seen = 0;
  const q = mod.PaneResume.start(r.init(mod, { hcGet: async (_t: string, ms: number) => ((seen = ms), "error" as const) }));
  await until(() => seen > 0);
  assert.equal(seen, 10_000);
  assert.equal(mod.HC_GET_TIMEOUT_MS, 10_000);
  q?.stop("reload");
  const hang = path.join(r.root, "hc-hang");
  fs.writeFileSync(hang, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  const t0 = Date.now();
  assert.equal(await hcGet("t1", 200, { ...r.env, HC_BIN: hang }), "error");
  assert.ok(Date.now() - t0 < 5000);
  const noPid = path.join(r.root, "hc-nopid");
  fs.writeFileSync(noPid, "#!/bin/sh\nprintf '{\"created_ms\":1}'\n", { mode: 0o755 });
  assert.equal(await hcGet("t1", 2000, { ...r.env, HC_BIN: noPid }), "error", "a reply without a pid is an error");
});

test("the 14-day sweep goes by the live heartbeat, else the note's writtenAt", { skip: posixOnly }, async (t) => {
  const r = rig(t);
  signalWorld(t);
  const mod = await fresh();
  const old = Date.now() - NOTE_MAX_AGE_MS - 60_000;
  const sid = (n: number): string => `0000000${n}-0000-0000-0000-000000000000`;
  const live = (id: string, heartbeat: number): void => {
    fs.mkdirSync(liveDir(r.agentDir), { recursive: true });
    fs.writeFileSync(path.join(liveDir(r.agentDir), `${id}.json`), JSON.stringify({ state: "idle", pid: 5, heartbeatAt: new Date(heartbeat).toISOString(), cwd: r.cwd }));
  };
  writeNote(r.agentDir, noteOf(r, { terminal: "a", sessionId: sid(1), writtenAt: Date.now() })); // heartbeat old: swept although writtenAt is new
  live(sid(1), old);
  writeNote(r.agentDir, noteOf(r, { terminal: "b", sessionId: sid(2), writtenAt: old })); // heartbeat new: kept although writtenAt is old
  live(sid(2), Date.now() - 1000);
  writeNote(r.agentDir, noteOf(r, { terminal: "c", sessionId: sid(3), writtenAt: old })); // no live record: writtenAt old
  writeNote(r.agentDir, noteOf(r, { terminal: "d", sessionId: sid(4), writtenAt: Date.now() - 1000 })); // no live record: writtenAt new
  mod.sweepNotes(r.agentDir, Date.now());
  assert.deepEqual(fs.readdirSync(panesDir(r.agentDir)).sort(), ["b.json", "d.json"]);
});

test("the 10 s timers: nothing before 10 s, one message at 10 s; /reload and /new inside the window clear it, send nothing, throw nothing", async (t) => {
  const r = rig(t);
  const mod = await fresh();
  assert.equal(mod.SCAN_DELAY_MS, 10_000);
  signalWorld(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  r.env.PI_FOREMAN_RESUMED = String(Date.now() - 60_000);
  const delay = { delayMs: undefined, hcGet: async () => "error" as const };
  const a = mod.PaneResume.start(r.init(mod, delay));
  assert.equal(r.env.PI_FOREMAN_RESUMED, undefined, "removed from the env at start");
  t.mock.timers.tick(9_999);
  assert.equal(r.sent.length, 0);
  t.mock.timers.tick(1);
  assert.equal(r.sent.length, 1, "one message at 10 s");
  a?.stop("quit");
  for (const reason of ["reload", "new"]) {
    r.env.PI_FOREMAN_RESUMED = String(Date.now() - 60_000);
    const b = mod.PaneResume.start(r.init(mod, delay));
    t.mock.timers.tick(5_000);
    assert.doesNotThrow(() => b?.stop(reason));
    t.mock.timers.tick(60_000);
    assert.equal(r.sent.length, 1, `${reason}: no message after the shutdown`);
  }
});

function status(runsDir: string, id: string, o: Record<string, unknown>): void {
  fs.mkdirSync(path.join(runsDir, id), { recursive: true });
  fs.writeFileSync(path.join(runsDir, id, "status.json"), JSON.stringify({ runId: id, mode: "single", steps: [{ agent: "builder", status: "running" }], ...o }));
}

test("readDeadRuns: running before the boot is named; after the boot, failed, complete and another session's are not", async () => {
  const mod = await fresh();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-dead-"));
  const boot = Date.now() - 3_600_000;
  status(dir, "run-old", { sessionId: SID, state: "running", startedAt: boot - 1000 });
  status(dir, "run-queued", { sessionId: "/x/sessions/f.jsonl", state: "queued", startedAt: boot - 5000 });
  status(dir, "run-new", { sessionId: SID, state: "running", startedAt: boot + 1000 });
  status(dir, "run-failed", { sessionId: SID, state: "failed", startedAt: boot - 1000 });
  status(dir, "run-done", { sessionId: SID, state: "complete", startedAt: boot - 1000 });
  status(dir, "run-other", { sessionId: "other-session-id", state: "running", startedAt: boot - 1000 });
  fs.mkdirSync(path.join(dir, "no-status"));
  fs.mkdirSync(path.join(dir, "bad"));
  fs.writeFileSync(path.join(dir, "bad", "status.json"), "{nope");
  try {
    const r = mod.readDeadRuns(dir, "/x/sessions/f.jsonl", SID, boot);
    assert.deepEqual(r.dead.map((d) => d.id).sort(), ["run-old", "run-queued"]);
    assert.equal(r.dead[0].agent, "builder");
    assert.equal(r.found, 5, "the session's own status files, whatever their state");
    assert.deepEqual(mod.readDeadRuns(path.join(dir, "missing"), undefined, SID, boot), { dead: [], found: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the runs root mirrors pi-subagents (scope id, PI_SUBAGENTS_TEMP_ROOT, async-subagent-runs)", async () => {
  const mod = await fresh();
  assert.equal(mod.subagentsScopeId(process.env), resolveTempScopeId());
  assert.equal(mod.subagentsRunsDir({ ...process.env, PI_SUBAGENTS_TEMP_ROOT: undefined }), path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId()}`, "async-subagent-runs"));
  assert.equal(mod.subagentsRunsDir(process.env), ASYNC_DIR);
  assert.equal(mod.subagentsRunsDir({ PI_SUBAGENTS_TEMP_ROOT: " /x/y " }), path.join(path.resolve("/x/y"), "async-subagent-runs"));
});

test("D12: the package fails a dead pid's run (a failed result no gate counts); an unknown pid namespace keeps it running, and pi-foreman names it", async (t) => {
  const mod = await fresh();
  const base = fs.realpathSync(mkTestTmp("pf-d12-"));
  t.after(() => rmTestTmp(base));
  const dead = spawnSync(process.execPath, ["-e", ""]).pid as number; // exited: its pid is dead
  const boot = Date.now() - 3_600_000;
  const runs = path.join(base, "runs");
  const results = path.join(base, "results");
  const mk = (id: string, extra: Record<string, unknown>): string => {
    status(runs, id, { sessionId: SID, state: "running", pid: dead, startedAt: boot - 1000, lastUpdate: boot - 1000, ...extra });
    return path.join(runs, id);
  };
  const same = mk("run-dead", { pidNamespaceScope: "ns-a" });
  const moved = mk("run-moved", { pidNamespaceScope: "ns-old" });
  const a = reconcileAsyncRun(same, { resultsDir: results, pidNamespaceScope: () => "ns-a" });
  assert.equal(a.repaired, true);
  assert.equal(a.status?.state, "failed");
  const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));
  const result = files(results).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(f, "utf8"))).find((j) => j.id === "run-dead" && Array.isArray(j.results));
  assert.ok(result, "the package wrote the failed result");
  assert.equal(result.success, false);
  assert.deepEqual(stepsOfRunEnd(result, []), [], "a failed run never counts as a builder step: the finish gate still requires a builder");
  const b = reconcileAsyncRun(moved, { resultsDir: results, pidNamespaceScope: () => "ns-new" });
  assert.equal(b.repaired, false, "the pid namespace changed: the package keeps the run");
  assert.equal(b.status?.state, "running");
  assert.deepEqual(mod.readDeadRuns(runs, undefined, SID, boot + 3_000_000).dead.map((d) => d.id), ["run-moved"], "named: the failed one is skipped");
});

function messageRig(t: TestContext) {
  const r = rig(t);
  const runs = path.join(r.root, "runs");
  fs.mkdirSync(runs);
  const asyncCall = (args: Record<string, unknown>): void => fs.appendFileSync(r.sessionFile, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "subagent", arguments: args }] } })}\n`);
  return { ...r, runs, asyncCall };
}

test("reboot with the runs root gone: the 'cannot be listed' line only for a session that launched an async run (async omitted, true; not false)", async (t) => {
  signalWorld(t);
  const mod = await fresh();
  const cases: [string, Record<string, unknown> | null, boolean][] = [
    ["async omitted", { agent: "builder" }, true],
    ["async true", { agent: "builder", async: true }, true],
    ["async false", { agent: "builder", async: false }, false],
    ["no subagent call", null, false],
  ];
  for (const [label, call, expected] of cases) {
    const r = messageRig(t);
    if (call) r.asyncCall(call);
    r.env.PI_FOREMAN_RESUMED = String(Date.now() - 7_200_000);
    const p = mod.PaneResume.start(r.init(mod, { delayMs: 10, runsDir: path.join(r.root, "gone"), uptimeS: () => 3600, hcGet: async () => "error" }));
    await until(() => r.sent.length > 0);
    assert.equal(r.sent[0].includes("cannot be listed: their records were cleared; check the ledger for runs still needed."), expected, label);
    p?.stop("quit");
  }
  // not a reboot (heartbeat after the boot): never said
  const r = messageRig(t);
  r.asyncCall({ agent: "builder" });
  r.env.PI_FOREMAN_RESUMED = String(Date.now() - 60_000);
  const p = mod.PaneResume.start(r.init(mod, { delayMs: 10, runsDir: path.join(r.root, "gone"), uptimeS: () => 3600, hcGet: async () => "error" }));
  await until(() => r.sent.length > 0);
  assert.equal(r.sent[0].includes("cannot be listed"), false);
  p?.stop("quit");
});

test("restart message: names dead runs and dead tasks, says waits are lost, one message; a notice without PI_FOREMAN_RESUMED only when something died", async (t) => {
  signalWorld(t);
  const mod = await fresh();
  const r = messageRig(t);
  const boot = Date.now() - 3_600_000;
  status(r.runs, "run-moved", { sessionId: SID, state: "running", startedAt: boot - 1000, steps: [{ agent: "builder" }] });
  const tdir = path.join(r.cwd, ".pi", "tasks", `${SID}-4321`);
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, "t-old.json"), JSON.stringify({ id: "t-old", status: "running", startTime: boot - 5000, name: "old job", pid: process.pid }));
  fs.writeFileSync(path.join(tdir, "t-dead.json"), JSON.stringify({ id: "t-dead", status: "running", startTime: Date.now() - 2000, name: "dead job", pid: 999_999_999 }));
  fs.writeFileSync(path.join(tdir, "t-live.json"), JSON.stringify({ id: "t-live", status: "running", startTime: Date.now() - 2000, name: "live job", pid: process.pid }));
  r.env.PI_FOREMAN_RESUMED = String(Date.UTC(2026, 10, 16, 8, 30));
  const p = mod.PaneResume.start(r.init(mod, { delayMs: 10, runsDir: r.runs, uptimeS: () => 3600, hcGet: async () => "error" }));
  await until(() => r.sent.length > 0);
  await wait(60);
  assert.equal(r.sent.length, 1, "one message");
  const text = r.sent[0];
  assert.match(text, /restarted after a crash \(last sign of life 2026-11-16 08:30 UTC\)/);
  assert.match(text, /builder run-moved/);
  assert.match(text, /t-old \(old job\)/);
  assert.match(text, /t-dead \(dead job\)/);
  assert.equal(text.includes("t-live"), false);
  assert.match(text, /Waits \(foreman_wait\) are lost; relaunch what is still needed\./);
  p?.stop("quit");
  // no restart: a notice, only when there is something
  const q = messageRig(t);
  const p2 = mod.PaneResume.start(q.init(mod, { delayMs: 10, runsDir: q.runs, uptimeS: () => 3600, hcGet: async () => "error" }));
  await wait(80);
  assert.deepEqual(q.sent, [], "nothing died, no restart: no message");
  p2?.stop("quit");
  const q2 = messageRig(t);
  const tdir2 = path.join(q2.cwd, ".pi", "tasks", `${SID}-1`);
  fs.mkdirSync(tdir2, { recursive: true });
  fs.writeFileSync(path.join(tdir2, "x.json"), JSON.stringify({ id: "x", status: "running", startTime: Date.now() - 2000, name: "gone", pid: 999_999_999 }));
  const p3 = mod.PaneResume.start(q2.init(mod, { delayMs: 10, runsDir: q2.runs, uptimeS: () => 3600, hcGet: async () => "error" }));
  await until(() => q2.sent.length > 0);
  assert.match(q2.sent[0], /^pi-foreman notice: Background tasks that are no longer running: x \(gone\)\.$/);
  p3?.stop("quit");
});

test("taskEndedCheck: older than the boot or a dead pid ends a task; no pid is judged by age only; deadTasks leaves readOwnAddonTasks output as is", async (t) => {
  const mod = await fresh();
  const base = { id: "a", label: "a", tail: [] as string[] };
  const check = mod.taskEndedCheck(() => 1000, (pid) => pid === 5);
  assert.equal(check({ ...base, pid: 5, ageSeconds: 10 }), false);
  assert.equal(check({ ...base, pid: 6, ageSeconds: 10 }), true, "own pid gone");
  assert.equal(check({ ...base, pid: 5, ageSeconds: 2000 }), true, "started before the boot");
  assert.equal(check({ ...base, ageSeconds: 10 } as never), false, "no pid, young");
  assert.equal(check({ ...base, ageSeconds: 2000 } as never), true, "no pid, old");
  const r = rig(t);
  const tdir = path.join(r.cwd, ".pi", "tasks", "sess-9");
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, "t.json"), JSON.stringify({ id: "t", status: "running", startTime: Date.now() - 3000, name: "job", pid: 7 }));
  assert.deepEqual(mod.deadTasks(r.cwd, "sess", () => true).map((x) => x.id), ["t"]);
  assert.deepEqual(mod.deadTasks(r.cwd, "sess", () => false), []);
  assert.deepEqual(mod.deadTasks(path.join(r.cwd, "nope"), "sess", () => true), []);
});

test("the notes dir is read back by notePath/readNoteRaw (module contract the adapter and the command share)", (t) => {
  const r = rig(t);
  writeNote(r.agentDir, noteOf(r));
  assert.equal(fs.existsSync(notePath(r.agentDir, "t1")), true);
});

test("reload and new send no dead-task notice while a crash-left running task record exists; startup and resume do", async (t) => {
  signalWorld(t);
  const mod = await fresh();
  for (const [reason, expected] of [["reload", false], ["new", false], ["startup", true], ["resume", true]] as const) {
    const q = messageRig(t);
    const tdir = path.join(q.cwd, ".pi", "tasks", `${SID}-1`);
    fs.mkdirSync(tdir, { recursive: true });
    fs.writeFileSync(path.join(tdir, "x.json"), JSON.stringify({ id: "x", status: "running", startTime: Date.now() - 2000, name: "gone", pid: 999_999_999 }));
    const p = mod.PaneResume.start(q.init(mod, { reason, delayMs: 10, runsDir: q.runs, uptimeS: () => 3600, hcGet: async () => "error" }));
    await wait(120);
    assert.equal(q.sent.length, expected ? 1 : 0, reason);
    p?.stop("quit");
  }
});
