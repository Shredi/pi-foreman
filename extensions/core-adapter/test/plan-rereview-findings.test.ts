// A plan re-review task after a FAIL carries the earlier findings block (item 6b); after a PASS it carries none. The findings
// survive a reload (the ceremony-state lineage entry) and the plan store (a reload that has no ceremony entry).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tick, world } from "./_r46world.ts";
import type { RecSpec } from "./_verdict-rig.ts";

const FAIL: RecSpec = { verdict: "fail", findings: [{ kind: "defect", text: "the plan skips the rollback", file: "plan-widget.md", line: 3 }] };
async function ready(t: Parameters<typeof world>[0]) {
  const w = world(t, { ceremony: { default: "standard" } });
  const a = await w.adapter("startup");
  fs.appendFileSync(w.planFile, "\n## Decisions and assumptions\nNone.\n\n## Open questions\nNone.\n");
  await a.writeLedger("# Ledger: x\n\n- [ ] 1. item\n");
  return { w, a };
}
const revise = (w: ReturnType<typeof world>) => fs.appendFileSync(w.planFile, "\nA revised line.\n");

test("after a FAIL the re-review task carries the earlier findings; after a PASS it does not", async (t) => {
  const { w, a } = await ready(t);
  const first = await a.reviewLaunch();
  assert.doesNotMatch(first.task, /earlier findings/, "a first review has none");
  a.endRunRecord(first.id, FAIL);
  await tick();
  revise(w);
  const second = await a.reviewLaunch();
  assert.equal(second.blocked, null);
  assert.match(second.task, /\[pi-foreman earlier findings\]/);
  assert.match(second.task, /the plan skips the rollback/);
  a.endRunRecord(second.id, { verdict: "pass" });
  await tick();
  revise(w);
  const third = await a.reviewLaunch();
  assert.doesNotMatch(third.task, /earlier findings/, "the last verdict was a PASS");
});

test("the findings come back after a reload (ceremony-state entry)", async (t) => {
  const { w, a } = await ready(t);
  const first = await a.reviewLaunch();
  a.endRunRecord(first.id, FAIL);
  await tick();
  await a.down();
  revise(w);
  const b = await w.adapter("reload");
  const again = await b.reviewLaunch();
  assert.match(again.task, /the plan skips the rollback/);
});

test("the findings come back from the plan store when the ceremony entry is gone", async (t) => {
  const { w, a } = await ready(t);
  const first = await a.reviewLaunch();
  a.endRunRecord(first.id, FAIL);
  await tick();
  await a.down();
  w.entries.length = 0; // no ceremony-state entry: only the approval store remains
  const b = await w.adapter("reload");
  const again = await b.reviewLaunch();
  assert.match(again.task, /the plan skips the rollback/);
});
