// PR 3 of the intercom round: the parent is reminded once while a remote child's registry `ask` entry is present and older than
// `sessions.blockedNoticeSeconds`. The entry's presence is the answer state: a brief clears it (registry), a steer or plan ruling does not.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildBlocked } from "../childblocked.ts";
import { readRegistry, writeRegistry } from "../session.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-15T08:00:00.000Z");

function rig(secs = 600) {
  const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-rask-")));
  let now = T0;
  let seconds = secs;
  const sent: { text: string; wake: boolean }[] = [];
  const traces: Record<string, unknown>[] = [];
  const cb = new ChildBlocked({ agentDir, sessionId: "parent-sess", opener: () => "fm-parent", seconds: () => seconds, send: (text, wake) => sent.push({ text, wake }), trace: (r) => traces.push(r), now: () => now });
  const reg = (ask: unknown, extra: Record<string, unknown> = {}) => writeRegistry(agentDir, { version: 1, sessions: [{ label: "job", child: "fm-job-1", parent: "fm-parent", handoff: path.join(agentDir, "m"), status: "open", machine: "alpha", ask, ...extra }] });
  const reminders = () => sent.filter((s) => /for your answer to its ask/.test(s.text));
  return { agentDir, cb, sent, traces, reg, reminders, setSeconds: (n: number) => { seconds = n; }, advance: (ms: number) => { now += ms; }, cleanup: () => fs.rmSync(agentDir, { recursive: true, force: true }) };
}

test("a remote registry ask is reminded once after the configured seconds, as a turn, with label and age only", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.reg({ seq: 1, n: 1, topic: "secret_marker", answers: 0 });
  r.cb.tick();
  r.advance(9 * MIN);
  r.cb.tick();
  assert.equal(r.reminders().length, 0, "not before the configured seconds");
  r.advance(2 * MIN);
  r.cb.tick();
  assert.equal(r.reminders().length, 1);
  assert.equal(r.reminders()[0].wake, true, "an idle parent gets a turn");
  assert.match(r.reminders()[0].text, /^Remote child session job has waited 11 min for your answer to its ask\. Answer it with a brief/);
  assert.equal(r.reminders()[0].text.includes("secret_marker"), false);
  for (let i = 0; i < 30; i++) {
    r.advance(MIN);
    r.cb.tick();
  }
  assert.equal(r.reminders().length, 1, "once while the entry is present");
});

test("the age comes from the entry's time when it has one", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.reg({ seq: 1, at: new Date(T0 - 20 * MIN).toISOString(), answers: 0 });
  r.cb.tick();
  assert.equal(r.reminders().length, 1);
  assert.match(r.reminders()[0].text, /waited 20 min/);
});

test("never at 0", (t) => {
  const r = rig(0);
  t.after(r.cleanup);
  r.reg({ seq: 1, answers: 0 });
  r.cb.tick();
  for (let i = 0; i < 120; i++) {
    r.advance(MIN);
    r.cb.tick();
  }
  assert.equal(r.reminders().length, 0);
});

test("not after a brief cleared the entry; a new ask is reminded again", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.reg({ seq: 1, answers: 0 });
  r.cb.tick();
  r.advance(5 * MIN);
  r.reg(undefined);
  r.cb.tick();
  r.advance(30 * MIN);
  r.cb.tick();
  assert.equal(r.reminders().length, 0, "the entry is gone");
  r.reg({ seq: 2, answers: 1 });
  r.cb.tick();
  r.advance(11 * MIN);
  r.cb.tick();
  assert.equal(r.reminders().length, 1);
});

test("still after a steer delivery (the entry stays), not for a closed child or a local child", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.reg({ seq: 1, answers: 0 }, { briefs: 1 }); // a steer or a plan ruling was delivered: briefs up, entry untouched
  r.cb.tick();
  r.advance(11 * MIN);
  r.cb.tick();
  assert.equal(r.reminders().length, 1);
  assert.equal(readRegistry(r.agentDir).sessions[0].ask !== undefined, true, "the pass never writes the registry");

  const closed = rig();
  t.after(closed.cleanup);
  closed.reg({ seq: 1 }, { status: "closed" });
  closed.cb.tick();
  closed.advance(11 * MIN);
  closed.cb.tick();
  assert.equal(closed.reminders().length, 0);

  const local = rig();
  t.after(local.cleanup);
  local.reg({ seq: 1 }, { machine: undefined });
  local.cb.tick();
  local.advance(11 * MIN);
  local.cb.tick();
  assert.equal(local.reminders().length, 0);
});
