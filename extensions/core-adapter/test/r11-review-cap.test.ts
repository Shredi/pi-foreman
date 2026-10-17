// R11 item 4 (P2): plan reviews and fix-round reviews are capped apart by ceremony.reviewRuns; a parent ruling line
// `review-cap: +N` (newest ruling*.md of a dir where this session is the child, not self- or child-written) lifts the
// cap once; the review_cap refusal names its reset paths; a capped plan-review FAIL without located findings says the
// owner may override it at the checkpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reviewCapCheck } from "../costguard.ts";
import { planReviewSection, type PlanVerdict } from "../planreview.ts";
import { parentRulingLift, SelfRulings } from "../ruling.ts";
import { r11Rig, writeAt } from "./_r11rig.ts";
import { rmTestTmp } from "./_tmpbase.ts";

const review = (n: number) => ({ agent: "reviewer", task: `review items ${n}` });
const planReview = (n: number) => ({ agent: "reviewer", task: `[plan-review] review plan-x.md version ${n}` });
const capRefused = (r: { block?: boolean; reason?: string } | undefined): boolean => r?.block === true && /\[review_cap\]/.test(r.reason ?? "");

test("review_cap_fix_round_counted_separately", async (t) => {
  const a = await r11Rig(t, { reviewRuns: 2 });
  // two plan reviews fill the plan counter only
  for (const n of [1, 2]) assert.equal((await a.launch(planReview(n))).res, undefined, `plan review ${n}`);
  assert.ok(capRefused((await a.launch(planReview(3))).res), "a third plan review is capped");
  // the fix-round counter is untouched by the plan reviews
  for (const n of [1, 2]) assert.equal((await a.launch(review(n))).res, undefined, `fix-round review ${n}`);
  const third = (await a.launch(review(3))).res;
  assert.ok(capRefused(third));
  assert.match(third!.reason!, /2 review run\(s\) already ran/);
  const refusals = a.events("launch_refused").filter((r) => r.reason === "review_cap");
  assert.deepEqual(refusals.map((r) => [r.kind, r.count, r.limit]), [["plan", 2, 2], ["review", 2, 2]]);
  // a new owner prompt resets both counters
  await a.ownerPrompt();
  assert.equal((await a.launch(review(4))).res, undefined);
  assert.equal((await a.launch(planReview(4))).res, undefined);
});

test("review_cap_parent_ruling_lifts", async (t) => {
  const a = await r11Rig(t, { reviewRuns: 1 });
  const dir = a.handoff("round", "child");
  const now = Date.now();
  writeAt(path.join(dir, "ask.md"), "ask: one more review round?\n", now - 60_000);
  assert.equal((await a.launch(review(1))).res, undefined);
  assert.ok(capRefused((await a.launch(review(2))).res), "capped before the ruling");
  writeAt(path.join(dir, "ruling.md"), "APPROVED\nreview-cap: +2\n", now - 1000);
  assert.equal((await a.launch(review(2))).res, undefined, "the parent ruling lifts the cap");
  assert.equal((await a.launch(review(3))).res, undefined, "+2 reviews");
  assert.ok(capRefused((await a.launch(review(4))).res), "the same ruling file lifts only once");
  assert.deepEqual(a.events("review_cap_lift").map((r) => [r.by, r.count, r.limit]), [["ruling", 2, 3]]);
  // a newer ruling file lifts again
  writeAt(path.join(dir, "ruling-2.md"), "review-cap: +1\n", now);
  assert.equal((await a.launch(review(4))).res, undefined);
});

test("review_cap_self_or_child_written_ruling_ignored", async (t) => {
  const a = await r11Rig(t, { reviewRuns: 1 });
  const now = Date.now();
  // a dir where this session is the PARENT: its own child session wrote the ruling there
  const own = a.handoff("opened", "parent");
  writeAt(path.join(own, "ask.md"), "ask\n", now - 60_000);
  writeAt(path.join(own, "ruling.md"), "review-cap: +5\n", now - 1000);
  assert.equal((await a.launch(review(1))).res, undefined);
  assert.ok(capRefused((await a.launch(review(2))).res), "a child-written ruling never lifts");
  // a dir where this session is the child, but the ruling is one this session wrote itself
  const mine = a.handoff("round", "child");
  writeAt(path.join(mine, "ask.md"), "ask\n", now - 60_000);
  writeAt(path.join(mine, "ruling.md"), "review-cap: +5\n", now - 500);
  await a.wrote(path.join(mine, "ruling.md"));
  assert.ok(capRefused((await a.launch(review(2))).res), "a self-written ruling never lifts");
  // a ruling older than the session's ask is stale
  writeAt(path.join(mine, "ruling.md"), "review-cap: +5\n", now + 1000);
  writeAt(path.join(mine, "ask.md"), "a newer ask\n", now + 2000);
  assert.ok(capRefused((await a.launch(review(2))).res), "a ruling older than the ask never lifts");
  assert.deepEqual(a.events("review_cap_lift"), []);
});

test("review_cap_self_or_child_written_ruling_ignored: parentRulingLift unit cases", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r11-lift-")));
  t.after(() => rmTestTmp(root));
  const now = Date.now();
  const dir = path.join(root, "d");
  fs.mkdirSync(dir);
  const used = new Set<string>();
  writeAt(path.join(dir, "ruling.md"), "review-cap: +2\n", now);
  assert.equal(parentRulingLift([dir], "review-cap", undefined, used), null, "no ask.md or plan.md: not attributable");
  writeAt(path.join(dir, "plan.md"), "plan\n", now - 5000);
  const self = new SelfRulings();
  self.mark(path.join(dir, "ruling.md"));
  assert.equal(parentRulingLift([dir], "review-cap", self, used), null, "self-written");
  assert.deepEqual(parentRulingLift([dir], "review-cap", new SelfRulings(), used), { file: path.join(dir, "ruling.md"), n: 2 });
  assert.equal(parentRulingLift([dir], "review-cap", undefined, used), null, "once per file");
  // the newest ruling decides: an older one with the line is not read
  writeAt(path.join(dir, "ruling-2.md"), "APPROVED\n", now + 1000);
  writeAt(path.join(dir, "ruling-1.md"), "review-cap: +3\n", now - 1000);
  assert.equal(parentRulingLift([dir], "review-cap", undefined, new Set()), null);
  assert.equal(parentRulingLift([dir], "read-budget", undefined, new Set()), null, "another key");
});

test("review_cap_refusal_names_reset_path", () => {
  for (const r of [reviewCapCheck(3, 1, 3), reviewCapCheck(3, 1, 3, "plan")]) {
    assert.equal(r?.reason, "review_cap");
    assert.match(r!.text, /`review-cap: \+N`/);
    assert.match(r!.text, /ruling\*\.md/);
    assert.match(r!.text, /new prompt/);
  }
  assert.match(reviewCapCheck(3, 1, 3, "plan")!.text, /3 plan review run\(s\)/);
});

test("plan_review_no_located_findings_owner_overridable", () => {
  const v: PlanVerdict = { hash: "h", verdict: "fail", model: "p/m", findings: Promise.resolve([]) };
  const capped = planReviewSection(v, [], { rounds: 2, cap: 2 }).split("\n");
  assert.equal(capped[0], "Plan review: FAIL after 2 of 2 rounds; open findings:");
  assert.ok(capped[1].startsWith("  (no located findings)"));
  assert.match(capped[1], /owner may override this FAIL at the checkpoint/);
  // below the cap (or a PASS) the line stays as it was
  assert.equal(planReviewSection(v, []).split("\n")[1], "  (no located findings)");
});
