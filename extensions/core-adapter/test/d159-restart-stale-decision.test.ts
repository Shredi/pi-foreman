// D159: after a restart a parent never says "answered" without a stored answer at or after the episode start. A checkpoint decision older
// than the episode, or one a restart superseded, is no answer; a fresh decision still is.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildBlocked } from "../childblocked.ts";
import { liveDir } from "../livestate.ts";
import { writeRegistry } from "../session.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-20T08:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** The watcher starts 30 min before the episode (so an older decision is not seeded away); the episode starts at T0 and ends at the second tick. */
function ended(after: Record<string, unknown>): string {
  const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "d159-")));
  try {
    let now = T0 - 30 * MIN;
    const sent: string[] = [];
    const cb = new ChildBlocked({ agentDir, sessionId: "parent-sess", opener: () => "fm-parent", seconds: () => 600, send: (text) => sent.push(text), now: () => now });
    const handoff = path.join(agentDir, "pi-foreman", "handoffs", "20261120-080000-job");
    fs.mkdirSync(handoff, { recursive: true });
    fs.writeFileSync(path.join(handoff, "live.json"), JSON.stringify({ intercomId: "fm-job-1", piSessionId: "child-sess" }));
    writeRegistry(agentDir, { version: 1, sessions: [{ label: "job", child: "fm-job-1", parent: "fm-parent", handoff, status: "open" }] });
    const live = (f: Record<string, unknown>) => {
      fs.mkdirSync(liveDir(agentDir), { recursive: true });
      fs.writeFileSync(path.join(liveDir(agentDir), "child-sess.json"), JSON.stringify({ heartbeatAt: iso(now), startedAt: iso(T0 - MIN), ...f }));
    };
    const blocked = () => live({ blockedOn: "owner", blockedKind: "approval", ownerBlockedSince: iso(T0) });
    now = T0 + 11 * MIN;
    blocked();
    cb.tick();
    assert.equal(sent.length, 1, "the notice");
    now += MIN;
    live(after);
    cb.tick();
    return sent[1] ?? "";
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}
const decision = (at: number) => ({ lastCheckpoint: { decision: "approve", at: iso(at) } });

test("a stale checkpoint decision and a restart: the restart wording, never 'answered'", () => {
  const text = ended({ ...decision(T0 - 5 * MIN), startedAt: iso(T0 + 6 * MIN) });
  assert.match(text, /was ended by a restart of the session after 12 min, not answered; the child asks again\.$/);
  assert.doesNotMatch(text, /was answered/);
});

test("a decision given in the episode, then a restart: still the restart wording", () => {
  assert.match(ended({ ...decision(T0 + 5 * MIN), startedAt: iso(T0 + 6 * MIN) }), /ended by a restart of the session/);
});

test("a stale decision without a restart is no answer to this episode", () => {
  assert.doesNotMatch(ended(decision(T0 - 5 * MIN)), /was answered/);
});

test("a fresh checkpoint decision without a restart: answered", () => {
  assert.match(ended(decision(T0 + 5 * MIN)), /^Child session job: its dialog was answered after 12 min: plan approved by the owner\.$/);
});
