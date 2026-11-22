// A merge-then-close marks the entry closed with a pending result first (the self-clean needs it closed); a ChildBlocked pass inside the self-finish gap resolves nothing.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildBlocked, PENDING_RESULT_MS } from "../childblocked.ts";
import { CloseFlow } from "../close.ts";
import type { CloseDeps } from "../close.ts";
import { markOwnClosed, readRegistry, writeRegistry } from "../session.ts";

function setup(t: { after: (f: () => void) => void }, now?: () => number) {
  const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "close-pending-")));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const handoff = path.join(agentDir, "handoffs", "20261121-100000-job");
  const wtFile = path.join(agentDir, "wt", "result-job.md");
  const kept = path.join(agentDir, "kept", "result-job.md");
  fs.mkdirSync(path.dirname(wtFile), { recursive: true });
  fs.mkdirSync(path.dirname(kept), { recursive: true });
  fs.writeFileSync(wtFile, "result");
  writeRegistry(agentDir, { version: 1, sessions: [{ label: "job", child: "fm-job-1", parent: "fm-parent", handoff, status: "open" }] });
  const calls: [string, string][] = [];
  const cb = new ChildBlocked({ agentDir, sessionId: "parent-sess", opener: () => "fm-parent", seconds: () => 600, send: () => undefined, childClosed: (l, p) => void calls.push([l, p]), ...(now ? { now } : {}) });
  cb.tick();
  const mk = (merged: number | null, selfFinish: CloseDeps["selfFinish"]): CloseFlow => {
    const files = new Map<string, string>([[wtFile, "result"]]);
    const deps: CloseDeps = {
      activeWaits: () => [], activeRuns: () => 0, sendUserMessage: () => undefined,
      runSync: async () => ({ text: "sync ok", ok: true }), retro: async () => "", reply: () => undefined, notify: () => undefined, trace: () => undefined, markCause: () => undefined,
      writeStub: (f, text) => void files.set(f, text), exists: (f) => files.has(f), setTimer: () => () => undefined,
      markClosed: (file, pending) => void markOwnClosed(agentDir, { PI_FOREMAN_HANDOFF_DIR: handoff }, file, pending),
      report: async () => null, selfFinish, appendResult: () => undefined, mergedPr: () => merged,
    };
    return new CloseFlow(deps);
  };
  return { agentDir, wtFile, kept, calls, cb, mk };
}
const run = async (flow: CloseFlow, wtFile: string): Promise<void> => {
  const ctx = { isIdle: () => true, shutdown: () => undefined };
  void flow.request({ source: "intercom-parent", file: wtFile, shown: wtFile, replyTo: "parent-1" }, ctx);
  flow.onInput(flow.closeText(), "extension");
  flow.onModelReply("stop");
  await flow.onSettled(ctx);
};

test("a pass inside the self-finish gap resolves nothing; the next pass resolves with the kept copy", async (t) => {
  const s = setup(t);
  let gap: unknown[] = [];
  let entry: { status?: string; result?: string; resultPending?: unknown } | undefined;
  const flow = s.mk(7, async () => {
    entry = readRegistry(s.agentDir).sessions[0];
    s.cb.tick();
    gap = [...s.calls];
    return { lines: ["cleanup: ok"], spawn: () => fs.rmSync(s.wtFile), keepResult: () => (fs.copyFileSync(s.wtFile, s.kept), s.kept) };
  });
  await run(flow, s.wtFile);
  assert.equal(entry?.status, "closed"); // closed before the self-clean
  assert.equal(typeof entry?.resultPending, "number");
  assert.equal(entry?.result, s.wtFile); // the crash fallback path
  assert.deepEqual(gap, []);
  const e = readRegistry(s.agentDir).sessions[0];
  assert.equal(e.resultPending, undefined);
  assert.equal(e.result, s.kept);
  s.cb.tick();
  assert.deepEqual(s.calls, [["job", s.kept]]);
});

test("a stale pending marker resolves with whatever result the entry has", (t) => {
  let now = 1_000_000;
  const s = setup(t, () => now);
  markOwnClosed(s.agentDir, { PI_FOREMAN_HANDOFF_DIR: path.join(s.agentDir, "handoffs", "20261121-100000-job") }, s.wtFile, true);
  const reg = readRegistry(s.agentDir);
  reg.sessions[0].resultPending = now - 1000;
  reg.sessions[0].result = s.wtFile;
  writeRegistry(s.agentDir, reg);
  s.cb.tick();
  assert.deepEqual(s.calls, []);
  now += PENDING_RESULT_MS;
  s.cb.tick();
  assert.deepEqual(s.calls, [["job", s.wtFile]]);
});

test("no self-finish: a single mark without the marker, resolved by the next pass", async (t) => {
  const s = setup(t);
  await run(s.mk(null, undefined), s.wtFile);
  const e = readRegistry(s.agentDir).sessions[0];
  assert.equal(e.status, "closed");
  assert.equal(e.resultPending, undefined);
  assert.equal(e.result, s.wtFile);
  s.cb.tick();
  assert.deepEqual(s.calls, [["job", s.wtFile]]);
});

test("crash fallback: the pending mark carries req.file, so the stale marker resolves with that path", (t) => {
  const s = setup(t);
  const env = { PI_FOREMAN_HANDOFF_DIR: path.join(s.agentDir, "handoffs", "20261121-100000-job") };
  markOwnClosed(s.agentDir, env, s.wtFile, true);
  const e = readRegistry(s.agentDir).sessions[0];
  assert.equal(e.result, s.wtFile);
  assert.equal(typeof e.resultPending, "number");
});

test("a re-opened entry's stale marker is cleared by the next close", (t) => {
  const s = setup(t);
  const env = { PI_FOREMAN_HANDOFF_DIR: path.join(s.agentDir, "handoffs", "20261121-100000-job") };
  const reg = readRegistry(s.agentDir);
  reg.sessions[0].resultPending = Date.now();
  writeRegistry(s.agentDir, reg);
  markOwnClosed(s.agentDir, env, s.wtFile);
  const e = readRegistry(s.agentDir).sessions[0];
  assert.equal(e.status, "closed");
  assert.equal(e.resultPending, undefined);
  s.cb.tick();
  assert.deepEqual(s.calls, [["job", s.wtFile]]);
});
