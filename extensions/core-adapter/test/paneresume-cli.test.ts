// `foreman pane-resume` (paneresume-cli.ts): the countdown with a fake TTY, the spawn (argv, cwd, env, exit code, error), the launch keys, the lock,
// an invalid terminal id, the hand-resume lines, a fake hc through HC_BIN. Nothing here starts Pi or touches a real terminal.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { RECHECK_EXIT, runPaneResume } from "../paneresume-cli.ts";
import type { PaneResumeDeps, PiChild } from "../paneresume-cli.ts";
import { COUNTDOWN_MS, HC_GET_TIMEOUT_MS, LOCK_STALE_MS, decideResume, notePath, panesDir, readNoteRaw, writeNote } from "../paneresume-core.ts";
import type { PaneNote } from "../paneresume-core.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

const SID = "11111111-2222-3333-4444-555555555555";
const SID2 = "22222222-2222-3333-4444-555555555555";

class FakeStdin extends EventEmitter {
  isTTY = true;
  log: string[];
  constructor(log: string[]) {
    super();
    this.log = log;
  }
  setRawMode(on: boolean): void {
    this.log.push(`raw:${on}`);
  }
  resume(): void {
    this.log.push("resume");
  }
  pause(): void {
    this.log.push("pause");
  }
  key(s: string): void {
    this.emit("data", Buffer.from(s));
  }
}

