// The parent learns how the owner answered a child's plan checkpoint: the child records `lastCheckpoint` in its live file, the parent's
// childblocked tick sends ONE quiet information line (childblocked.ts). Same fake clock / live files / registry as r42-child-blocked.test.ts.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildBlocked } from "../childblocked.ts";
import { liveDir } from "../livestate.ts";
import { writeRegistry } from "../session.ts";
import { tick, world } from "./_r46world.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-18T08:00:00.000Z");

function rig() {
  const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cp-answer-")));
  let now = T0;
  const sent: { text: string; wake: boolean }[] = [];
  const mk = () => new ChildBlocked({ agentDir, sessionId: "parent-sess", opener: () => "fm-parent", seconds: () => 600, send: (text, wake) => sent.push({ text, wake }), now: () => now });
  const handoff = path.join(agentDir, "pi-foreman", "handoffs", "20261118-080000-job");
  fs.mkdirSync(handoff, { recursive: true });
  fs.writeFileSync(path.join(handoff, "live.json"), JSON.stringify({ intercomId: "fm-job-1", piSessionId: "child-sess" }));
  writeRegistry(agentDir, { version: 1, sessions: [{ label: "job", child: "fm-job-1", parent: "fm-parent", handoff, status: "open" }] });
  const live = (f: Record<string, unknown>) => {
    fs.mkdirSync(liveDir(agentDir), { recursive: true });
    fs.writeFileSync(path.join(liveDir(agentDir), "child-sess.json"), JSON.stringify({ heartbeatAt: new Date(now).toISOString(), ...f }));
  };
  const answer = (decision: string) => ({ lastCheckpoint: { decision, at: new Date(now).toISOString() } });
  return { agentDir, sent, mk, live, answer, advance: (ms: number) => { now += ms; }, at: () => now, cleanup: () => fs.rmSync(agentDir, { recursive: true, force: true }) };
}

test("approve: one quiet line naming the answer, no repeat on a second tick or after a reload", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.live({});
  const cb = r.mk();
  cb.tick();
  r.advance(MIN);
  r.live(r.answer("approve"));
  cb.tick();
  assert.deepEqual(r.sent, [{ text: "Child session job: plan approved by the owner.", wake: false }]);
  r.advance(MIN);
  r.live({ lastCheckpoint: { decision: "approve", at: new Date(T0 + MIN).toISOString() } }); // the same answer again
  cb.tick();
  r.mk().tick(); // reload
  assert.equal(r.sent.length, 1);
});

test("revise and reject word the line", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.live({});
  const cb = r.mk();
  cb.tick();
  r.advance(MIN);
  r.live(r.answer("revise"));
  cb.tick();
  r.advance(MIN);
  r.live(r.answer("reject"));
  cb.tick();
  assert.deepEqual(r.sent.map((s) => s.text), ["Child session job: plan sent back by the owner (revise).", "Child session job: plan rejected by the owner."]);
  assert.ok(r.sent.every((s) => !s.wake));
});

test("an announced owner episode that clears with the answer: one merged note only", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.live({});
  const cb = r.mk();
  cb.tick();
  r.advance(MIN);
  r.live({ blockedOn: "owner", blockedKind: "checkpoint", ownerBlockedSince: new Date(r.at()).toISOString() });
  r.advance(11 * MIN);
  r.live({ blockedOn: "owner", blockedKind: "checkpoint", ownerBlockedSince: new Date(r.at() - 11 * MIN).toISOString() });
  cb.tick();
  assert.equal(r.sent.length, 1, "the waits notice");
  r.advance(MIN);
  r.live(r.answer("approve"));
  cb.tick();
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[1].text, "Child session job: its dialog was answered after 12 min: plan approved by the owner.");
  assert.equal(r.sent[1].wake, false);
});

test("an answer older than this session's start is seeded, not replayed", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.live({ lastCheckpoint: { decision: "approve", at: new Date(T0 - 5 * MIN).toISOString() } });
  const cb = r.mk();
  cb.tick();
  r.advance(MIN);
  r.live({ lastCheckpoint: { decision: "approve", at: new Date(T0 - 5 * MIN).toISOString() } });
  cb.tick();
  r.mk().tick();
  assert.equal(r.sent.length, 0);
});

test("inherited object keys are no answer: no line", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.live({});
  const cb = r.mk();
  cb.tick();
  for (const decision of ["constructor", "toString", "__proto__"]) {
    r.advance(MIN);
    r.live(r.answer(decision));
    cb.tick();
  }
  assert.equal(r.sent.length, 0);
});

test("an answer given between the last tick and a parent reload is reported once", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.live({});
  r.mk().tick();
  r.advance(MIN);
  r.live(r.answer("approve"));
  r.advance(MIN); // the parent reloads later: a new ChildBlocked on the same state file
  const cb = r.mk();
  cb.tick();
  cb.tick();
  r.mk().tick();
  assert.deepEqual(r.sent.map((s) => s.text), ["Child session job: plan approved by the owner."]);
});

test("no answer: no line (dismissed, no UI, pending)", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.live({});
  const cb = r.mk();
  cb.tick();
  r.advance(MIN);
  r.live({ lastCheckpoint: { decision: "pending", at: new Date(r.at()).toISOString() } });
  cb.tick();
  assert.equal(r.sent.length, 0);
});

test("child side: an approved checkpoint writes lastCheckpoint (decision and time only) to the live file; a dismissed one does not", async (t) => {
  const w = world(t);
  fs.writeFileSync(w.planFile, "# Widget plan\n\n## For the owner\nWe ship the widget.\n\n## Goal\nShip it.\n");
  const a = await w.adapter("startup");
  assert.equal(await a.review("PASS"), null);
  const ctx = a.ctx as unknown as { ui: { select: (...x: unknown[]) => Promise<unknown> }; mode: string };
  ctx.mode = "rpc";
  const agentDir = path.resolve(w.handoff, "..", "..", "..");
  const read = () => {
    const dir = liveDir(agentDir);
    const f = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".json")) : [];
    return f.map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as { lastCheckpoint?: { decision: string; at: string } });
  };
  ctx.ui.select = async () => undefined;
  assert.equal((await a.checkpoint()).decision, "pending");
  await tick(50);
  assert.ok(read().every((f) => f.lastCheckpoint === undefined), "dismissed: nothing recorded");
  ctx.ui.select = async () => "approve";
  assert.equal((await a.checkpoint()).decision, "approve");
  await tick(50);
  const cps = read().map((f) => f.lastCheckpoint).filter(Boolean);
  assert.equal(cps.length, 1);
  assert.equal(cps[0]!.decision, "approve");
  assert.deepEqual(Object.keys(cps[0]!).sort(), ["at", "decision"]);
  assert.ok(Number.isFinite(Date.parse(cps[0]!.at)));
});
