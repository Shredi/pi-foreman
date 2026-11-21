// D142: a resume computes the reviewer's items against the ledger its target run was launched for (a task that named one), not the session's bound ledger.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { readItemsSidecar } from "../verdict.ts";
import { tick, world } from "./_r46world.ts";
import { bindingOf } from "./_verdict-rig.ts";

process.env.PI_OFFLINE = "1";

const LEDGER_X = "# Ledger: x\nTier: standard\n\n- [ ] 1. first\n- [ ] 2. second\n";
const LEDGER_Y = "# Ledger: y\nTier: standard\n\n- [ ] 5. fifth\n- [ ] 6. sixth\n";

test("named ledger y, FAIL, resume: items 5 and 6 are written, the PASS record is valid and marked on ledger y", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  await a.writeLedger(LEDGER_X);
  const yFile = path.join(w.project, ".workflow", "LEDGER-y.md");
  fs.writeFileSync(yFile, LEDGER_Y);
  const first = await a.reviewLaunch("review items 5 and 6, ledger .workflow/LEDGER-y.md");
  assert.equal(first.blocked, null, String(first.blocked));
  const dir = bindingOf(a.inputOf(first.id))!.verdictDir!;
  assert.deepEqual(bindingOf(a.inputOf(first.id))!.items, [5, 6]);
  a.endRun(first.id, "Overall verdict: FAIL\n5. FAIL: fifth is wrong\n");
  await tick(200);

  const id = "rnamed";
  const input: Record<string, unknown> = { action: "resume", id: `run-${first.id}`, message: "go on" };
  await a.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } });
  const res = (await a.fire("tool_call", { toolName: "subagent", toolCallId: id, input })) as { block?: boolean; reason?: string } | undefined;
  assert.equal(res?.block, undefined, res?.reason);
  await a.fire("tool_result", { toolName: "subagent", toolCallId: id, input, details: { runId: `run-${id}` }, content: [{ type: "text", text: "started" }], isError: false });
  assert.deepEqual(readItemsSidecar(dir), [5, 6], "the target's ledger, not the bound one");

  a.record(first.id, { verdict: "pass", items: [{ id: 5, result: "pass" }, { id: 6, result: "pass" }] });
  a.endEvent({ runId: `run-${id}`, agent: "reviewer", success: true, status: "completed", results: [{ agent: "reviewer", status: "completed", success: true, output: "report" }] });
  await tick(400);
  const events = await w.traceEvents();
  assert.deepEqual(events.filter((e) => e.event === "review_record_invalid"), []);
  assert.ok(events.some((e) => e.event === "review_recorded"), "the PASS record is recorded");
  const y = fs.readFileSync(yFile, "utf8");
  assert.doesNotMatch(y, /- \[ \] [56]\./, `items 5 and 6 are marked on ledger y:\n${y}`);
  assert.match(fs.readFileSync(path.join(w.project, ".workflow", "LEDGER-x.md"), "utf8"), /- \[ \] 1\./, "the bound ledger is untouched");
});
