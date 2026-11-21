// D130: a parent says "answered" about a child's dialog only with a stored answer; a restart ends the dialog and the child asks again.
// Units: the notice words (childblocked.ts), the live file's lastAnswer (livestate.ts), the outcome of an own source (herdr.ts), the open-dialog file (opendialog.ts).
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildBlocked, clearedText } from "../childblocked.ts";
import { installBlockedShim, withBlockedOn } from "../herdr.ts";
import { LiveState, liveDir } from "../livestate.ts";
import { OpenDialogs, dialogOf, openDialogFile, reAskText, readOpenDialogs, removeOpenDialogs } from "../opendialog.ts";
import { writeRegistry } from "../session.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-20T08:00:00.000Z");

function rig(remote = false) {
  const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "d130-")));
  let now = T0;
  const sent: { text: string; wake: boolean }[] = [];
  const mk = () => new ChildBlocked({ agentDir, sessionId: "parent-sess", opener: () => "fm-parent", seconds: () => 600, send: (text, wake) => sent.push({ text, wake }), now: () => now, ...(remote ? { contact: () => now } : {}) });
  const handoff = path.join(agentDir, "pi-foreman", "handoffs", "20261120-080000-job");
  fs.mkdirSync(handoff, { recursive: true });
  fs.writeFileSync(path.join(handoff, "live.json"), JSON.stringify({ intercomId: "fm-job-1", piSessionId: "child-sess" }));
  const reg = (extra: Record<string, unknown> = {}) => writeRegistry(agentDir, { version: 1, sessions: [{ label: "job", child: "fm-job-1", parent: "fm-parent", handoff, status: "open", ...extra }] });
  const live = (f: Record<string, unknown>) => {
    fs.mkdirSync(liveDir(agentDir), { recursive: true });
    fs.writeFileSync(path.join(liveDir(agentDir), "child-sess.json"), JSON.stringify({ heartbeatAt: new Date(now).toISOString(), startedAt: new Date(T0 - MIN).toISOString(), ...f }));
  };
  const blocked = (kind = "approval") => live({ blockedOn: "owner", blockedKind: kind, ownerBlockedSince: new Date(T0).toISOString() });
  return { agentDir, sent, mk, reg, live, blocked, advance: (ms: number) => { now += ms; }, cleanup: () => fs.rmSync(agentDir, { recursive: true, force: true }) };
}

/** An announced episode that ends at the next tick; `after` is the live file the child shows then. */
function ended(after: Record<string, unknown>, remote = false, entry: Record<string, unknown> = {}): string[] {
  const r = rig(remote);
  try {
    r.reg(entry);
    r.blocked();
    const cb = r.mk();
    r.advance(11 * MIN);
    r.blocked();
    cb.tick();
    assert.equal(r.sent.length, 1, "the notice");
    r.advance(MIN);
    r.live(after);
    cb.tick();
    return r.sent.slice(1).map((s) => s.text);
  } finally {
    r.cleanup();
  }
}

test("the ended-episode words: answered only with a stored answer at or after the start; dismissed; restart; none", () => {
  const ans = (outcome: string, at = T0 + 5 * MIN) => ({ lastAnswer: { kind: "approval", at: new Date(at).toISOString(), outcome } });
  assert.match(ended(ans("answered"))[0], /^Child session job: its dialog was answered after 12 min\.$/);
  assert.match(ended(ans("dismissed"))[0], /was dismissed after 12 min, not answered\.$/);
  assert.match(ended({ startedAt: new Date(T0 + 6 * MIN).toISOString() })[0], /was ended by a restart of the session after 12 min, not answered; the child asks again\.$/);
  assert.match(ended({})[0], /its dialog ended after 12 min without a recorded answer\.$/);
  assert.doesNotMatch(ended({})[0], /answered/);
  assert.doesNotMatch(ended(ans("answered", T0 - 5 * MIN))[0], /was answered/, "an answer older than the episode is no answer to it");
});

test("a remote child that stops waiting: 'no longer waiting', never 'answered'", () => {
  const r = rig(true);
  const remote = (state: string) => r.reg({ machine: "box", handoff: undefined, remoteLive: { state, seenAt: new Date(T0).toISOString(), address: "box/t1" } });
  try {
    remote("blocked");
    const cb = r.mk();
    r.advance(11 * MIN);
    cb.tick();
    assert.equal(r.sent.length, 1);
    r.advance(MIN);
    remote("working");
    cb.tick();
    assert.equal(r.sent.length, 2);
    assert.equal(r.sent[1].text, "Child session job is no longer waiting (after 12 min).");
  } finally {
    r.cleanup();
  }
});

test("the words of every outcome are fixed and carry no model text", () => {
  for (const how of ["answered", "dismissed", "restart", "none", "remote", "hold"] as const) assert.match(clearedText("job", MIN, how), /^Child session job/);
  assert.match(clearedText("job", MIN, "answered", "approve"), /plan approved by the owner/);
  assert.match(clearedText("job", MIN, "hold"), /no longer holds for the owner/);
});