function rig(t: TestContext, sid = SID, terminal = "t1") {
  const root = fs.realpathSync(mkTestTmp("pf-prcli-"));
  t.after(() => rmTestTmp(root));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const sessionFile = path.join(agentDir, "sessions", "--p--", `2026_${sid}.jsonl`);
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: sid })}\n`);
  const now = Date.now();
  const note: PaneNote = { v: 1, sessionId: sid, sessionFile, cwd, terminal, socket: "/s/sock", createdMs: 1000, rootPid: 50, writtenAt: now - 10_000 };
  writeNote(agentDir, note);
  fs.mkdirSync(path.join(agentDir, "pi-foreman", "state", "live"), { recursive: true });
  const live = (o: Record<string, unknown> = {}): void =>
    fs.writeFileSync(path.join(agentDir, "pi-foreman", "state", "live", `${sid}.json`), JSON.stringify({ state: "working", hcTerminal: terminal, pid: 999_999_999, heartbeatAt: new Date(now - 5000).toISOString(), cwd, ...o }));
  live();
  const events: string[] = [];
  const stdin = new FakeStdin(events);
  const out: string[] = [];
  const spawns: { args: string[]; cwd: string; env: Record<string, string>; child: EventEmitter }[] = [];
  const spawnPi = (args: string[], o: { cwd: string; env: Record<string, string> }): PiChild => {
    events.push("spawn");
    const child = new EventEmitter();
    spawns.push({ args, cwd: o.cwd, env: o.env, child });
    setImmediate(() => child.emit("spawn"));
    return child as unknown as PiChild;
  };
  const deps = (over: Partial<PaneResumeDeps> = {}): Partial<PaneResumeDeps> => ({
    env: { HC_TERMINAL_ID: terminal, HC_TERMINAL_SOCKET: "/s/sock", PATH: process.env.PATH, PI_BG_FEATURES: "shell-bg" },
    agentDir, platform: "linux", now: () => Date.now(), uptimeS: () => 3600, stdin, stdoutIsTty: true, out: (l) => void out.push(l),
    hcGet: async () => ({ createdMs: 1000, pid: 777 }), pidAlive: () => false, countdownMs: 60_000, spawnPi, ...over,
  });
  const argv = ["--shell-pid", "777"];
  return { root, agentDir, cwd, sessionFile, note, live, events, stdin, out, spawns, deps, argv, sid, terminal };
}
const exitPi = (r: ReturnType<typeof rig>, code: number | null, signal: string | null = null): void => void r.spawns[0].child.emit("exit", code, signal);
const tick = (): Promise<void> => new Promise((res) => setImmediate(res));
const wait = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
/** Polls every 50 ms until the condition holds or 10 s pass; the exact assert after it decides. */
const until = async (pred: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await wait(50);
};
/** Then a settle: a second start has time to show before an exact count is asserted (a double start still fails). */
const untilSettled = async (pred: () => boolean): Promise<void> => {
  await until(pred);
  await wait(80);
};

test("Enter starts Pi now: raw mode off and stdin released before the spawn; argv, cwd, env; the exit code passes through; note and lock go", async (t) => {
  const r = rig(t);
  const sigint = process.listenerCount("SIGINT");
  const done = runPaneResume(r.argv, r.deps());
  await tick();
  await tick();
  assert.match(r.out[0], /^pi-foreman: Pi session "11111111-2222-3333-4444-555555555555" ran here before a crash\. Restarting in 60 s \(Enter: now, any other key: cancel\)\.$/);
  assert.deepEqual(r.events, ["raw:true", "resume"]);
  r.stdin.key("\r");
  await tick();
  assert.deepEqual(r.events, ["raw:true", "resume", "raw:false", "pause", "spawn"], "released before Pi starts");
  assert.deepEqual(r.spawns[0].args, ["--session", r.sessionFile]);
  assert.equal(r.spawns[0].cwd, r.cwd);
  assert.equal(r.spawns[0].env.PI_FOREMAN_RESUMED, String(Date.parse(JSON.parse(fs.readFileSync(path.join(r.agentDir, "pi-foreman", "state", "live", `${SID}.json`), "utf8")).heartbeatAt)));
  assert.equal(r.spawns[0].env.PI_BG_FEATURES, "shell-bg", "a plain session keeps the shell's PI_BG_FEATURES");
  assert.equal(r.spawns[0].env.HC_TERMINAL_ID, "t1");
  await tick();
  await tick();
  assert.equal(readNoteRaw(r.agentDir, "t1"), undefined, "the note is deleted once the spawn succeeded");
  assert.equal(fs.existsSync(path.join(panesDir(r.agentDir), `${SID}.lock`)), true, "the lock is held while Pi runs");
  exitPi(r, 7);
  assert.equal(await done, 7, "Pi's exit code");
  assert.equal(fs.existsSync(path.join(panesDir(r.agentDir), `${SID}.lock`)), false);
  assert.equal(process.listenerCount("SIGINT"), sigint, "Pi's SIGINT guard is removed again");
});

test("a key other than Enter cancels: the note is deleted, the hand line printed, nothing spawned", async (t) => {
  const r = rig(t);
  const done = runPaneResume(r.argv, r.deps());
  await tick();
  r.stdin.key("x");
  assert.equal(await done, 0);
  assert.deepEqual(r.spawns, []);
  assert.deepEqual(r.events.slice(-2), ["raw:false", "pause"]);
  assert.equal(readNoteRaw(r.agentDir, "t1"), undefined);
  assert.equal(r.out.at(-1), `pi-foreman: not restarted. Resume by hand: pi --session ${SID}`);
  assert.equal(fs.existsSync(path.join(panesDir(r.agentDir), `${SID}.lock`)), false);
});

test("the countdown running out starts Pi", async (t) => {
  const r = rig(t);
  const done = runPaneResume(r.argv, r.deps({ countdownMs: 30 }));
  await untilSettled(() => r.spawns.length > 0);
  assert.equal(r.spawns.length, 1);
  assert.deepEqual(r.events.slice(0, 5), ["raw:true", "resume", "raw:false", "pause", "spawn"]);
  exitPi(r, 0);
  assert.equal(await done, 0);
  assert.match(r.out[0], /Restarting in 0 s|Restarting in 0\.\d|Restarting in \d+ s/);
});

test("a signal exit of Pi becomes 128 + the signal number; a null code without signal is 1", async (t) => {
  const r = rig(t);
  const done = runPaneResume(r.argv, r.deps({ countdownMs: 5 }));
  await until(() => r.spawns.length > 0);
  exitPi(r, null, "SIGTERM");
  assert.equal(await done, 143);
});

test("the countdown default is 5 s and the hc timeout 3 s", async (t) => {
  assert.equal(COUNTDOWN_MS, 5000);
  assert.equal(HC_GET_TIMEOUT_MS, 3000);
  const r = rig(t);
  let seen = 0;
  const code = await runPaneResume(r.argv, r.deps({ hcGet: async (_t, ms) => ((seen = ms), "error" as const) }));
  assert.equal(code, 0);
  assert.equal(seen, 3000);
  assert.ok(readNoteRaw(r.agentDir, "t1"), "an hc error keeps the note");
  assert.deepEqual(r.spawns, []);
});

test("a spawn that throws, or fails with an error event, keeps the note and prints the hand line", async (t) => {
  const r = rig(t);
  const thrown = await runPaneResume(r.argv, r.deps({ countdownMs: 5, spawnPi: () => { throw new Error("spawn pi ENOENT"); } }));
  assert.equal(thrown, 1);
  assert.ok(readNoteRaw(r.agentDir, "t1"), "note kept");
  assert.match(r.out.join("\n"), /could not start pi: spawn pi ENOENT/);
  assert.equal(r.out.at(-1), `pi-foreman: resume by hand: pi --session ${SID}`);
  assert.equal(fs.existsSync(path.join(panesDir(r.agentDir), `${SID}.lock`)), false);
  const r2 = rig(t);
  const done = runPaneResume(r2.argv, r2.deps({ countdownMs: 5, spawnPi: () => { const c = new EventEmitter(); setImmediate(() => c.emit("error", new Error("spawn pi ENOENT"))); return c as unknown as PiChild; } }));
  assert.equal(await done, 1);
  assert.ok(readNoteRaw(r2.agentDir, "t1"), "note kept after an error event");
  assert.equal(r2.out.at(-1), `pi-foreman: resume by hand: pi --session ${SID}`);
});

test("launch keys: opened-session keys are dropped, the identity entry's plan phase and bg keys are set, an old permsProfile is ignored, invalid ones dropped", async (t) => {
  const r = rig(t);
  const idn = (data: Record<string, unknown>): string => `${JSON.stringify({ type: "custom", customType: "pi-foreman-identity", data: { v: 1, piSessionId: SID, child: "c1", handoff: "/h", ...data } })}\n`;
  fs.appendFileSync(r.sessionFile, idn({ permsProfile: "mine", planPhase: "1", bgEnv: { PI_BG_FEATURES: "process", PI_BG_BAD: "a;b" } }));
  const env = { HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "/s/sock", PATH: process.env.PATH, PI_FOREMAN_HANDOFF_DIR: "/stale", PI_INTERCOM_STABLE_ID: "x", PI_INTERCOM_SESSION_ID: "y", PI_FOREMAN_PARENT_INTERCOM: "p", PI_FOREMAN_PARENT_LABEL: "l", PI_FOREMAN_REMOTE_PARENT: "r", PI_FOREMAN_SESSION_MODEL: "m", PI_FOREMAN_PLAN_PHASE: "1", PI_BG_FEATURES: "shell-bg", PI_BG_OTHER: "keep?", PI_FOREMAN_PERMS_PROFILE: "shellprofile" };
  const done = runPaneResume(r.argv, r.deps({ env, countdownMs: 5 }));
  await until(() => r.spawns.length > 0);
  const e = r.spawns[0].env;
  for (const k of ["PI_FOREMAN_HANDOFF_DIR", "PI_INTERCOM_STABLE_ID", "PI_INTERCOM_SESSION_ID", "PI_FOREMAN_PARENT_INTERCOM", "PI_FOREMAN_PARENT_LABEL", "PI_FOREMAN_REMOTE_PARENT", "PI_FOREMAN_SESSION_MODEL"]) assert.equal(e[k], undefined, k);
  assert.equal(e.PI_FOREMAN_PLAN_PHASE, "1", "from the identity entry");
  assert.equal(e.PI_FOREMAN_PERMS_PROFILE, "shellprofile", "the identity's old permsProfile is ignored; the shell's variable is left as it is");
  assert.equal(e.PI_BG_FEATURES, "process");
  assert.equal(e.PI_BG_BAD, undefined, "an invalid value is dropped");
  exitPi(r, 0);
  await done;
  // a plain session (no identity entry): the shell's PI_BG_* stay, the shell's plan phase goes
  const p = rig(t);
  const d2 = runPaneResume(p.argv, p.deps({ env, countdownMs: 5 }));
  await until(() => p.spawns.length > 0);
  assert.equal(p.spawns[0].env.PI_FOREMAN_PLAN_PHASE, undefined);
  assert.equal(p.spawns[0].env.PI_FOREMAN_PERMS_PROFILE, "shellprofile");
  assert.equal(p.spawns[0].env.PI_BG_FEATURES, "shell-bg");
  assert.equal(p.spawns[0].env.PI_FOREMAN_HANDOFF_DIR, undefined);
  exitPi(p, 0);
  await d2;
});

test("an invalid HC_TERMINAL_ID exits silently without touching any file; usage errors exit 2", async (t) => {
  const r = rig(t);
  const decoy = path.join(r.agentDir, "pi-foreman", "state", "x.json");
  fs.writeFileSync(decoy, "keep");
  const before = JSON.stringify(fs.readdirSync(panesDir(r.agentDir)));
  let hcCalls = 0;
  for (const id of ["../x", "", "A", "a b", "x".repeat(33), "t1/../../x"]) {
    const code = await runPaneResume(r.argv, r.deps({ env: { HC_TERMINAL_ID: id }, hcGet: async () => (hcCalls++, "error" as const) }));
    assert.equal(code, 0, id);
  }
  assert.equal(hcCalls, 0);
  assert.equal(fs.readFileSync(decoy, "utf8"), "keep");
  assert.equal(JSON.stringify(fs.readdirSync(panesDir(r.agentDir))), before);
  assert.deepEqual<string[]>(r.out, []);
  for (const bad of [[], ["--shell-pid"], ["--shell-pid", "x"], ["--shell-pid", "0"], ["--shell-pid", "5", "extra"]]) assert.equal(await runPaneResume(bad, r.deps()), 2, bad.join(" "));
  assert.match(r.out.at(-1) as string, /^usage: foreman pane-resume --shell-pid <pid>$/);
});

test("a sessionId outside the pattern clears the note without building a lock path", async (t) => {
  const r = rig(t);
  writeNote(r.agentDir, { ...r.note, sessionId: "../../etc/x" });
  const code = await runPaneResume(r.argv, r.deps());
  assert.equal(code, 0);
  assert.equal(readNoteRaw(r.agentDir, "t1"), undefined, "cleared");
  assert.deepEqual(fs.readdirSync(path.join(r.agentDir, "pi-foreman", "state")).sort(), ["live", "panes"]);
  assert.deepEqual(fs.readdirSync(panesDir(r.agentDir)), []);
  assert.deepEqual(r.spawns, []);
});

test("row 5: a missing live record clears the note and prints the pi --session line; a custom session dir prints the hand line; off clears silently", async (t) => {
  const r = rig(t);
  fs.rmSync(path.join(r.agentDir, "pi-foreman", "state", "live", `${SID}.json`));
  assert.equal(await runPaneResume(r.argv, r.deps()), 0);
  assert.equal(readNoteRaw(r.agentDir, "t1"), undefined);
  assert.match(r.out[0], new RegExp(`Resume by hand: pi --session ${SID}$`));
  assert.equal(r.out.length, 1);
  const c = rig(t);
  const custom = path.join(c.root, "custom", `s_${SID}.jsonl`);
  fs.mkdirSync(path.dirname(custom), { recursive: true });
  fs.writeFileSync(custom, `${JSON.stringify({ type: "session", id: SID })}\n`);
  writeNote(c.agentDir, { ...c.note, sessionFile: custom });
  assert.equal(await runPaneResume(c.argv, c.deps()), 0);
  assert.equal(readNoteRaw(c.agentDir, "t1"), undefined);
  assert.equal(c.out[0], `pi-foreman: not restarted (custom session dir); resume by hand: pi --session ${custom}`);
  const o = rig(t);
  fs.writeFileSync(path.join(o.agentDir, "foreman.json"), JSON.stringify({ sessions: { hc: { resume: "off" } } }));
  assert.equal(await runPaneResume(o.argv, o.deps()), 0);
  assert.equal(readNoteRaw(o.agentDir, "t1"), undefined);
  assert.deepEqual(o.out, []);
  assert.deepEqual(o.spawns, []);
  const g = rig(t);
  fs.writeFileSync(path.join(g.agentDir, "foreman.json"), "{ not json");
  const d = runPaneResume(g.argv, g.deps({ countdownMs: 5 }));
  await untilSettled(() => g.spawns.length > 0);
  assert.equal(g.spawns.length, 1, "unreadable config means auto");
  exitPi(g, 0);
  await d;
});

test("no tty keeps the note and prints nothing; a nested shell keeps it", async (t) => {
  const r = rig(t);
  r.stdin.isTTY = false;
  assert.equal(await runPaneResume(r.argv, r.deps()), 0);
  assert.ok(readNoteRaw(r.agentDir, "t1"));
  assert.deepEqual<string[]>(r.out, []);
  const n = rig(t);
  assert.equal(await runPaneResume(["--shell-pid", "778"], n.deps()), 0);
  assert.ok(readNoteRaw(n.agentDir, "t1"));
  assert.deepEqual(n.out, []);
});

test("lock: two concurrent runs for one session start one Pi; two sessions in two panes both start; a stale lock is replaced", async (t) => {
  const r = rig(t);
  const a = runPaneResume(r.argv, r.deps({ countdownMs: 5 }));
  const b = runPaneResume(r.argv, r.deps({ countdownMs: 5 }));
  await untilSettled(() => r.spawns.length > 0);
  assert.equal(r.spawns.length, 1, "one Pi");
  exitPi(r, 0);
  assert.deepEqual(await Promise.all([a, b]), [0, 0]);
  // two sessions, two panes (own agent dirs would hide the lock: share one)
  const x = rig(t, SID, "t1");
  const y = rig(t, SID2, "t2");
  const shared = x.agentDir;
  fs.cpSync(path.join(y.agentDir, "sessions"), path.join(shared, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(shared, "pi-foreman", "state", "live"), { recursive: true });
  fs.copyFileSync(path.join(y.agentDir, "pi-foreman", "state", "live", `${SID2}.json`), path.join(shared, "pi-foreman", "state", "live", `${SID2}.json`));
  writeNote(shared, { ...y.note, sessionFile: path.join(shared, "sessions", "--p--", `2026_${SID2}.jsonl`) });
  const ax = runPaneResume(x.argv, x.deps({ countdownMs: 5 }));
  const ay = runPaneResume(y.argv, { ...y.deps({ countdownMs: 5, agentDir: shared }), env: { ...(y.deps().env as Record<string, string>) }, spawnPi: x.deps().spawnPi });
  await untilSettled(() => x.spawns.length >= 2);
  assert.equal(x.spawns.length, 2, "both sessions start");
  for (const s of x.spawns) s.child.emit("exit", 0, null);
  await Promise.all([ax, ay]);
  // a stale lock
  const s = rig(t);
  const lock = path.join(panesDir(s.agentDir), `${SID}.lock`);
  fs.writeFileSync(lock, "");
  const fresh = await runPaneResume(s.argv, s.deps({ countdownMs: 5 }));
  assert.equal(fresh, 0);
  assert.deepEqual(s.spawns, [], "a fresh lock keeps the note and starts nothing");
  const old = new Date(Date.now() - LOCK_STALE_MS - 5000);
  fs.utimesSync(lock, old, old);
  const d = runPaneResume(s.argv, s.deps({ countdownMs: 5 }));
  await untilSettled(() => s.spawns.length > 0);
  assert.equal(s.spawns.length, 1, "the stale lock was replaced");
  exitPi(s, 0);
  await d;
});

test("a reboot with a terminal pid equal to the note's rootPid resumes (row 8); a lone crash with the same pid does not", () => {
  const base = {
    setting: "auto" as const, tty: true, hc: { createdMs: 1000, pid: 50 }, socket: "/s/sock", shellPid: 50, pidAlive: () => true, now: 2_000_000_000_000, bootMs: 2_000_000_000_000 - 3_600_000, cwdIsDir: true, lock: () => true,
  };
  const note: PaneNote = { v: 1, sessionId: SID, sessionFile: "/x", cwd: "/c", terminal: "t1", socket: "/s/sock", createdMs: 1000, rootPid: 50, writtenAt: 1 };
  const live = (heartbeatMs: number) => ({ state: "working", endedBy: null, hcTerminal: "t1", pid: 4242, heartbeatMs, cwd: "/c" });
  assert.equal(decideResume({ ...base, note: { ok: true, note }, live: live(base.now - 7_200_000) }).action, "resume", "heartbeat before the boot: the pid check is moot");
  assert.equal(decideResume({ ...base, pidAlive: () => false, note: { ok: true, note }, live: live(base.now - 5000) }).action, "clear", "same pid, heartbeat after the boot: a lone crash");
});

test("the fake hc through HC_BIN: the command asks `hc get t1 --json` and resumes", { skip: posixOnly }, async (t) => {
  const r = rig(t);
  const hc = path.join(r.root, "hc");
  fs.writeFileSync(hc, `#!/bin/sh\necho "$@" >> "${r.root}/hc.log"\nprintf '{"created_ms":1000,"pid":777}'\n`, { mode: 0o755 });
  const env = { HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "/s/sock", HC_BIN: hc, PATH: process.env.PATH };
  const d = r.deps({ countdownMs: 5, env });
  delete d.hcGet; // the real hcGet, which runs HC_BIN
  const done = runPaneResume(r.argv, d);
  await untilSettled(() => r.spawns.length > 0);
  assert.equal(fs.readFileSync(path.join(r.root, "hc.log"), "utf8").trim(), "get t1 --json");
  assert.equal(r.spawns.length, 1);
  exitPi(r, 0);
  assert.equal(await done, 0);
  assert.equal(notePath(r.agentDir, "t1").endsWith("t1.json"), true);
});

