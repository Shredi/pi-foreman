// D142: a resume after an item FAIL takes the failed items still open (the fresh launch's after-FAIL rule), not every open item.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readItemsSidecar } from "../verdict.ts";
import { tick, world } from "./_r46world.ts";
import { bindingOf } from "./_verdict-rig.ts";

process.env.PI_OFFLINE = "1";

const LEDGER = "# Ledger: x\nTier: standard\n\n- [ ] 1. first\n- [ ] 2. second\n- [ ] 3. third\n";

test("item FAIL on 1 and 2 of open 1, 2, 3, item 4 added, resume without items: allowed set is [1, 2]; a PASS on 3 is rejected", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  await a.writeLedger(LEDGER);
  const first = await a.reviewLaunch("review items 1, 2 and 3 of the diff");
  assert.equal(first.blocked, null, String(first.blocked));
  const dir = bindingOf(a.inputOf(first.id))!.verdictDir!;
  assert.deepEqual(bindingOf(a.inputOf(first.id))!.items, [1, 2, 3]);
  a.endRun(first.id, "Overall verdict: FAIL\n1. FAIL: first is wrong\n2. FAIL: second is wrong\n");
  await tick(200);

  await a.writeLedger(`${LEDGER}- [ ] 4. fourth\n`);
  const id = "rafterfail";
  const input: Record<string, unknown> = { action: "resume", id: `run-${first.id}`, message: "go on" };
  await a.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } });
  const res = (await a.fire("tool_call", { toolName: "subagent", toolCallId: id, input })) as { block?: boolean; reason?: string } | undefined;
  assert.equal(res?.block, undefined, res?.reason);
  await a.fire("tool_result", { toolName: "subagent", toolCallId: id, input, details: { runId: `run-${id}` }, content: [{ type: "text", text: "started" }], isError: false });
  assert.deepEqual(readItemsSidecar(dir), [1, 2], "the failed items still open");

  a.record(first.id, { verdict: "pass", items: [{ id: 3, result: "pass" }] });
  a.endEvent({ runId: `run-${id}`, agent: "reviewer", success: true, status: "completed", results: [{ agent: "reviewer", status: "completed", success: true, output: "report" }] });
  await tick(400);
  const events = await w.traceEvents();
  assert.ok(events.some((e) => e.event === "review_record_invalid"), "item 3 is outside the re-review set");
});
