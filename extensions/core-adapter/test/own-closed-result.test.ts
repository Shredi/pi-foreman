// A child's own close records its result path in its registry entry, so an idle parent that never reads the quiet `foreman:closed` ack still has it:
// the ChildBlocked pass hands that path to `childClosed`.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildBlocked } from "../childblocked.ts";
import { markOwnClosed, readRegistry, writeRegistry } from "../session.ts";

test("own close with a result path: the entry has `result`; the ChildBlocked pass passes it to childClosed", (t) => {
  const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "own-closed-result-")));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const handoff = path.join(agentDir, "handoffs", "20261121-100000-job");
  writeRegistry(agentDir, { version: 1, sessions: [{ label: "job", child: "fm-job-1", parent: "fm-parent", handoff, status: "open" }] });
  const calls: [string, string][] = [];
  const cb = new ChildBlocked({ agentDir, sessionId: "parent-sess", opener: () => "fm-parent", seconds: () => 600, send: () => undefined, childClosed: (l, p) => void calls.push([l, p]) });
  cb.tick();
  const result = "/proj/.workflow/result-job.md";
  assert.equal(markOwnClosed(agentDir, { PI_FOREMAN_HANDOFF_DIR: handoff }, result), true);
  const e = readRegistry(agentDir).sessions[0];
  assert.equal(e.status, "closed");
  assert.equal(e.result, result);
  cb.tick();
  assert.deepEqual(calls, [["job", result]]);
});
