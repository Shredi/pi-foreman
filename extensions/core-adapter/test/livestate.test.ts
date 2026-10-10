import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LiveState, intercomIdOf, labelOfHandoff, liveDir } from "../livestate.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ls-"));
const read = (d: string, id: string) => JSON.parse(fs.readFileSync(path.join(liveDir(d), `${id}.json`), "utf8"));
const run = { launchId: "L1", role: "builder", rung: "model" as const, state: "ask" as const, tokensIn: 5, tokensOut: 2, cost: 0.12345678, startedAt: 0, endedAt: null };

test("label is the slug of the handoff dir name", () => {
  assert.equal(labelOfHandoff("/x/handoffs/20260101-120000-fix-login"), "fix-login");
  assert.equal(labelOfHandoff("C:\\x\\20260101-120000-fix-login-a1b2c3"), "fix-login");
  assert.equal(labelOfHandoff("/x/random"), null);
  assert.equal(labelOfHandoff(null), null);
});

test("intercom id: published id, env, config.json stableId, else the Pi session id", () => {
  const d = tmp();
  assert.equal(intercomIdOf({}, d, "sid"), "sid");
  fs.mkdirSync(path.join(d, "intercom"));
  fs.writeFileSync(path.join(d, "intercom", "config.json"), JSON.stringify({ stableId: "cfg-id" }));
  assert.equal(intercomIdOf({}, d, "sid"), "cfg-id");
  assert.equal(intercomIdOf({ PI_INTERCOM_STABLE_ID: "env-id" }, d, "sid"), "env-id");
  assert.equal(intercomIdOf({ PI_INTERCOM_SESSION_ID: "pub", PI_INTERCOM_STABLE_ID: "env-id" }, d, "sid"), "pub");
});

test("file shape, atomic write (no temp left), state transitions and done on stop", () => {
  const d = tmp();
  const env = { PI_FOREMAN_PARENT_INTERCOM: "par", PI_FOREMAN_HANDOFF_DIR: "/h/20260101-120000-job" };
  const l = LiveState.start({ agentDir: d, sessionId: "sess1", cwd: "/w", mode: "rpc", env, pid: 42 }, () => [run]);
  assert.ok(l);
  const a = read(d, "sess1");
  assert.deepEqual(Object.keys(a), ["v", "sessionId", "intercomId", "parentIntercom", "handoff", "label", "cwd", "pid", "mode", "startedAt", "paneId", "heartbeatAt", "lastEventAt", "state", "runs", "tokensIn", "tokensOut", "cost", "blockedSince"]);
  assert.equal(a.v, 1);
  assert.equal(a.parentIntercom, "par");
  assert.equal(a.label, "job");
  assert.equal(a.pid, 42);
  assert.equal(a.state, "idle");
  assert.deepEqual(a.runs, [{ launchId: "L1", role: "builder", rung: "model", state: "ask", tokensIn: 5, tokensOut: 2, cost: 0.1235 }]);
  l.onAgentStart();
  assert.equal(l.snapshot().state, "working");
  l.setBlocked(true);
  assert.equal(l.snapshot().state, "blocked");
  l.setBlocked(false);
  l.onSettled(false);
  assert.equal(l.snapshot().state, "working");
  l.onSettled(true);
  assert.equal(l.snapshot().state, "idle");
  l.stop();
  assert.equal(read(d, "sess1").state, "done");
  assert.deepEqual(fs.readdirSync(liveDir(d)), ["sess1.json"]);
});

test("an own ask holds blocked while Pi sends no ui_prompt_start (prompt depth stuck)", () => {
  const l = LiveState.start({ agentDir: tmp(), sessionId: "s", cwd: "/w", mode: "rpc", env: {} }, () => [])!;
  l.onAgentStart();
  const release = l.hold();
  assert.equal(l.snapshot().state, "blocked");
  release();
  release();
  assert.equal(l.snapshot().state, "working");
  l.stop();
});

test("own ask and Pi prompt overlap: neither end nor typed-input release clears the other", () => {
  const l = LiveState.start({ agentDir: tmp(), sessionId: "s", cwd: "/w", mode: "rpc", env: {} }, () => [])!;
  l.setBlocked(true);
  const release = l.hold();
  l.setBlocked(false); // ui_prompt_end, or the interactive `input` release of an orphaned dialog
  assert.equal(l.snapshot().state, "blocked");
  l.setBlocked(true);
  release();
  assert.equal(l.snapshot().state, "blocked");
  l.setBlocked(false);
  assert.equal(l.snapshot().state, "idle");
  l.stop();
});

test("print and json mode write nothing; runs are capped at 20", () => {
  const d = tmp();
  assert.equal(LiveState.start({ agentDir: d, sessionId: "p", cwd: "/w", mode: "print", env: {} }, () => []), null);
  assert.equal(LiveState.start({ agentDir: d, sessionId: "j", cwd: "/w", mode: "json", env: {} }, () => []), null);
  assert.equal(fs.existsSync(liveDir(d)), false);
  const l = LiveState.start({ agentDir: d, sessionId: "c", cwd: "/w", mode: "tui", env: {} }, () => Array.from({ length: 30 }, (_, i) => ({ ...run, launchId: `L${i}` })));
  assert.equal(read(d, "c").runs.length, 20);
  assert.equal(read(d, "c").runs[19].launchId, "L29");
  l?.stop();
});

test("paneId from HERDR_PANE_ID, else null; session totals from the getter; blockedSince set on empty -> blocked and cleared", () => {
  const d = tmp();
  const l = LiveState.start({ agentDir: d, sessionId: "p1", cwd: "/w", mode: "rpc", env: { HERDR_PANE_ID: "w1:p2" } }, () => [], () => ({ tokensIn: 1500.4, tokensOut: 20, cost: 0.123456 }))!;
  const a = read(d, "p1");
  assert.equal(a.paneId, "w1:p2");
  assert.deepEqual([a.tokensIn, a.tokensOut, a.cost, a.blockedSince], [1500, 20, 0.1235, null]);
  const n = LiveState.start({ agentDir: d, sessionId: "p2", cwd: "/w", mode: "rpc", env: { HERDR_PANE_ID: " " } }, () => [])!;
  assert.equal(read(d, "p2").paneId, null);
  assert.deepEqual([read(d, "p2").tokensIn, read(d, "p2").cost], [0, 0]);
  l.setBlocked(true);
  const since = l.snapshot().blockedSince;
  assert.ok(since && !Number.isNaN(Date.parse(since)));
  const release = l.hold(); // second source: the stamp stays
  assert.equal(l.snapshot().blockedSince, since);
  l.setBlocked(false);
  assert.equal(l.snapshot().blockedSince, since);
  release();
  assert.equal(l.snapshot().blockedSince, null);
  l.stop();
  n.stop();
});
