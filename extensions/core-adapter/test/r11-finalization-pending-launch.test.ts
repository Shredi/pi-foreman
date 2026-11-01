// R11 P2 extra fix round (item 5): finalization is off while an accepted subagent launch has no tool_result yet, so a
// launch plus reads in one message do not skip the read budget. Rule for a launch whose tool_result is an error with
// no run started: it changes no budget state (like any refused launch), so the prior finalization holds again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_READ_LIMITS } from "../budget.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

const WARN = DEFAULT_READ_LIMITS.before.warn;
const reminds = (a: Awaited<ReturnType<typeof r11Rig>>): number => a.events("read_budget").filter((r) => r.action === "remind").length;
const readDenied = (r: { block?: boolean; reason?: string } | undefined): boolean => r?.block === true && /\[read_budget_exceeded\]/.test(r.reason ?? "");

const recheckDenied = (r: { block?: boolean; reason?: string } | undefined): boolean => r?.block === true && /\[recheck_budget_exceeded\]/.test(r.reason ?? "");

async function finalized(t: Parameters<typeof r11Rig>[0]) {
  const a = await r11Rig(t, {}, reviewAllowOpts());
  const review = { agent: "reviewer", task: "review the diff" };
  const l = await a.launch(review);
  assert.equal(l.res, undefined);
  await a.started(l.id, review, "run-fin");
  a.end({ runId: "run-fin", agent: "reviewer", status: "completed", success: true, summary: "VERDICT: PASS" });
  await a.notice("Background task completed: **reviewer**\nOverall verdict: PASS");
  for (let i = 0; i < WARN + 2; i++) assert.ok(!readDenied(await a.call("bash", { command: `ls -la f${i}` })), "finalization: no read budget");
  assert.equal(reminds(a), 0);
  return a;
}

test("read_budget_finalization_ends_on_accepted_launch", async (t) => {
  const a = await finalized(t);
  const builder = { agent: "builder", task: "fix item 5" };
  const l = await a.launch(builder);
  assert.equal(l.res, undefined, "the builder launch is accepted");
  // no tool_result yet: the finalization exemption is off, so the spent recheck budget refuses even a git commit
  assert.ok(recheckDenied(await a.call("bash", { command: "git commit -m done" })), "the budget applies while the accepted launch has no result");
});

test("read_budget_finalization_resumes_after_errored_launch_with_no_run", async (t) => {
  const a = await finalized(t);
  const builder = { agent: "builder", task: "fix item 5" };
  const l = await a.launch(builder);
  assert.equal(l.res, undefined);
  assert.ok(recheckDenied(await a.call("bash", { command: "git commit -m done" })), "pending launch: budget applies");
  // the launch's tool_result is an error and no run started: no budget state changed, finalization holds again
  await a.errored(l.id, builder);
  assert.ok(!recheckDenied(await a.call("bash", { command: "git commit -m done" })), "finalization holds after a launch that never started");
  assert.equal(reminds(a), 0, "no read reminder");
});
