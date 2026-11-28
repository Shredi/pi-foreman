// The parent's idle notices (childblocked.ts): the plan notice only for a child really in its plan phase and not working, one result notice
// after a child sent its result, each once per state (also across a reload).
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildBlocked, planIdleText, resultIdleText } from "../childblocked.ts";
import { liveDir } from "../livestate.ts";
import { ROUND_STATE_FILE, planWait } from "../roundstate.ts";
import { writeRegistry } from "../session.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-18T08:00:00.000Z");
const ASK = "waits for: its own plan review, then it goes on to build; nothing from you";
const OWNER = "waits for: the owner's approval at its pane; nothing from you";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "idle-notice-")));
const iso = (ms: number) => new Date(ms).toISOString();

function rig(o: { last?: { kind: string; at: string } | null } = {}) {
  const agentDir = tmp();
  let now = T0;
  const sent: { text: string; wake: boolean }[] = [];
  const handoff = path.join(agentDir, "pi-foreman", "handoffs", "job");
  fs.mkdirSync(handoff, { recursive: true });
  fs.writeFileSync(path.join(handoff, "live.json"), JSON.stringify({ intercomId: "fm-job-1", piSessionId: "child-sess" }));
  const registry = (last: { kind: string; at: string } | null | undefined) => writeRegistry(agentDir, { version: 1, sessions: [{ label: "job", child: "fm-job-1", parent: "fm-parent", handoff, status: "open", ...(last ? { last } : {}) }] });
  registry(o.last);
  const make = () => new ChildBlocked({ agentDir, sessionId: "parent-sess", opener: () => "fm-parent", seconds: () => 600, send: (text, wake) => sent.push({ text, wake }), now: () => now });
  const round = (s: { planPhase?: boolean; tier?: string; review?: boolean; built?: boolean }) =>
    fs.writeFileSync(path.join(handoff, ROUND_STATE_FILE), JSON.stringify({ handoffDir: handoff, plan: null, planReview: null, round: { built: s.built === true, reviewOpen: false }, tier: s.tier ?? "standard", reviewPassed: s.review === true, ...(s.planPhase === undefined ? {} : { planPhase: s.planPhase }) }));
  const live = (f: Record<string, unknown> = {}) => {
    fs.mkdirSync(liveDir(agentDir), { recursive: true });
    fs.writeFileSync(path.join(liveDir(agentDir), "child-sess.json"), JSON.stringify({ heartbeatAt: iso(now), state: "idle", lastEventAt: iso(T0), runs: [], ...f }));
  };
  return { sent, cb: make(), make, live, round, registry, handoff, advance: (ms: number) => { now += ms; }, now: () => now, cleanup: () => fs.rmSync(agentDir, { recursive: true, force: true }) };
}
const run = (endedAt: string | null) => ({ launchId: "l1", role: "explorer", rung: "bottom", model: null, state: endedAt ? "done" : "working", tokensIn: 0, tokensOut: 0, cost: 0, endedAt });

test("planWait: open needs planPhase true; a file without the field is not open", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.round({ planPhase: true });
  assert.deepEqual(planWait(r.handoff), { open: true, text: ASK });
  r.round({ planPhase: false });
  assert.equal(planWait(r.handoff).open, false);
  r.round({});
  assert.deepEqual(planWait(r.handoff), { open: false, text: ASK });
  r.round({ planPhase: true, tier: "heavy" });
  assert.equal(planWait(r.handoff).text, "waits for: its own plan review and the owner's approval at its pane; nothing from you");
  r.round({ planPhase: true, built: true });
  assert.equal(planWait(r.handoff).open, false, "built");
});

test("a child with an active run or an active task gets no plan notice; it does once all work ended", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.round({ planPhase: true });
  r.advance(30 * MIN);
  r.live({ runs: [run(null)] });
  r.cb.tick();
  r.live({ runs: [run(iso(T0)), run(null)] });
  r.cb.tick();
  r.live({ tasks: [{ id: "t1" }] });
  r.cb.tick();
  assert.deepEqual(r.sent, [], "busy");
  r.live({ runs: [run(iso(T0))] });
  r.cb.tick();
  assert.equal(r.sent.length, 1, "all runs ended, no tasks: idle");
});

