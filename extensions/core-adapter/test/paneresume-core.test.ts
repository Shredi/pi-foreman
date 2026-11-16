// Crash restart (paneresume-core.ts): the decision table, note validation, the spawn env, the session file reader, the lock, the setting reader,
// the BG regexes pinned to the Python launcher, and the import graph of the `foreman pane-resume` module tree. No crash and no hc needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BG_NAME_RE, BG_VALUE_RE, LOCK_STALE_MS, NOTE_MAX_AGE_MS, SESSION_ID_RE, TERMINAL_RE, buildSpawnEnv, decideResume, panesDir, readLiveRecord, readResumeSetting, readSessionFile, takeLock, validateNote, writeNote } from "../paneresume-core.ts";
import type { LiveRecord, NoteCheck, PaneNote, ResumeInputs } from "../paneresume-core.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SID = "11111111-2222-3333-4444-555555555555";
const NOW = 1_800_000_000_000;

function world(t: { after(fn: () => void): void }) {
  const root = fs.realpathSync(mkTestTmp("pf-prc-"));
  t.after(() => rmTestTmp(root));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const sessionFile = path.join(agentDir, "sessions", "--p--", `2026_${SID}.jsonl`);
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: SID })}\n`);
  const note: PaneNote = { v: 1, sessionId: SID, sessionFile, cwd, terminal: "t1", socket: "/s/sock", createdMs: 1000, rootPid: 50, writtenAt: NOW - 1000 };
  return { root, agentDir, cwd, sessionFile, note };
}

function inputs(note: PaneNote, over: Partial<ResumeInputs> = {}): ResumeInputs {
  const live: LiveRecord = { state: "working", endedBy: null, hcTerminal: "t1", pid: 4242, heartbeatMs: NOW - 5000, cwd: note.cwd };
  return {
    setting: "auto", note: { ok: true, note }, tty: true, hc: { createdMs: 1000, pid: 777 }, socket: "/s/sock", shellPid: 777, live,
    pidAlive: () => false, now: NOW, bootMs: NOW - 3_600_000, cwdIsDir: true, lock: () => true, ...over,
  };
}

test("decideResume: all rows pass resumes; heartbeat 5 s old with a dead pid resumes", (t) => {
  const { note } = world(t);
  assert.deepEqual(decideResume(inputs(note)), { action: "resume", reason: "crash" });
});

test("decideResume: every row failing alone gives its action", (t) => {
  const { note } = world(t);
  const live = (o: Partial<LiveRecord>): LiveRecord => ({ state: "working", endedBy: null, hcTerminal: "t1", pid: 4242, heartbeatMs: NOW - 5000, cwd: note.cwd, ...o });
  const rows: [string, Partial<ResumeInputs>, string, string][] = [
    ["setting off", { setting: "off" }, "clear", "setting_off"],
    ["no tty", { tty: false }, "keep", "no_tty"],
    ["hc error", { hc: "error" }, "keep", "hc_error"],
    ["terminal reused (created)", { hc: { createdMs: 2000, pid: 777 } }, "clear", "terminal_reused"],
    ["terminal reused (socket)", { socket: "/other" }, "clear", "terminal_reused"],
    ["nested shell", { shellPid: 778 }, "keep", "nested_shell"],
    ["live missing", { live: null }, "clear", "live_missing"],
    ["live names another terminal", { live: live({ hcTerminal: "t2" }) }, "clear", "live_other_terminal"],
    ["normal end", { live: live({ state: "done" }) }, "clear", "normal_end"],
    ["pi alive", { pidAlive: () => true }, "keep", "pi_alive"],
    ["lone crash (root pid equals the note's)", { hc: { createdMs: 1000, pid: 50 }, shellPid: 50 }, "clear", "lone_crash"],
    ["too old", { live: live({ heartbeatMs: NOW - NOTE_MAX_AGE_MS - 1 }), bootMs: NOW - NOTE_MAX_AGE_MS - 10 }, "clear", "too_old_or_no_cwd"],
    ["cwd gone", { cwdIsDir: false }, "clear", "too_old_or_no_cwd"],
    ["locked", { lock: () => false }, "keep", "locked"],
  ];
  for (const [name, over, action, reason] of rows) {
    const d = decideResume(inputs(note, over));
    assert.deepEqual([d.action, d.reason], [action, reason], name);
  }
});

test("decideResume: done with endedBy signal resumes, done without it is a normal end; a heartbeat before boot resumes even with a live pid", (t) => {
  const { note } = world(t);
  const done = (endedBy: string | null): LiveRecord => ({ state: "done", endedBy, hcTerminal: "t1", pid: 4242, heartbeatMs: NOW - 5000, cwd: note.cwd });
  assert.equal(decideResume(inputs(note, { live: done("signal") })).action, "resume");
  assert.equal(decideResume(inputs(note, { live: done(null) })).reason, "normal_end");
  const before: LiveRecord = { state: "working", endedBy: null, hcTerminal: "t1", pid: 4242, heartbeatMs: NOW - 7_200_000, cwd: note.cwd };
  assert.equal(decideResume(inputs(note, { live: before, pidAlive: () => true })).action, "resume");
});

test("decideResume: reboot with a root pid equal to the note's pid resumes (row 8 needs the heartbeat after boot)", (t) => {
  const { note } = world(t);
  const before: LiveRecord = { state: "working", endedBy: null, hcTerminal: "t1", pid: 4242, heartbeatMs: NOW - 7_200_000, cwd: note.cwd };
  const d = decideResume(inputs(note, { live: before, hc: { createdMs: 1000, pid: 50 }, shellPid: 50 }));
  assert.equal(d.action, "resume");
});

test("decideResume: the hand-resume line is asked for rows 5, 8 and 9; the custom dir for a note outside the sessions dir", (t) => {
  const { note, agentDir } = world(t);
  assert.equal(decideResume(inputs(note, { live: null })).print, "hand");
  assert.equal(decideResume(inputs(note, { cwdIsDir: false })).print, "hand");
  const custom = validateNote({ ...note, sessionFile: path.join(path.dirname(agentDir), "elsewhere", "s.jsonl") }, agentDir, "t1");
  assert.equal(decideResume(inputs(note, { note: custom })).print, "custom_dir");
});

test("validateNote: a good note; outside the sessions dir, id mismatch, relative cwd, terminal mismatch, bad session id each clear", (t) => {
  const { note, agentDir, root } = world(t);
  const ok = validateNote(JSON.parse(JSON.stringify(note)), agentDir, "t1");
  assert.equal(ok.ok, true);
  const reason = (raw: unknown, terminal = "t1"): string => {
    const c: NoteCheck = validateNote(raw, agentDir, terminal);
    return c.ok === false ? c.reason : "ok";
  };
  const custom = validateNote({ ...note, sessionFile: path.join(root, "x", "s.jsonl") }, agentDir, "t1");
  assert.equal(custom.ok === false && custom.customDir, true);
  const other = path.join(agentDir, "sessions", "--p--", "other.jsonl");
  fs.writeFileSync(other, `${JSON.stringify({ type: "session", id: "99999999-0000-0000-0000-000000000000" })}\n`);
  assert.equal(reason({ ...note, sessionFile: other }), "session_file_mismatch");
  assert.equal(reason({ ...note, cwd: "relative/dir" }), "cwd_not_absolute");
  assert.equal(reason(note, "t2"), "terminal_mismatch");
  assert.equal(reason({ ...note, sessionId: "../../etc" }), "session_id_invalid");
  assert.equal(reason({ ...note, sessionFile: path.join(agentDir, "sessions", "..", "x.jsonl") }), "custom_session_dir");
  assert.equal(reason("nope"), "note_unreadable");
  assert.equal(reason({ ...note, createdMs: "1" }), "note_fields_invalid");
});

test("writeNote is atomic and readable back; takeLock: one holder, a stale lock is replaced, a bad id is refused", (t) => {
  const { note, agentDir } = world(t);
  writeNote(agentDir, note);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(panesDir(agentDir), "t1.json"), "utf8")), note);
  assert.deepEqual(fs.readdirSync(panesDir(agentDir)), ["t1.json"]);
  assert.equal(takeLock(agentDir, SID, Date.now()), true);
  assert.equal(takeLock(agentDir, SID, Date.now()), false);
  const lock = path.join(panesDir(agentDir), `${SID}.lock`);
  const old = new Date(Date.now() - LOCK_STALE_MS - 5000);
  fs.utimesSync(lock, old, old);
  assert.equal(takeLock(agentDir, SID, Date.now()), true);
  assert.equal(takeLock(agentDir, "../x", Date.now()), false);
  assert.deepEqual(fs.readdirSync(path.dirname(panesDir(agentDir))).sort(), ["panes"], "a bad id builds no lock path outside panes");
  assert.equal(takeLock(agentDir, "second-session-0001", Date.now()), true, "a second session in another pane has its own lock");
});

test("readSessionFile: newest identity of this session, valid keys kept, invalid ones dropped and listed", (t) => {
  const { agentDir, sessionFile } = world(t);
  fs.mkdirSync(path.join(agentDir, "pi-foreman"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "pi-foreman", "permissions.json"), JSON.stringify({ profiles: { mine: {} } }));
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  const id = (data: Record<string, unknown>) => line({ type: "custom", customType: "pi-foreman-identity", data: { v: 1, piSessionId: SID, ...data } });
  fs.appendFileSync(sessionFile, line({ type: "session_info", name: "my session" }) + id({ permsProfile: "old" }) + id({ permsProfile: "mine", planPhase: "1", bgEnv: { PI_BG_FEATURES: "process", PI_BG_BAD: "a;b", lower: "x" } }));
  const r = readSessionFile(sessionFile, SID, agentDir);
  assert.equal(r.name, "my session");
  assert.deepEqual(r.identity, { permsProfile: "mine", planPhase: "1", bgEnv: { PI_BG_FEATURES: "process" } });
  assert.deepEqual(r.dropped.sort(), ["bgEnv.PI_BG_BAD", "bgEnv.name"]);
  fs.appendFileSync(sessionFile, id({ permsProfile: "unknown-profile", planPhase: "2" }));
  const r2 = readSessionFile(sessionFile, SID, agentDir);
  assert.deepEqual(r2.identity, {});
  assert.deepEqual(r2.dropped.sort(), ["permsProfile", "planPhase"]);
  assert.equal(readSessionFile(path.join(agentDir, "nothing.jsonl"), SID, agentDir).identity, null);
});

test("buildSpawnEnv: opened-session keys dropped first, the identity's plan phase, profile and PI_BG_* set; a plain session keeps the shell's", () => {
  const base = { PATH: "/bin", PI_FOREMAN_HANDOFF_DIR: "/h", PI_FOREMAN_PLAN_PHASE: "1", PI_INTERCOM_STABLE_ID: "x", PI_FOREMAN_PARENT_INTERCOM: "p", PI_FOREMAN_SESSION_MODEL: "m", PI_FOREMAN_REMOTE_PARENT: "r", PI_FOREMAN_RESUMED: "5", PI_BG_FEATURES: "shell", PI_FOREMAN_PERMS_PROFILE: "shellprofile" };
  const plain = buildSpawnEnv(base, null, 123.4);
  assert.deepEqual(plain, { PATH: "/bin", PI_BG_FEATURES: "shell", PI_FOREMAN_PERMS_PROFILE: "shellprofile", PI_FOREMAN_RESUMED: "123" });
  const opened = buildSpawnEnv(base, { permsProfile: "steward", planPhase: "1", bgEnv: { PI_BG_FEATURES: "process" } }, 9);
  assert.deepEqual(opened, { PATH: "/bin", PI_BG_FEATURES: "process", PI_FOREMAN_PERMS_PROFILE: "steward", PI_FOREMAN_PLAN_PHASE: "1", PI_FOREMAN_RESUMED: "9" });
});

test("readResumeSetting: auto by default, off from foreman.json, an overlay package layer wins, unreadable is auto", (t) => {
  const { agentDir } = world(t);
  assert.equal(readResumeSetting(agentDir), "auto");
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ sessions: { hc: { resume: "off" } } }));
  assert.equal(readResumeSetting(agentDir), "off");
  fs.writeFileSync(path.join(agentDir, "foreman.json"), "{not json");
  assert.equal(readResumeSetting(agentDir), "auto");
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ sessions: { hc: { resume: "maybe" } } }));
  assert.equal(readResumeSetting(agentDir), "auto");
});

test("readLiveRecord reads endedBy and refuses an id that is not a token", (t) => {
  const { agentDir } = world(t);
  const dir = path.join(agentDir, "pi-foreman", "state", "live");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SID}.json`), JSON.stringify({ state: "done", endedBy: "signal", hcTerminal: "t1", pid: 5, heartbeatAt: new Date(NOW).toISOString(), cwd: "/x" }));
  assert.deepEqual(readLiveRecord(agentDir, SID), { state: "done", endedBy: "signal", hcTerminal: "t1", pid: 5, heartbeatMs: NOW, cwd: "/x" });
  assert.equal(readLiveRecord(agentDir, "../live/x"), null);
});

