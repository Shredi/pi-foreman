// Lessons (reports.ts claimLessons, reportstool.ts): `set done` with a lesson appends it to lessons.md and emits `foreman:lesson` once; the CLI appends only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realPath } from "../workspacekey.ts";
import { main, type ReportsDeps } from "../reports-cli.ts";
import { LESSON_EVENT, claimLessons, readRows, recordReport, setState, storeFor, type Lesson, type Writer } from "../reports.ts";
import { emitPendingLessons, runReports, type ReportSession } from "../reportstool.ts";

function tmp(t: { after(fn: () => void): void }): string {
  const dir = realPath(fs.mkdtempSync(path.join(os.tmpdir(), "pf-lessons-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const w = (cwd: string, session: string): Writer => ({ cwd, role: "foreman", session, runId: null, source: "agent", repo: null, workspace: null, branch: null });
const rep = (subject: string) => ({ kind: "rule", subject, what: "a raw finding text that must stay in the store", effect: "blocked" });
const key = (cwd: string): string => {
  const r = readRows(storeFor(cwd).file).find((x) => x.row === "report");
  return String(r?.key);
};

function session(cwd: string, events: { event: string; payload: Lesson }[], over: Partial<ReportSession> = {}): ReportSession {
  return { cwd, isChild: false, id: "s", foremanSession: "s", role: "foreman", launchId: null, enabled: true, expireDays: undefined, workspaceOverride: null, repo: "o/n", emit: (event, payload) => void events.push({ event, payload }), ...over };
}
const setDone = (s: ReportSession, k: string, extra: Record<string, unknown> = {}) => runReports(s, { action: "set", key: k, state: "done", pr: 7, ...extra });

test("a lesson is appended to lessons.md and emitted once with {text, group, repo, pr}", (t) => {
  const dir = tmp(t);
  recordReport(w(dir, "a"), rep("alpha"));
  const events: { event: string; payload: Lesson }[] = [];
  const r = setDone(session(dir, events), key(dir), { lesson: "Check the lock age first." });
  assert.equal(r.isError, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, LESSON_EVENT);
  assert.deepEqual({ ...events[0].payload, id: undefined }, { id: undefined, text: "Check the lock age first.", group: "alpha", repo: "o/n", pr: 7 });
  assert.match(fs.readFileSync(storeFor(dir).lessons, "utf8"), /\[alpha\] Check the lock age first\. \(PR #7\)/);
  assert.equal(emitPendingLessons(session(dir, events)), 0, "already emitted");
  assert.equal(events.length, 1);
});

test("without a lesson nothing is emitted and no lessons file appears", (t) => {
  const dir = tmp(t);
  recordReport(w(dir, "a"), rep("alpha"));
  const events: { event: string; payload: Lesson }[] = [];
  setDone(session(dir, events), key(dir));
  assert.equal(events.length, 0);
  assert.equal(fs.existsSync(storeFor(dir).lessons), false);
});

test("a lesson without state done is refused", (t) => {
  const dir = tmp(t);
  recordReport(w(dir, "a"), rep("alpha"));
  const r = runReports(session(dir, []), { action: "set", key: key(dir), state: "dropped", reason: "x", lesson: "no" });
  assert.equal(r.isError, true);
});

test("two sessions and a restart emit a lesson once", (t) => {
  const dir = tmp(t);
  recordReport(w(dir, "a"), rep("alpha"));
  const k = key(dir);
  const store = storeFor(dir);
  // a crash between the append and the emit: the lesson row exists, the emitted row does not
  assert.equal(setState(store, k, { state: "done", pr: 7, lesson: "Lasting." }, "test").ok, true);
  const a: { event: string; payload: Lesson }[] = [];
  const b: { event: string; payload: Lesson }[] = [];
  assert.equal(emitPendingLessons(session(dir, a)), 1);
  assert.equal(emitPendingLessons(session(dir, b)), 0);
  assert.equal(a.length + b.length, 1);
  assert.equal(claimLessons(store).length, 0);
});

test("the CLI appends the lesson, a main session start emits it once", async (t) => {
  const dir = tmp(t);
  recordReport(w(dir, "a"), rep("alpha"));
  let out = "";
  const deps = (): ReportsDeps => ({ cwd: dir, now: Date.now, expireDays: async () => undefined });
  const code = await main(["set", key(dir), "done", "--pr", "3", "--lesson", "From the shell."], (s) => (out += s), () => undefined, deps);
  assert.equal(code, 0);
  assert.match(out, /lesson kept/);
  assert.match(fs.readFileSync(storeFor(dir).lessons, "utf8"), /From the shell\./);
  const events: { event: string; payload: Lesson }[] = [];
  assert.equal(emitPendingLessons(session(dir, events)), 1);
  assert.equal(events[0].payload.pr, 3);
  assert.equal(emitPendingLessons(session(dir, events)), 0);
  assert.equal(await main(["set", key(dir), "open", "--lesson", "x"], () => undefined, () => undefined, deps), 1, "a lesson needs done");
});

test("a child or a disabled feature emits nothing at start", (t) => {
  const dir = tmp(t);
  recordReport(w(dir, "a"), rep("alpha"));
  setDone(session(dir, [], { emit: undefined }), key(dir), { lesson: "Kept." });
  const events: { event: string; payload: Lesson }[] = [];
  assert.equal(emitPendingLessons(session(dir, events, { isChild: true })), 0);
  assert.equal(emitPendingLessons(session(dir, events, { enabled: false })), 0);
  assert.equal(events.length, 0);
});

test("lesson text is masked and scrubbed like report text", (t) => {
  const dir = tmp(t);
  recordReport(w(dir, "a"), rep("alpha"));
  const events: { event: string; payload: Lesson }[] = [];
  setDone(session(dir, events), key(dir), { lesson: "Look at /home/someone/work/file.ts with token=abcd1234secret99 set" });
  const text = events[0].payload.text;
  assert.ok(!text.includes("/home/someone"), text);
  assert.ok(text.includes("file.ts"), text);
  assert.ok(!text.includes("abcd1234secret99"), text);
  assert.ok(!fs.readFileSync(storeFor(dir).lessons, "utf8").includes("abcd1234secret99"));
});

test("a listener that throws does not break set, and the lesson counts as emitted", (t) => {
  const dir = tmp(t);
  recordReport(w(dir, "a"), rep("alpha"));
  const r = setDone(session(dir, [], { emit: () => { throw new Error("listener"); } }), key(dir), { lesson: "Kept." });
  assert.equal(r.isError, false);
  assert.match(r.text, /is now done/);
  assert.equal(claimLessons(storeFor(dir)).length, 0);
});

test("raw findings never leave through the event", (t) => {
  const dir = tmp(t);
  recordReport(w(dir, "a"), rep("alpha"));
  recordReport(w(dir, "b"), rep("alpha"));
  const events: { event: string; payload: Lesson }[] = [];
  setDone(session(dir, events), key(dir), { lesson: "Kept." });
  assert.deepEqual(Object.keys(events[0].payload).sort(), ["group", "id", "pr", "repo", "text"]);
  assert.ok(!JSON.stringify(events).includes("raw finding"));
});
