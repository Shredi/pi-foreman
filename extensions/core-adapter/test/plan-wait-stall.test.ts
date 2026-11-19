// Plan-wait stall: the parent's fixed "waits for:" line after a child's `Plan from` (roundstate.ts planWait, session.ts), the idle-at-plan
// notice (childblocked.ts) and the rules sentence in the rendered foreman prompt.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildBlocked } from "../childblocked.ts";
import { applyVariants } from "../ledgercall.ts";
import { IntercomCarry } from "../intercomcarry.ts";
import { liveDir } from "../livestate.ts";
import { ROUND_STATE_FILE, planWait } from "../roundstate.ts";
import { registerSession, writeRegistry } from "../session.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-18T08:00:00.000Z");
const HEAVY_ASK = "waits for: its own plan review and the owner's approval at its pane; nothing from you";

function state(dir: string, s: { tier?: string; review?: "pass" | "fail" | null; built?: boolean; decided?: boolean }): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ROUND_STATE_FILE), JSON.stringify({ handoffDir: dir, plan: null, planReview: null, reviewPassed: s.review === "pass", round: { built: s.built === true, reviewOpen: false }, ...(s.tier ? { tier: s.tier } : {}), ...(s.decided ? { planOpen: false } : {}) }));
}

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plan-wait-")));

test("planWait: the five states, incident state included", (t) => {
  const d = tmp();
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  state(d, { tier: "heavy", review: null });
  assert.deepEqual(planWait(d), { open: true, text: HEAVY_ASK }, "the incident: heavy, plan review null");
  state(d, { tier: "heavy", review: "fail" });
  assert.equal(planWait(d).text, HEAVY_ASK, "a FAIL is no PASS");
  state(d, { tier: "heavy", review: "pass" });
  assert.deepEqual(planWait(d), { open: true, text: "waits for: the owner's approval at its pane; nothing from you" });
  state(d, { tier: "standard", review: null });
  assert.deepEqual(planWait(d), { open: true, text: "waits for: its own plan review, then it goes on to build; nothing from you" });
  state(d, { tier: "standard", review: "pass" });
  assert.deepEqual(planWait(d), { open: true, text: "waits for: nothing; it goes on to build" });
  state(d, { tier: "heavy", review: "pass", decided: true });
  assert.deepEqual(planWait(d), { open: false, text: "waits for: nothing; it goes on to build" });
  state(d, { review: null });
  assert.equal(planWait(d).text, "waits for: unknown (no state); nothing from you is required", "no tier");
  assert.equal(planWait(path.join(d, "missing")).text, "waits for: unknown (no state); nothing from you is required");
  assert.deepEqual(planWait(undefined), { open: false, text: "waits for: unknown (no state); nothing from you is required" });
  state(d, { tier: "heavy", built: true });
  assert.equal(planWait(d).open, false, "built: the plan phase is over");
});

test("a Plan from of a local child appends one quiet wait line; other reports and remote children append none", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = path.join(root, "agent");
  const handoff = path.join(root, "h");
  state(handoff, { tier: "heavy", review: null });
  writeRegistry(agent, { version: 1, sessions: [{ label: "phase1", child: "fm-phase1-abc123", status: "open", handoff }] });
  const handlers = new Map<string, (e: unknown, c: unknown) => Promise<unknown>>();
  const pi = { on: (n: string, h: (e: unknown, c: unknown) => Promise<unknown>) => void handlers.set(n, h) };
  const lines: string[] = [];
  registerSession(pi as never, {
    spawner: async () => { throw new Error("no spawn"); },
    pkgRoot: "/pkg",
    session: async () => ({ id: "sess-1", isChild: false, cwd: root, agentDir: agent, python: null }),
    onPlanWait: (text) => void lines.push(text),
  });
  const ctx = { ui: { notify: () => {} }, sessionManager: { getBranch: () => [] } };
  const msg = (from: string, text: string, id: string) => ({ message: { role: "custom", customType: "intercom_message", details: { from: { id: from }, message: { id, content: { text } } } } });
  await handlers.get("message_end")!(msg("fm-phase1-abc123", `Result from phase1: ${handoff}/result.md`, "m0"), ctx);
  assert.deepEqual(lines, []);
  await handlers.get("message_end")!(msg("stranger", `Plan from phase1: ${handoff}/plan.md`, "m1"), ctx);
  assert.deepEqual(lines, [], "an unknown sender");
  await handlers.get("message_end")!(msg("fm-phase1-abc123", `Plan from phase1: ${handoff}/plan.md`, "m2"), ctx);
  assert.deepEqual(lines, [`phase1 ${HEAVY_ASK}.`]);
});

