// R26 regression: the spawn-length ledger guard measures the caller's task, not the task after the harness prepends (re-review line).
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

const FAIL = "Overall verdict: FAIL\n1. the parser drops the last line\n";
const LINE = "[pi-foreman re-review]";

/** A builder run, then a reviewer FAIL: the next reviewer launch is a re-review and its task gets the re-review line first. */
async function afterFail(t: Parameters<typeof r11Rig>[0]) {
  const a = await r11Rig(t, { default: "standard", revisionRounds: { standard: 1 } });
  const builder = { agent: "builder", task: "build it" };
  const b = await a.launch(builder);
  await a.started(b.id, builder, "run-b");
  a.end({ runId: "run-b", agent: "builder", status: "completed", success: true, summary: "built" });
  const r = { agent: "reviewer", task: "review items 1" };
  const first = await a.launch(r);
  await a.started(first.id, r, "run-r1");
  a.end({ runId: "run-r1", agent: "reviewer", status: "completed", success: true, output: FAIL });
  return a;
}

test("the spawn gate measures the reviewer's own 1400 characters, not the re-review line prepended before it", async (t) => {
  const a = await afterFail(t);
  const task = `review items 1 ${"a".repeat(1385)}`;
  assert.equal(task.length, 1400);
  const next = { agent: "reviewer", task };
  const res = await a.launch(next);
  assert.ok(next.task.startsWith(LINE), "the harness prepended the re-review line");
  assert.ok(next.task.length > 1500, "the prepends alone would pass the threshold");
  assert.equal(res.res, undefined);
});

test("the spawn gate still blocks a reviewer task whose own text is over 1500 characters", async (t) => {
  const a = await afterFail(t);
  const next = { agent: "reviewer", task: `review items 1 ${"a".repeat(1500)}` };
  const res = await a.launch(next);
  assert.match(res.res?.reason ?? "", /LEDGER GUARD: this looks like a detailed delegation \(spawn prompt > 1500 chars\)/);
});
