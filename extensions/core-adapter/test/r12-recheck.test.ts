import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { ownedRoots } from "../owned.ts";
import { ownTaskReadable } from "../roundsurface.ts";
import { recheckExempt } from "../recheckexempt.ts";

const agentDir = path.resolve("/t/agent");
const cwd = path.resolve("/t/work/repo");
const owned = ownedRoots({ agentDir, workspaceRoot: cwd, tmpRoot: path.resolve("/t/tmp") });
const ctx = { cwd, home: path.resolve("/t/home"), platform: process.platform, owned, ownTasks: ownTaskReadable([cwd], "sess-1", process.platform) };

test("recheck_tail_own_bg_run_log_exempt", () => {
  const log = path.join(cwd, ".pi", "tasks", "sess-1-4242", "t1.log");
  assert.equal(recheckExempt("bash", { command: `tail -n 50 ${log}` }, ctx), true);
  assert.equal(recheckExempt("bash", { command: "cat .pi/tasks/sess-1-4242/t1.log" }, ctx), true);
  assert.equal(recheckExempt("bash", { command: `head -20 ${log}` }, ctx), true);
});

test("recheck_tail_foreign_task_log_counted", () => {
  const foreign = path.join(cwd, ".pi", "tasks", "other-4242", "t1.log");
  assert.equal(recheckExempt("bash", { command: `tail -n 50 ${foreign}` }, ctx), false);
  assert.equal(recheckExempt("bash", { command: `cat ${path.join(cwd, ".pi", "tasks", "sess-10-1", "x")}` }, ctx), false);
  assert.equal(recheckExempt("bash", { command: `cat ${path.join(cwd, ".pi", "tasks", "sess-1-4242", "..", "other-1", "x")}` }, ctx), false);
});