function rig(carry?: IntercomCarry) {
  const agentDir = tmp();
  let now = T0;
  const sent: { text: string; wake: boolean }[] = [];
  const handoff = path.join(agentDir, "pi-foreman", "handoffs", "job");
  fs.mkdirSync(handoff, { recursive: true });
  fs.writeFileSync(path.join(handoff, "live.json"), JSON.stringify({ intercomId: "fm-job-1", piSessionId: "child-sess" }));
  writeRegistry(agentDir, { version: 1, sessions: [{ label: "job", child: "fm-job-1", parent: "fm-parent", handoff, status: "open" }] });
  const cb = new ChildBlocked({ agentDir, sessionId: "parent-sess", opener: () => "fm-parent", seconds: () => 600, ...(carry ? { carry } : {}), send: (text, wake) => sent.push({ text, wake }), now: () => now });
  const live = (f: Record<string, unknown>) => {
    fs.mkdirSync(liveDir(agentDir), { recursive: true });
    fs.writeFileSync(path.join(liveDir(agentDir), "child-sess.json"), JSON.stringify({ heartbeatAt: new Date(now).toISOString(), state: "idle", lastEventAt: new Date(T0).toISOString(), ...f }));
  };
  return { sent, cb, live, handoff, advance: (ms: number) => { now += ms; }, cleanup: () => fs.rmSync(agentDir, { recursive: true, force: true }) };
}

test("idle at the plan: one quiet notice for the incident state after the delay, not before, no repeat", (t) => {
  const r = rig();
  t.after(r.cleanup);
  state(r.handoff, { tier: "heavy", review: null });
  r.live({});
  r.cb.tick();
  r.advance(9 * MIN);
  r.live({});
  r.cb.tick();
  assert.equal(r.sent.length, 0, "below the delay");
  r.advance(2 * MIN);
  r.live({});
  r.cb.tick();
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].wake, false);
  assert.equal(r.sent[0].text, `Child session job: idle at its plan for 11 min; ${HEAVY_ASK}.`);
  for (let i = 0; i < 30; i++) {
    r.advance(MIN);
    r.live({});
    r.cb.tick();
  }
  assert.equal(r.sent.length, 1, "once per episode");
  r.live({ state: "working" });
  r.cb.tick();
  assert.equal(r.sent.length, 1, "an ended episode sends no note");
});

test("idle at the plan: no notice for a working child, a built child, an approved plan or an unreadable state", (t) => {
  const r = rig();
  t.after(r.cleanup);
  state(r.handoff, { tier: "heavy", review: null });
  r.advance(30 * MIN);
  r.live({ state: "working" });
  r.cb.tick();
  state(r.handoff, { tier: "heavy", review: "pass", built: true });
  r.live({});
  r.cb.tick();
  state(r.handoff, { tier: "heavy", review: "pass", decided: true });
  r.live({});
  r.cb.tick();
  fs.rmSync(path.join(r.handoff, ROUND_STATE_FILE));
  r.live({});
  r.cb.tick();
  assert.deepEqual(r.sent, []);
});

test("idle at the plan: a child with an open Question gets the question reminder only", (t) => {
  const carry = new IntercomCarry();
  const r = rig(carry);
  t.after(r.cleanup);
  state(r.handoff, { tier: "heavy", review: null });
  carry.note("fm-job-1", "job", T0);
  r.live({});
  r.cb.tick();
  r.advance(11 * MIN);
  r.live({});
  r.cb.tick();
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].wake, true);
  assert.match(r.sent[0].text, /waited 11 min for your answer to its question/);
  carry.answered("fm-job-1");
  r.advance(MIN);
  r.live({});
  r.cb.tick();
  assert.equal(r.sent.length, 2, "answered: the idle notice may follow");
  assert.match(r.sent[1].text, /idle at its plan/);
});

test("idle at the plan: a child blocked on its owner gets the existing notice only", (t) => {
  const r = rig();
  t.after(r.cleanup);
  state(r.handoff, { tier: "heavy", review: "pass" });
  r.advance(15 * MIN);
  r.live({ state: "blocked", blockedOn: "owner", blockedKind: "checkpoint", ownerBlockedSince: new Date(T0).toISOString() });
  r.cb.tick();
  r.advance(MIN);
  r.live({ state: "blocked", blockedOn: "owner", blockedKind: "checkpoint", ownerBlockedSince: new Date(T0).toISOString() });
  r.cb.tick();
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0].text, /has waited on its owner since .*\(checkpoint\)/);
});

test("the rules sentence is in the rendered foreman rules with multiSession on and absent with it off", () => {
  const rules = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "..", "instructions", "foreman.md"), "utf8");
  const on = applyVariants(rules, { multiSession: "on" });
  for (const want of ["Answer a child's `Plan from` in the turn you read it", "`no notes` when it waits for the owner (never `go on`)", "`no notes, go on` only when it goes on", "a note or ruling approves nothing"]) assert.ok(on.includes(want), want);
  assert.ok(!applyVariants(rules, { multiSession: "off" }).includes("Answer a child's `Plan from`"));
});
