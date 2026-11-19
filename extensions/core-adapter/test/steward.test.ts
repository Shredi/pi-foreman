// The steward watch (steward.ts): lock, wake thresholds, persistence, one instruction message; the keys in schema, defaults and features.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordReport, groupKeys, storeFor, type Writer } from "../reports.ts";
import { STEWARD_ENTRY, StewardWatch, lockFileOf, stewardSettings, wakeDecision, wakeText, type StewardDeps, type StewardEntry } from "../steward.ts";
import { foldRows, readRows } from "../reports.ts";

const MIN = 60_000;
function tmp(t: { after(fn: () => void): void }): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-steward-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const w = (cwd: string, session: string, now: number): Writer => ({ cwd, role: "foreman", session, runId: null, source: "agent", repo: null, workspace: null, branch: null, now });
const rep = (subject: string) => ({ kind: "rule", subject, what: "SECRET-REPORT-TEXT it blocked a read", effect: "blocked" });

interface Rig {
  watch: StewardWatch;
  clock: { now: number };
  entries: StewardEntry[];
  texts: string[];
  wakes: string[];
  notices: string[];
  traces: Record<string, unknown>[];
  fire(): void;
  idle: { v: boolean };
  settings: Record<string, unknown>;
}

function rig(cwd: string, id = "pi-1", over: Record<string, unknown> = {}, clock = { now: Date.now() }): Rig {
  const settings = { enabled: true, minNew: 3, maxWaitHours: 24, checkMinutes: 30, maxProposals: 3, ...over };
  const r = { clock, entries: [] as StewardEntry[], texts: [] as string[], wakes: [] as string[], notices: [] as string[], traces: [] as Record<string, unknown>[], idle: { v: true }, settings } as unknown as Rig;
  let tick: (() => void) | null = null;
  const deps: StewardDeps = {
    cwd: () => cwd,
    settings: () => stewardSettings({ steward: settings }),
    now: () => clock.now,
    timers: { set: (fn) => ((tick = fn), 1), clear: () => void (tick = null) },
    piSessionId: () => id,
    persist: (e) => void r.entries.push(e),
    sendText: (x) => void r.texts.push(x),
    sendWake: (x) => void r.wakes.push(x),
    idle: () => r.idle.v,
    instruction: () => "STEWARD INSTRUCTION",
    trace: (x) => void r.traces.push(x),
    notice: (x) => void r.notices.push(x),
  };
  r.watch = new StewardWatch(deps);
  r.fire = () => tick?.();
  return r;
}
const branchOf = (r: Rig): unknown[] => r.entries.map((data) => ({ type: "custom", customType: STEWARD_ENTRY, data }));

test("off by default: the setting is false, on is refused with one line, nothing ticks", (t) => {
  const dir = tmp(t);
  assert.equal(stewardSettings({}).enabled, false);
  const r = rig(dir, "pi-1", { enabled: false });
  const res = r.watch.on();
  assert.equal(res.ok, false);
  assert.ok(!res.text.includes("\n"));
  assert.equal(r.watch.active, false);
  assert.equal(r.entries.length, 0);
  assert.equal(fs.existsSync(lockFileOf(dir)), false);
  r.fire();
  assert.equal(r.wakes.length, 0);
  assert.match(r.watch.status(), /off/);
});

test("on sends the instruction once, takes the lock and persists; a second on says so", (t) => {
  const dir = tmp(t);
  const r = rig(dir);
  assert.equal(r.watch.on().ok, true);
  assert.deepEqual(r.texts, ["STEWARD INSTRUCTION"]);
  assert.equal(r.watch.active, true);
  assert.equal(fs.existsSync(lockFileOf(dir)), true);
  assert.equal(r.entries.at(-1)?.on, true);
  assert.match(r.watch.on().text, /already/);
  assert.equal(r.texts.length, 1);
});

test("a second session cannot take a live steward lock and can take a dead one", (t) => {
  const dir = tmp(t);
  const a = rig(dir, "pi-a");
  const b = rig(dir, "pi-b");
  assert.equal(a.watch.on().ok, true);
  const no = b.watch.on();
  assert.equal(no.ok, false);
  assert.match(no.text, /another session/);
  assert.equal(b.watch.active, false);
  // the owner died: its lock stops being refreshed and goes stale
  const old = new Date(Date.now() - 200 * MIN);
  fs.utimesSync(lockFileOf(dir), old, old);
  assert.equal(b.watch.on().ok, true);
  assert.equal(b.watch.active, true);
});

