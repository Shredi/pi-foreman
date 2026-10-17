// R11 P2 extra fix round (item 5): finalization is off while an accepted subagent launch has no tool_result yet, so a
// launch plus reads in one message do not skip the read budget. Rule for a launch whose tool_result is an error with
// no run started: it changes no budget state (like any refused launch), so the prior finalization holds again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_READ_LIMITS } from "../budget.ts";
import { r11Rig } from "./_r11rig.ts";

const DENY = DEFAULT_READ_LIMITS.before.deny;
const readDenied = (r: { block?: boolean; reason?: string } | undefined): boolean => r?.block === true && /\[read_budget_exceeded\]/.test(r.reason ?? "");

async function finalized(t: Parameters<typeof r11Rig>[0]) {
  const a = await r11Rig(t);
  const finalizer = { agent: "finalizer", task: "write the changelog and result" };
  const l = await a.launch(finalizer);
  assert.equal(l.res, undefined);
  await a.started(l.id, finalizer, "run-fin");
  a.end({ runId: "run-fin", agent: "finalizer", status: "completed", success: true, summary: "done" });
  for (let i = 0; i < DENY + 2; i++) assert.ok(!readDenied(await a.call("bash", { command: `ls -la f${i}` })), "finalization: no read budget");
  return a;
}

test("read_budget_finalization_ends_on_accepted_launch", async (t) => {
  const a = await finalized(t);
  const builder = { agent: "builder", task: "fix item 5" };
  const l = await a.launch(builder);
  assert.equal(l.res, undefined, "the builder launch is accepted");
  // no tool_result yet: reads past the budget are refused
  const out = [];
  for (let i = 0; i < DENY + 1; i++) out.push(await a.call("bash", { command: `ls -la g${i}` }));
  assert.ok(out.some(readDenied), "the read budget applies while the accepted launch has no result");
});

test("read_budget_finalization_resumes_after_errored_launch_with_no_run", async (t) => {
  const a = await finalized(t);
  const builder = { agent: "builder", task: "fix item 5" };
  const l = await a.launch(builder);
  assert.equal(l.res, undefined);
  assert.ok(readDenied(await (async () => { let r; for (let i = 0; i < DENY + 1; i++) r = await a.call("bash", { command: `ls -la h${i}` }); return r; })()), "pending launch: budget applies");
  // the launch's tool_result is an error and no run started: no budget state changed, finalization holds again
  await a.errored(l.id, builder);
  for (let i = 0; i < DENY + 2; i++) assert.ok(!readDenied(await a.call("bash", { command: `ls -la k${i}` })), "finalization holds after a launch that never started");
});