test("a child that sent its result and is busy gets no result notice", (t) => {
  const r = rig({ last: { kind: "result", at: iso(T0) } });
  t.after(r.cleanup);
  r.advance(30 * MIN);
  r.live({ runs: [run(null)] });
  r.cb.tick();
  r.live({ tasks: [{ id: "t1" }] });
  r.cb.tick();
  r.live({ state: "working" });
  r.cb.tick();
  assert.deepEqual(r.sent, []);
});

test("a child that sent its result: one quiet notice after the delay, never 'at its plan', not repeated across ticks or a reload", (t) => {
  const r = rig({ last: { kind: "result", at: iso(T0) } });
  t.after(r.cleanup);
  r.round({ planPhase: true }); // the plan notice would also be true here: the result notice goes first
  r.advance(9 * MIN);
  r.live();
  r.cb.tick();
  assert.equal(r.sent.length, 0, "below the delay");
  r.advance(2 * MIN);
  r.live();
  r.cb.tick();
  assert.deepEqual(r.sent, [{ text: resultIdleText("job", 11 * MIN), wake: false }]);
  assert.equal(r.sent[0].text, "Child session job: idle since it sent its result 11 min ago; waits for: foreman:close from you.");
  for (let i = 0; i < 5; i++) {
    r.advance(MIN);
    r.live();
    r.cb.tick();
  }
  assert.equal(r.sent.length, 1, "once across ticks");
  const again = r.make();
  r.advance(MIN);
  r.live();
  again.tick();
  assert.equal(r.sent.length, 1, "once across a reload");
});

test("result sent, then busy, then idle again with the same result time: no second notice; a newer result is a new state", (t) => {
  const r = rig({ last: { kind: "update", at: iso(T0) } });
  t.after(r.cleanup);
  r.advance(11 * MIN);
  r.live();
  r.cb.tick();
  assert.equal(r.sent.length, 1);
  r.live({ runs: [run(null)] });
  r.cb.tick();
  r.advance(20 * MIN);
  r.live({ lastEventAt: iso(r.now()) });
  r.cb.tick();
  r.advance(11 * MIN);
  r.live({ lastEventAt: iso(r.now() - 11 * MIN) });
  r.cb.tick();
  assert.equal(r.sent.length, 1, "same last.at");
  r.registry({ kind: "result", at: iso(r.now() - 11 * MIN) });
  r.live({ lastEventAt: iso(r.now() - 11 * MIN) });
  r.cb.tick();
  assert.equal(r.sent.length, 2, "a new result time");
});

test("at the plan with planPhase true: the plan notice as before, once, in the same plan state across new events and busy stretches", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.round({ planPhase: true, tier: "heavy" });
  r.advance(11 * MIN);
  r.live();
  r.cb.tick();
  assert.deepEqual(r.sent, [{ text: planIdleText("job", 11 * MIN, "waits for: its own plan review and the owner's approval at its pane; nothing from you"), wake: false }]);
  // new events, a busy stretch, idle again: the state is the same
  for (let i = 1; i <= 4; i++) {
    r.advance(15 * MIN);
    r.live({ lastEventAt: iso(r.now() - 12 * MIN), ...(i % 2 ? { runs: [run(null)] } : {}) });
    r.cb.tick();
  }
  assert.equal(r.sent.length, 1);
  const again = r.make();
  r.advance(15 * MIN);
  r.live({ lastEventAt: iso(r.now() - 12 * MIN) });
  again.tick();
  assert.equal(r.sent.length, 1, "also after a reload");
  // the plan state changes (the review passed): a new state, a new notice
  r.round({ planPhase: true, tier: "heavy", review: true });
  r.advance(15 * MIN);
  r.live({ lastEventAt: iso(r.now() - 12 * MIN) });
  again.tick();
  assert.equal(r.sent.length, 2);
  assert.match(r.sent[1].text, new RegExp(OWNER));
});

test("leaving the plan phase drops the record: entering a plan state again notifies again", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.round({ planPhase: true });
  r.advance(11 * MIN);
  r.live();
  r.cb.tick();
  assert.equal(r.sent.length, 1);
  r.round({ planPhase: false });
  r.live();
  r.cb.tick();
  r.round({ planPhase: true });
  r.live();
  r.cb.tick();
  assert.equal(r.sent.length, 2);
});

test("no plan notice when planPhase is false or missing (not opened plan-first, or an older child)", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.advance(30 * MIN);
  r.round({ planPhase: false });
  r.live();
  r.cb.tick();
  r.round({});
  r.live();
  r.cb.tick();
  assert.deepEqual(r.sent, []);
});