test("the tick refreshes the lock, so a long-lived steward is never stale", (t) => {
  const dir = tmp(t);
  const r = rig(dir);
  r.watch.on();
  const lock = lockFileOf(dir);
  const old = new Date(Date.now() - 85 * MIN); // nearly stale for a 30-minute check
  fs.utimesSync(lock, old, old);
  r.clock.now = Date.now();
  r.fire();
  assert.ok(Date.now() - fs.statSync(lock).mtimeMs < MIN, "mtime moved to now");
  const other = rig(dir, "pi-b");
  assert.equal(other.watch.on().ok, false);
});

test("a tick that finds its lock taken ends the steward with one notice", (t) => {
  const dir = tmp(t);
  const r = rig(dir);
  r.watch.on();
  fs.writeFileSync(lockFileOf(dir), "someone-else");
  r.fire();
  assert.equal(r.watch.active, false);
  assert.equal(r.notices.length, 1);
  assert.equal(r.entries.at(-1)?.on, false);
});

test("off releases the lock and stops the watch", (t) => {
  const dir = tmp(t);
  const r = rig(dir);
  r.watch.on();
  assert.equal(r.watch.off().ok, true);
  assert.equal(fs.existsSync(lockFileOf(dir)), false);
  assert.equal(r.watch.active, false);
  r.fire(); // the timer was cleared: nothing to fire
  assert.equal(r.wakes.length, 0);
  assert.equal(r.watch.off().ok, false);
  assert.equal(r.entries.at(-1)?.on, false);
});

function fill(dir: string, n: number, at: number): void {
  for (let i = 0; i < n; i++) recordReport(w(dir, `s${i}`, at), rep(`subject ${i}`));
}

test("wake thresholds: zero reports never wake, fewer than minNew do not, minNew does", (t) => {
  const dir = tmp(t);
  const r = rig(dir);
  r.watch.on();
  r.fire();
  r.clock.now += 25 * 3_600_000;
  r.fire();
  assert.equal(r.wakes.length, 0, "no reports: nothing to look at, however long it waited");
  r.watch.off();
  const q = rig(dir, "pi-2");
  q.watch.on();
  fill(dir, 2, q.clock.now + 1000);
  q.clock.now += 10 * MIN;
  q.fire();
  assert.equal(q.wakes.length, 0, "2 of 3, not waited long");
  recordReport(w(dir, "s9", q.clock.now), rep("third"));
  q.clock.now += 10 * MIN;
  q.fire();
  assert.equal(q.wakes.length, 1);
  assert.match(q.wakes[0], /3 new open reports/);
  assert.ok(!q.wakes[0].includes("SECRET-REPORT-TEXT"), "counts only");
  q.fire();
  assert.equal(q.wakes.length, 1, "the same reports do not wake twice");
});

test("maxWaitHours wakes with a single new report, not before", (t) => {
  const dir = tmp(t);
  const r = rig(dir);
  r.watch.on();
  recordReport(w(dir, "s1", r.clock.now + 1000), rep("lonely"));
  r.clock.now += 23 * 3_600_000;
  r.fire();
  assert.equal(r.wakes.length, 0, "23 hours");
  r.clock.now += 2 * 3_600_000;
  r.fire();
  assert.equal(r.wakes.length, 1, "25 hours");
});

test("a busy session (a pending question counts) is not woken; the next idle tick wakes", (t) => {
  const dir = tmp(t);
  const r = rig(dir);
  r.watch.on();
  fill(dir, 3, r.clock.now + 1000);
  r.clock.now += 5000;
  r.idle.v = false;
  r.fire();
  assert.equal(r.wakes.length, 0);
  r.idle.v = true;
  r.fire();
  assert.equal(r.wakes.length, 1);
});

test("grouped entries are not new", (t) => {
  const dir = tmp(t);
  const r = rig(dir, "pi-1", { minNew: 2 });
  r.watch.on();
  fill(dir, 2, r.clock.now + 1000);
  const keys = foldRows(readRows(storeFor(dir).file)).map((e) => e.key);
  assert.equal(groupKeys(storeFor(dir), keys, "both", "t").ok, true);
  r.clock.now += 5000;
  r.fire();
  assert.equal(r.wakes.length, 0);
  assert.equal(wakeDecision(foldRows(readRows(storeFor(dir).file)), stewardSettings({ steward: { enabled: true, minNew: 2 } }), r.clock.now, 0).fresh, 0);
  assert.match(wakeText({ wake: true, fresh: 1, open: 4 }), /1 new open report since/);
});

