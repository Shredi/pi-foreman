import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { ReadBudget, DEFAULT_READ_LIMITS } from "../budget.ts";
import { ownedRoots } from "../owned.ts";
import { ownTaskReadable } from "../roundsurface.ts";
import { recheckExempt } from "../recheckexempt.ts";

const L = DEFAULT_READ_LIMITS;
const exhausted = (verdict?: "pass" | "fail" | "none" | null) => {
  const b = new ReadBudget();
  if (verdict !== undefined) b.verdict = verdict;
  b.enterPost();
  for (const id of ["a", "b", "c"]) b.check("bash", id, L, 3, false);
  const d = b.check("bash", "d", L, 3, false);
  assert.ok(d.kind === "deny" && d.event === "recheck_budget");
  return d.reason;
};

test("recheck_text_after_fail_names_fail", () => {
  const r = exhausted("fail");
  assert.ok(r.includes("the last review FAILED"), r);
  assert.ok(!r.includes("the reviewer passed"), r);
  assert.ok(!/pass|finish now/i.test(r), r);
});

test("recheck_text_no_review_no_pass_wording", () => {
  for (const v of ["none" as const, null]) {
    const r = exhausted(v);
    assert.ok(r.includes("no review is recorded"), r);
    assert.ok(!/pass|finish now/i.test(r), r);
  }
});

test("recheck_text_after_pass_unchanged", () => {
  for (const v of [undefined, "pass" as const]) assert.ok(exhausted(v).includes("the reviewer passed; finish now"));
});

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
