// A merge-then-close: the worktree cleanup deletes the result file, so the registry entry (read by an idle parent and the ChildBlocked wait result) names the kept copy.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildBlocked } from "../childblocked.ts";
import { CloseFlow } from "../close.ts";
import type { CloseDeps } from "../close.ts";
import { markOwnClosed, readRegistry, writeRegistry } from "../session.ts";

test("merge then close: the registry entry's result is the kept copy, and ChildBlocked passes that path on", async (t) => {
  const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "merge-kept-")));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const handoff = path.join(agentDir, "handoffs", "20261121-100000-job");
  const wtFile = path.join(agentDir, "wt", "result-job.md");
  const kept = path.join(agentDir, "kept", "result-job.md");
  fs.mkdirSync(path.dirname(wtFile), { recursive: true });
  fs.mkdirSync(path.dirname(kept), { recursive: true });
  fs.writeFileSync(wtFile, "result");
  writeRegistry(agentDir, { version: 1, sessions: [{ label: "job", child: "fm-job-1", parent: "fm-parent", handoff, status: "open" }] });
  const calls: [string, string][] = [];
  const cb = new ChildBlocked({ agentDir, sessionId: "parent-sess", opener: () => "fm-parent", seconds: () => 600, send: () => undefined, childClosed: (l, p) => void calls.push([l, p]) });
  cb.tick();

  const files = new Map<string, string>([[wtFile, "result"]]);
  const acks: string[] = [];
  const deps: CloseDeps = {
    activeWaits: () => [],
    activeRuns: () => 0,
    sendUserMessage: () => undefined,
    runSync: async () => ({ text: "sync ok", ok: true }),
    retro: async () => "",
    reply: (_to, text) => void acks.push(text),
    notify: () => undefined,
    trace: () => undefined,
    markCause: () => undefined,
    writeStub: (f, text) => void files.set(f, text),
    exists: (f) => files.has(f),
    setTimer: () => () => undefined,
    markClosed: (file) => void markOwnClosed(agentDir, { PI_FOREMAN_HANDOFF_DIR: handoff }, file),
    report: async () => null,
    selfFinish: async () => ({
      lines: ["cleanup: ok"],
      spawn: () => fs.rmSync(wtFile), // the detached cleanup removes the worktree file
      keepResult: () => (fs.copyFileSync(wtFile, kept), kept),
    }),
    appendResult: () => undefined,
    mergedPr: () => 7,
  };
  const flow = new CloseFlow(deps);
  const ctx = { isIdle: () => true, shutdown: () => undefined };
  flow.request({ source: "intercom-parent", file: wtFile, shown: wtFile, replyTo: "parent-1" }, ctx);
  flow.onInput(flow.closeText(), "extension");
  flow.onModelReply("stop");
  await flow.onSettled(ctx);

  fs.rmSync(wtFile, { force: true });
  const e = readRegistry(agentDir).sessions[0];
  assert.equal(e.status, "closed");
  assert.equal(e.result, kept);
  assert.ok(fs.existsSync(e.result!));
  assert.ok(acks.some((a) => a.includes(kept)), acks.join("|"));
  cb.tick();
  assert.deepEqual(calls, [["job", kept]]);
});