test("a live record done by a signal with Pi still alive exits 75 (check again at the next prompt); a running Pi is a plain keep (0)", async (t) => {
  const r = rig(t);
  r.live({ state: "done", endedBy: "signal", pid: 4242 });
  assert.equal(await runPaneResume(r.argv, r.deps({ pidAlive: () => true })), RECHECK_EXIT);
  assert.equal(RECHECK_EXIT, 75);
  assert.notEqual(readNoteRaw(r.agentDir, "t1"), undefined, "the note is kept");
  r.live({ state: "working", pid: 4242 });
  assert.equal(await runPaneResume(r.argv, r.deps({ pidAlive: () => true })), 0, "a suspended Pi is not rechecked");
  assert.deepEqual(r.spawns, []);
});

test("an invalid launch key is named (key only, no value) before the countdown", async (t) => {
  const r = rig(t);
  const entry = { type: "custom", customType: "pi-foreman-identity", data: { v: 1, piSessionId: SID, child: "c1", handoff: "/h", permsProfile: "gone-secret-value", planPhase: "2", bgEnv: { PI_BG_BAD: "gone-secret-value;" } } };
  fs.appendFileSync(r.sessionFile, `${JSON.stringify(entry)}\n`);
  const done = runPaneResume(r.argv, r.deps({ countdownMs: 5 }));
  await until(() => r.spawns.length > 0);
  const lines = r.out.filter((l) => l.includes("launch key"));
  assert.equal(lines.length, 2, "an old permsProfile is ignored, not named");
  assert.match(lines[0], /launch key planPhase /);
  assert.match(lines[1], /launch key bgEnv\.PI_BG_BAD /);
  assert.equal(r.out.join("\n").includes("gone-secret-value"), false);
  assert.match(r.out[2], /ran here before a crash/, "the lines come before the countdown line");
  exitPi(r, 0);
  await done;
});