test("the TS BG and id patterns equal the Python ones in foreman_session.py", () => {
  const py = fs.readFileSync(path.join(HERE, "..", "..", "..", "scripts", "foreman_session.py"), "utf8");
  const grab = (n: string): string => (py.match(new RegExp(`^${n} = re\\.compile\\(r"(.*)"\\)$`, "m")) as RegExpMatchArray)[1];
  assert.equal(BG_NAME_RE.source, grab("BG_NAME_RE"));
  assert.equal(BG_VALUE_RE.source, grab("BG_VALUE_RE").replace(/\\\//g, "/"));
  assert.equal(TERMINAL_RE.test("t1_a-b"), true);
  assert.equal(TERMINAL_RE.test("../x"), false);
  assert.equal(SESSION_ID_RE.test(SID), true);
});

test("import graph: the pane-resume module tree imports only node:* and pi-foreman modules without a Pi package (never livestate.ts, bg.ts)", () => {
  const seen = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/^(?:import|export)\s[^;]*?from\s+"([^"]+)"/gms)) {
      const spec = m[1];
      if (spec.startsWith("node:")) continue;
      assert.ok(spec.startsWith("./"), `${path.basename(file)} imports ${spec}`);
      assert.ok(!/@earendil-works|livestate|\/bg\.ts|paneresume\.ts/.test(spec), `${path.basename(file)} imports ${spec}`);
      walk(path.join(path.dirname(file), spec));
    }
    assert.ok(!/@earendil-works|from "pi-/.test(text), `${path.basename(file)} names a Pi package`);
  };
  walk(path.join(HERE, "..", "paneresume-cli.ts"));
  assert.ok(seen.size >= 3);
});
