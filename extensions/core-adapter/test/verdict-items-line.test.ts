// Every review task names the items review_verdict takes (verdict.ts launchItemsLine): the set of the launch's binding, so the first call of a plan
// reviewer is not refused for item V; a re-review line lists only the failed items that set takes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, tick } from "./_r46world.ts";
import { bindingOf } from "./_verdict-rig.ts";
import { allowedItems, checkVerdictCall, launchItemsLine, type ItemId } from "../verdict.ts";

const LEDGER = "# Ledger: x\nTier: standard\n\n- [ ] 1. first\n- [ ] 2. second\n- [ ] V. fresh-eyes verification passed\n";
const LINE = /^\[pi-foreman verdict items\] (.*)$/m;

/** The ids the items line of a launched task names (empty for "takes no items"). */
function idsOf(task: string): ItemId[] {
  const m = LINE.exec(task);
  assert.ok(m, task);
  const named = /these items only: ([^.]*)\./.exec(m[1])?.[1];
  return named ? named.split(", ").map((x) => (x === "V" ? "V" : Number(x))) : [];
}

const call = (ids: ItemId[]) => ({ verdict: "pass", items: ids.map((id) => ({ id, result: "pass" })) });

test("plan review: the task names the open numbered items, no V, and a verdict naming exactly those ids is accepted", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  await a.writeLedger(LEDGER);
  const r = await a.reviewLaunch();
  assert.equal(r.blocked, null, String(r.blocked));
  assert.deepEqual(idsOf(r.task), [1, 2]);
  assert.equal(r.task.match(/\[pi-foreman verdict items\]/g)?.length, 1);
  assert.ok(r.task.indexOf("[pi-foreman verdict items]") > r.task.indexOf("## Plan review facts"), "the line follows the facts");
  assert.match(r.task, /Plan: /, "the facts block is still there");
  const allowed = allowedItems(bindingOf(a.inputOf(r.id))?.items, false);
  assert.deepEqual(allowed, [1, 2]);
  assert.ok("call" in checkVerdictCall(call(idsOf(r.task)), allowed));
  assert.ok("error" in checkVerdictCall(call(["V"]), allowed), "V stays refused");
});

test("a launch whose items field names V lists V, and the tool takes it", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  await a.writeLedger(LEDGER);
  const r = await a.reviewLaunch("[plan-review] review .workflow/scratch/plan-widget.md", { items: [1, "V"] });
  assert.equal(r.blocked, null, String(r.blocked));
  assert.deepEqual(idsOf(r.task), [1, "V"]);
  const allowed = allowedItems(bindingOf(a.inputOf(r.id))?.items, false);
  assert.ok("call" in checkVerdictCall(call(idsOf(r.task)), allowed));
});

test("the line names no item to the ledger block: a plain reviewer task still gets the whole ledger", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  await a.writeLedger(LEDGER);
  const r = await a.reviewLaunch("review the diff");
  assert.equal(r.blocked, null, String(r.blocked));
  assert.match(r.task, /\[pi-foreman ledger\] The ledger of this round/);
  assert.doesNotMatch(r.task, /\[pi-foreman ledger items\]/);
  assert.deepEqual(idsOf(r.task), [1, 2]);
});

test("the line helper: a high-stakes launch and a launch without items take none, and the allowed set follows the helper", () => {
  assert.deepEqual(allowedItems([1, 2, "V"], true), []);
  assert.deepEqual(allowedItems(undefined, false), []);
  assert.match(launchItemsLine([]), /this launch takes no items: give review_verdict no items\.$/);
  assert.match(launchItemsLine([3, "V"]), /these items only: 3, V\. Give no result for any other id/);
  assert.doesNotMatch(launchItemsLine([1, 2]), /\bitems?\s+\d/);
  assert.ok("call" in checkVerdictCall({ verdict: "pass" }, allowedItems([1], true)), "an empty list is accepted");
});

test("re-review line: a failed item that is closed now is not listed, one that is open and allowed is", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  await a.writeLedger(LEDGER);
  const first = await a.reviewLaunch("review items 1 and 2 of the diff");
  assert.equal(first.blocked, null, String(first.blocked));
  a.endRun(first.id, "Overall verdict: FAIL\n1. FAIL: first is wrong\n");
  await tick(200);
  const open = await a.reviewLaunch("review items 1 and 2 of the diff");
  assert.match(open.task, /\[re-review items: 1\]/);
  await a.writeLedger(LEDGER.replace("- [ ] 1. first", "- [x] 1. first"));
  const closed = await a.reviewLaunch("review item 2 of the diff");
  assert.doesNotMatch(closed.task, /\[re-review items:/, closed.task);
  assert.deepEqual(idsOf(closed.task), [2]);
});

test("re-review line: with an items field the line lists the failed items that field takes", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  await a.writeLedger(LEDGER);
  const first = await a.reviewLaunch("review items 1 and 2 of the diff");
  a.endRun(first.id, "Overall verdict: FAIL\n1. FAIL: first is wrong\n");
  await tick(200);
  const other = await a.reviewLaunch("review item 2 of the diff", { items: [2] });
  assert.equal(other.blocked, null, String(other.blocked));
  assert.doesNotMatch(other.task, /\[re-review items:/, other.task);
  assert.deepEqual(idsOf(other.task), [2]);
  const same = await a.reviewLaunch("review items 1 and 2 of the diff", { items: [1, 2] });
  assert.match(same.task, /\[re-review items: 1\]/);
});
