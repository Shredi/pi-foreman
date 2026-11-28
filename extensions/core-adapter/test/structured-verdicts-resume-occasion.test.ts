// A resumed review run (a new run id) keeps the occasion and shadow of the run it resumes at the run end: a resumed [plan-review] or
// [second-opinion] PASS marks no ledger item, a resumed normal item review still marks. (A high-stakes run cannot be resumed: highstakes-wiring.test.ts item 5.)
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { world, type WorldOpts } from "./_r46world.ts";

type W = ReturnType<typeof world>;
type Rig = Awaited<ReturnType<W["adapter"]>>;

const LEDGER = "# Ledger: x\nTier: standard\n\n- [ ] 1. first\n- [ ] 2. second\n- [ ] 3. third\n- [ ] V. verify\n";
const ledgerOf = (w: W): string => fs.readFileSync(path.join(w.project, ".workflow", "LEDGER-x.md"), "utf8");
const marked = (w: W, n: number | string): boolean => new RegExp(`- \\[x\\] ${n}\\. `).test(ledgerOf(w));
const reviewEnd = (runId: string, status: string) => ({ runId, agent: "reviewer", success: status === "completed", status, results: [{ agent: "reviewer", status, success: status === "completed", output: "report" }] });
const PASS = { verdict: "pass" as const, items: [{ id: 1, result: "pass" as const }, { id: 2, result: "pass" as const }] };

async function setup(t: Parameters<typeof world>[0], o: WorldOpts = {}) {
  const w = world(t, { ceremony: { default: "standard" }, ...o });
  const a = await w.adapter("startup");
  await a.writeLedger(LEDGER);
  return { w, a };
}

/**
 * Waits for what a run end set going: the end handler returns before the ledger marks (a python child) and the review record land. The settle gate awaits the same chain the production
 * stop guard does ("PASS marks and the comment-only check land before the stop guard reads the ledger"), so afterwards a mark that was going to land has landed, and a mark absent now is no late one.
 */
const landed = async (a: Rig): Promise<void> => {
  const settled = a.fire("agent_before_settle", { outcome: "completed", entries: [] });
  assert.ok(settled !== undefined, "agent_before_settle handler is not registered");
  await settled;
};

async function resume(a: Rig, target: string, runId: string): Promise<void> {
  const id = `res-${runId}`;
  const input = { action: "resume", id: target, message: "finish the review" };
  await a.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } });
  const res = (await a.fire("tool_call", { toolName: "subagent", toolCallId: id, input })) as { block?: boolean; reason?: string } | undefined;
  assert.ok(!res?.block, res?.reason);
  await a.fire("tool_result", { toolName: "subagent", toolCallId: id, input, details: { runId }, content: [{ type: "text", text: "started" }], isError: false });
}

/** Launch `task`, end it timed-out, resume it as a new run, leave a PASS record for items 1 and 2 and end the resumed run completed. */
async function resumedPass(t: Parameters<typeof world>[0], task: string, extra: Record<string, unknown>) {
  const { w, a } = await setup(t);
  const first = await a.reviewLaunch(task, extra);
  assert.equal(first.blocked, null, String(first.blocked));
  await a.endEvent(reviewEnd(`run-${first.id}`, "timed-out"));
  await landed(a);
  await resume(a, `run-${first.id}`, "run-resumed");
  assert.ok(a.record(first.id, PASS), "the folder takes the record");
  await a.endEvent(reviewEnd("run-resumed", "completed"));
  await landed(a);
  return { w, a };
}

test("a resumed [plan-review] PASS marks nothing", async (t) => {
  const { w } = await resumedPass(t, "[plan-review] review .workflow/scratch/plan-widget.md", { items: [1, 2] });
  assert.ok(!marked(w, 1) && !marked(w, 2), ledgerOf(w));
  assert.equal((await w.traceEvents()).filter((e) => e.event === "ledger_mark_by_review").length, 0);
});

test("a resumed [second-opinion] PASS marks nothing and opens no gate", async (t) => {
  const { w } = await resumedPass(t, "[second-opinion] look at the items", { items: [1, 2] });
  assert.ok(!marked(w, 1) && !marked(w, 2), ledgerOf(w));
  assert.equal((await w.traceEvents()).filter((e) => e.event === "ledger_mark_by_review").length, 0);
  assert.equal((await w.traceEvents()).filter((e) => e.event === "review_recorded").length, 0, "no gate verdict recorded");
});

test("a resumed normal item review still marks its passed items", async (t) => {
  const { w } = await resumedPass(t, "review the items", { items: [1, 2] });
  assert.ok(marked(w, 1) && marked(w, 2), ledgerOf(w));
  assert.ok(!marked(w, 3), ledgerOf(w));
});