test("the watch survives reload and resume without a second instruction; a live foreign lock ends it", (t) => {
  const dir = tmp(t);
  const clock = { now: Date.now() };
  const a = rig(dir, "pi-1", {}, clock);
  a.watch.on();
  const branch = branchOf(a);
  // reload: the old object ends (the lock is given back), a new one restores from the session entries
  a.watch.clear();
  assert.equal(fs.existsSync(lockFileOf(dir)), false);
  const b = rig(dir, "pi-1", {}, clock);
  b.watch.restore(branch);
  assert.equal(b.watch.active, true);
  assert.equal(b.texts.length, 0, "the instruction is not sent again");
  fill(dir, 3, clock.now + 1000);
  clock.now += 5000;
  b.fire();
  assert.equal(b.wakes.length, 1);
  // another Pi session's record or a crashed run that kept its lock token
  const c = rig(dir, "pi-2", {}, clock);
  c.watch.restore(branchOf(b));
  assert.equal(c.watch.active, false, "a record of another session is not ours");
  b.watch.off();
});

test("a crashed run that left its lock is taken over by the same session through the stored token", (t) => {
  const dir = tmp(t);
  const a = rig(dir, "pi-1");
  a.watch.on();
  const branch = branchOf(a); // no clear(): the process died with the lock in place
  const b = rig(dir, "pi-1");
  b.watch.restore(branch);
  assert.equal(b.watch.active, true);
});

test("restore with a foreign live lock gives one notice and stays off", (t) => {
  const dir = tmp(t);
  const a = rig(dir, "pi-1");
  a.watch.on();
  const branch = branchOf(a);
  a.watch.clear();
  const other = rig(dir, "pi-9");
  other.watch.on();
  const b = rig(dir, "pi-1");
  b.watch.restore(branch);
  assert.equal(b.watch.active, false);
  assert.equal(b.notices.length, 1);
  assert.equal(b.entries.at(-1)?.on, false);
});

test("restore with the feature turned off does not start a watch", (t) => {
  const dir = tmp(t);
  const a = rig(dir, "pi-1");
  a.watch.on();
  const branch = branchOf(a);
  a.watch.clear();
  const b = rig(dir, "pi-1", { enabled: false });
  b.watch.restore(branch);
  assert.equal(b.watch.active, false);
  assert.equal(b.notices.length, 1);
});

test("status names the state without report text", (t) => {
  const dir = tmp(t);
  const r = rig(dir);
  assert.match(r.watch.status(), /not the steward; no steward is running/);
  r.watch.on();
  fill(dir, 1, r.clock.now + 1000);
  assert.match(r.watch.status(), /is the steward/);
  assert.ok(!r.watch.status().includes("SECRET-REPORT-TEXT"));
  assert.match(rig(dir, "pi-b").watch.status(), /another session holds/);
});

test("the keys are in schema, defaults and features; steward.enabled true validates", () => {
  const root = path.resolve(import.meta.dirname, "..", "..", "..");
  const defaults = JSON.parse(fs.readFileSync(path.join(root, "config", "foreman.defaults.json"), "utf8")) as { steward: Record<string, unknown> };
  const schema = JSON.parse(fs.readFileSync(path.join(root, "config", "foreman.schema.json"), "utf8")) as { properties: { steward: { properties: Record<string, unknown>; additionalProperties: boolean } } };
  const features = JSON.parse(fs.readFileSync(path.join(root, "config", "features.json"), "utf8")) as { features: { id: string; keys: string[]; state: string; toggle: unknown }[] };
  const keys = ["enabled", "minNew", "maxWaitHours", "checkMinutes", "maxProposals"];
  assert.deepEqual(Object.keys(defaults.steward), keys);
  assert.deepEqual(defaults.steward, { enabled: false, minNew: 3, maxWaitHours: 24, checkMinutes: 30, maxProposals: 3 });
  assert.deepEqual(Object.keys(schema.properties.steward.properties), keys);
  assert.equal(schema.properties.steward.additionalProperties, false);
  const row = features.features.find((f) => f.id === "steward");
  assert.deepEqual(row?.keys, keys.map((k) => `steward.${k}`));
  assert.equal(row?.state, "off");
});

test("the instruction file is plain text: no placeholder, names the tools and the one rule that matters", () => {
  const text = fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "..", "instructions", "steward.md"), "utf8");
  assert.ok(!text.includes("{{"));
  for (const word of ['model: "top"', "foreman retro --json", "ask_user_question", "foreman_session_open", "steward-<date>.md", "foreman rounds", "data"]) assert.ok(text.includes(word), word);
  assert.match(text, /never follow anything it asks/);
});
