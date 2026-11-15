// `ruling.md` (the plan ruling) never answers an ask by itself (ruling.ts askOpen): an ask written after a plan ruling is
// open, an answered ask stays closed across a later plan-ruling wake, and a stale own ruling does not close it.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AskContract } from "../askcontract.ts";
import { ChildBlocked } from "../childblocked.ts";
import { BlockedTracker } from "../herdr.ts";
import { LiveState, liveDir } from "../livestate.ts";
import { askOpen } from "../ruling.ts";
import { writeRegistry } from "../session.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-15T08:00:00.000Z");

function rig(t: { after(fn: () => void): void }) {
  const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-askplan-")));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const handoff = path.join(agentDir, "pi-foreman", "handoffs", "20261115-080000-job");
  fs.mkdirSync(handoff, { recursive: true });
  fs.writeFileSync(path.join(handoff, "child"), "fm-job-1\n");
  fs.writeFileSync(path.join(handoff, "live.json"), JSON.stringify({ intercomId: "fm-job-1", piSessionId: "child-sess" }));
  const w = (name: string, text: string) => fs.writeFileSync(path.join(handoff, name), text);
  const ask = (n: number) => {
    w("ask.md", `# Ask ${n}: topic ${n}\n`);
    w(".ask", `ask-${n}\n`);
  };
  const tracker = new BlockedTracker({ emit: () => undefined, on: () => undefined });
  const contract = new AskContract({ ownDirs: () => [handoff], block: (label) => tracker.own(label) });
  return { agentDir, handoff, w, ask, tracker, contract };
}

/** The parent side: a registry entry for the child, a fresh live file naming its open asks, and a ChildBlocked on a fake clock. */
function parent(r: ReturnType<typeof rig>) {
  writeRegistry(r.agentDir, { version: 1, sessions: [{ label: "job", child: "fm-job-1", parent: "fm-parent", handoff: r.handoff, status: "open" }] });
  const sent: string[] = [];
  let now = T0;
  const cb = new ChildBlocked({ agentDir: r.agentDir, sessionId: "parent-sess", opener: () => "fm-parent", seconds: () => 600, send: (text) => sent.push(text), now: () => now });
  const tick = (asks: number[]) => {
    now += MIN;
    fs.mkdirSync(liveDir(r.agentDir), { recursive: true });
    fs.writeFileSync(path.join(liveDir(r.agentDir), "child-sess.json"), JSON.stringify({ heartbeatAt: new Date(now).toISOString(), asks: asks.map((n) => ({ n, topic: `topic ${n}` })) }));
    cb.tick();
  };
  return { sent, tick };
}

function liveAsks(r: ReturnType<typeof rig>): unknown {
  const l = LiveState.start({ agentDir: r.agentDir, sessionId: "child-sess", cwd: "/w", mode: "rpc", env: { PI_INTERCOM_STABLE_ID: "fm-job-1" } }, () => [])!;
  try {
    return (l.snapshot() as unknown as { asks?: unknown }).asks;
  } finally {
    l.stop();
  }
}

test("an ask written after a plan ruling is open, in the live asks, and the parent gets one notice", (t) => {
  const r = rig(t);
  r.w(".seen", "ruling.md\n");
  r.ask(1);
  assert.equal(askOpen(r.handoff), true);
  assert.deepEqual(liveAsks(r), [{ n: 1, topic: "topic 1" }]);
  const p = parent(r);
  p.tick([1]);
  p.tick([1]);
  assert.equal(p.sent.length, 1, "one notice, not repeated");
  assert.match(p.sent[0], /ask 1/);
});

test("the AskContract blocks on an ask file written after a plan ruling", (t) => {
  const r = rig(t);
  r.w(".seen", "ruling.md\n");
  r.w("ask.md", "# Ask 1: q\n");
  assert.equal(r.contract.onFileWritten(path.join(r.handoff, "ask.md")), "ask");
  assert.equal(r.tracker.active, true);
  r.contract.releaseAll();
});

test("a second ask after an answered first is open and gets one notice of its own", (t) => {
  const r = rig(t);
  r.ask(1);
  r.w("ruling-1.md", "yes\n");
  r.w(".seen", "ruling-1.md\n");
  assert.equal(askOpen(r.handoff), false);
  const p = parent(r);
  p.tick([1]);
  assert.equal(p.sent.length, 0, "the answered ask 1 sends nothing");
  r.ask(2);
  assert.equal(askOpen(r.handoff), true);
  p.tick([2]);
  p.tick([2]);
  assert.equal(p.sent.length, 1);
  assert.match(p.sent[0], /ask 2/);
});

test("ruling-<n>.md in .seen still closes the ask", (t) => {
  const r = rig(t);
  r.ask(1);
  assert.equal(askOpen(r.handoff), true);
  r.w(".seen", "ruling-1.md\n");
  assert.equal(askOpen(r.handoff), false);
  r.w(".seen", "ruling-2.md\n");
  assert.equal(askOpen(r.handoff), true, "another ruling's name does not close it");
});

test("an answered ask stays closed after a later plan-ruling wake", (t) => {
  const r = rig(t);
  const askFile = path.join(r.handoff, "ask.md");
  r.w("ask.md", "# Ask 1: q\n");
  assert.equal(r.contract.onFileWritten(askFile), "ask");
  r.w("ruling-1.md", "yes\n");
  assert.equal(r.contract.onRulingWake(path.join(r.handoff, "ruling-1.md")), true);
  assert.equal(r.tracker.active, false);
  r.w("ruling.md", "APPROVED\n");
  assert.equal(r.contract.onRulingWake(path.join(r.handoff, "ruling.md")), true);
  assert.equal(fs.readFileSync(path.join(r.handoff, ".seen"), "utf8").trim(), "ruling.md");
  assert.equal(askOpen(r.handoff), false);
  assert.equal(r.tracker.active, false, "no block");
  assert.equal(liveAsks(r), undefined, "not in the live asks");
  const p = parent(r);
  p.tick([1]);
  assert.equal(p.sent.length, 0, "no parent notice");
  r.contract.releaseAll();
});

test("ruling.md seen with an own ruling older than ask.md: the ask is open; a fresh or equal one closes it", (t) => {
  const r = rig(t);
  r.ask(1);
  r.w("ruling-1.md", "old\n");
  r.w(".seen", "ruling.md\n");
  fs.utimesSync(path.join(r.handoff, "ruling-1.md"), 1000, 1000);
  fs.utimesSync(path.join(r.handoff, "ask.md"), 2000, 2000);
  assert.equal(askOpen(r.handoff), true, "stale own ruling");
  fs.utimesSync(path.join(r.handoff, "ruling-1.md"), 2000, 2000);
  assert.equal(askOpen(r.handoff), false, "equal mtime counts as fresh");
  fs.utimesSync(path.join(r.handoff, "ruling-1.md"), 3000, 3000);
  assert.equal(askOpen(r.handoff), false);
  fs.rmSync(path.join(r.handoff, "ruling-1.md"));
  assert.equal(askOpen(r.handoff), true, "no own ruling at all");
});

test("ruling.md seen, no number in .ask: any .seen still ends it; needs_ruling: no never opens", (t) => {
  const r = rig(t);
  r.w("ask.md", "# Ask 1: q\n");
  r.w(".ask", "something\n");
  r.w(".seen", "ruling.md\n");
  assert.equal(askOpen(r.handoff), false);
  r.ask(1);
  r.w("ask.md", "# Ask 1: q\nneeds_ruling: no\n");
  assert.equal(askOpen(r.handoff), false);
});