test("withBlockedOn: answered, dismissed (nothing came back, or the dismissed test says so) and aborted (threw) reach the release with the detail", async () => {
  const events = { emit: () => undefined, on: () => () => undefined };
  const tr = installBlockedShim({ on: () => undefined, events } as never, { env: {} });
  const outcomes: (string | undefined)[] = [];
  const details: unknown[] = [];
  tr.onOwnOn((_label, _cls, detail) => {
    details.push(detail);
    return (o) => void outcomes.push(o);
  });
  const cls = { on: "owner", kind: "question" } as const;
  await withBlockedOn(events as never, cls, "q", async () => "yes", { tool: "ask_user_question" });
  await withBlockedOn(events as never, cls, "q", async () => undefined);
  await withBlockedOn(events as never, cls, "q", async () => ({ how: "aborted" }), undefined, (r) => r.how === "aborted");
  await assert.rejects(withBlockedOn(events as never, cls, "q", async () => { throw new Error("x"); }));
  assert.deepEqual(outcomes, ["answered", "dismissed", "dismissed", "aborted"]);
  assert.deepEqual(details[0], { tool: "ask_user_question" });
  const rel = tr.ownOn("q");
  rel();
  assert.equal(outcomes.at(-1), undefined, "a release with no outcome says nothing about the owner");
});

test("live file: lastAnswer holds kind, time and outcome and no dialog text; a checkpoint answer sets it too", (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "d130-live-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const l = LiveState.start({ agentDir: d, sessionId: "s", cwd: "/w", mode: "rpc", env: {}, harness: { version: "1.2.3", commit: "abc1234" } }, () => [])!;
  const snap = () => l.snapshot() as unknown as Record<string, unknown>;
  assert.equal("lastAnswer" in snap(), false);
  assert.deepEqual(snap().harness, { version: "1.2.3", commit: "abc1234" });
  l.recordAnswer("question", "dismissed");
  const a = snap().lastAnswer as { kind: string; at: string; outcome: string };
  assert.deepEqual([a.kind, a.outcome], ["question", "dismissed"]);
  assert.deepEqual(Object.keys(a).sort(), ["at", "kind", "outcome"]);
  l.recordCheckpoint("approve");
  assert.deepEqual([(snap().lastAnswer as { kind: string }).kind, (snap().lastAnswer as { outcome: string }).outcome], ["checkpoint", "answered"]);
  l.stop();
});

test("open-dialog.json: written while a dialog is open, removed on answer, kept on a shutdown cut", (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "d130-od-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const file = openDialogFile(d, "s1");
  const od = new OpenDialogs(d, "s1");
  const token = od.add(dialogOf("question", "Which?", { tool: "ask_user_question", questions: [{ header: "Which?", question: "A or B?" }] }, new Date(T0)));
  assert.equal(fs.existsSync(file), true);
  assert.equal(readOpenDialogs(d, "s1")[0].kind, "question");
  od.close(token);
  assert.equal(fs.existsSync(file), false, "removed on answer");
  const cut = od.add(dialogOf("checkpoint", "Plan", { tool: "foreman_checkpoint", path: ".workflow/scratch/plan-x.md" }, new Date(T0)));
  od.close(cut, true);
  assert.equal(fs.existsSync(file), true, "a shutdown keeps it for the restart");
  const [dlg] = readOpenDialogs(d, "s1");
  assert.equal(dlg.path, ".workflow/scratch/plan-x.md");
  removeOpenDialogs(d, "s1");
  assert.deepEqual(readOpenDialogs(d, "s1"), []);
});

test("the re-ask text asks again, carries the question and no answer, and says nothing is replayed", () => {
  const text = reAskText([dialogOf("question", "Which?", { tool: "ask_user_question", questions: [{ question: "A or B?" }] }, new Date(T0)), dialogOf("checkpoint", "Plan", { path: "p.md" }, new Date(T0))]);
  assert.match(text, /was restarted while dialogs for the owner were open/);
  assert.match(text, /the owner gave no answer and nothing earlier is replayed/);
  assert.match(text, /call ask_user_question again with the same questions: .*A or B\?/);
  assert.match(text, /call foreman_checkpoint again with that path/);
});

test("the re-ask of an approval is worded for the child run's call: the call was the child's, the child asks again or the run is relaunched", () => {
  const text = reAskText([dialogOf("approval", "Allow?", { tool: "bash", summary: "rm -rf build" }, new Date(T0))]);
  assert.match(text, /approval for a child run's call to bash \(rm -rf build\)/);
  assert.match(text, /that call was the child's, not yours/);
  assert.match(text, /Wait for the child to ask again, or relaunch the run/);
  assert.doesNotMatch(text, /make the call again/);
});
