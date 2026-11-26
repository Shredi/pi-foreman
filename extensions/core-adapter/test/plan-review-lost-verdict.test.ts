// A plan review that ends and leaves no plan with a verdict (no review_verdict record, an `incomplete` record, or a verdict for which no plan file is found)
// sends the foreman one notice naming the cause (item 6a); a recorded verdict on a found plan sends none.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tick, world } from "./_r46world.ts";

const CUSTOM = "pi-foreman-plan-review-lost";
type Sent = { message: { customType: string; content: string }; options: unknown }[];
const notices = (sent: Sent) => sent.filter((s) => s.message.customType === CUSTOM);
const planReviews = async (w: ReturnType<typeof world>) => (await w.traceEvents()).filter((e) => e.event === "plan_review");
async function fixture(t: Parameters<typeof world>[0]) {
  const sent: Sent = [];
  const w = world(t, { sent, ceremony: { default: "standard" } });
  const a = await w.adapter("startup");
  fs.appendFileSync(w.planFile, "\n## Decisions and assumptions\nNone.\n\n## Open questions\nNone.\n");
  await a.writeLedger("# Ledger: x\n\n- [ ] 1. item\n");
  return { w, a, sent };
}

test("no review_verdict record: one notice says no verdict was recorded and to relaunch", async (t) => {
  const { w, a, sent } = await fixture(t);
  const r = await a.reviewLaunch();
  assert.equal(r.blocked, null);
  a.endRun(r.id, "The plan looks fine, no verdict word."); // no record is written
  await tick();
  assert.equal((await planReviews(w)).length, 0);
  const n = notices(sent);
  assert.equal(n.length, 1, JSON.stringify(sent));
  assert.match(n[0].message.content, /plan review ended and no plan got a verdict: no review_verdict record was left/);
  assert.match(n[0].message.content, /Relaunch the plan review/);
  assert.deepEqual(n[0].options, { triggerTurn: false });
});

test("an incomplete record: the notice names it and its reason", async (t) => {
  const { a, sent } = await fixture(t);
  const r = await a.reviewLaunch();
  a.endRunRecord(r.id, { verdict: "incomplete", reason: "tests would not start" });
  await tick();
  const n = notices(sent);
  assert.equal(n.length, 1, JSON.stringify(sent));
  assert.match(n[0].message.content, /the reviewer recorded `incomplete` \(tests would not start\)/);
});

test("a recorded verdict for which no plan file is found: the notice names the paths tried", async (t) => {
  const { w, a, sent } = await fixture(t);
  const r = await a.reviewLaunch();
  fs.rmSync(w.planFile);
  a.endRunRecord(r.id, { verdict: "pass" });
  await tick();
  assert.equal((await planReviews(w)).length, 1, "the verdict itself is traced");
  const n = notices(sent);
  assert.equal(n.length, 1, JSON.stringify(sent));
  assert.match(n[0].message.content, /a verdict was recorded, but no plan file was found for it \(tried: .*plan-widget\.md\)/);
});

test("a recorded verdict on a found plan sends no notice, whichever way the task names the .md plan", async (t) => {
  for (const named of [".workflow/scratch/plan-widget.md", "plan-widget.md", "./.workflow/scratch/plan-widget.md"]) {
    const { w, a, sent } = await fixture(t);
    const absolute = path.join(path.dirname(w.planFile), "plan-widget.md");
    const task = `[plan-review] review ${named === "plan-widget.md" ? named : named.startsWith(".") ? named : absolute}`;
    const r = await a.reviewLaunch(task);
    assert.equal(r.blocked, null, named);
    a.endRunRecord(r.id, { verdict: "pass" });
    await tick();
    assert.equal(notices(sent).length, 0, `${named}: ${JSON.stringify(sent)}`);
    assert.equal((await planReviews(w)).length, 1, `${named}: the verdict is recorded for the plan`);
  }
});
