// R11 item 4 (P2): plan reviews and fix-round reviews are capped apart by ceremony.reviewRuns; the review_cap refusal
// names its one reset path (a new owner prompt); a ruling line never changes the cap, but a parent-written ruling-<n>.md
// or brief-<x>.md resets it (R18 item 1, r18-caps-reset.test.ts); a capped plan-review FAIL without located findings says
// the owner may override it at the checkpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { reviewCapCheck } from "../costguard.ts";
import { planReviewSection, type PlanVerdict } from "../planreview.ts";
import { r11Rig, reviewAllowOpts, writeAt } from "./_r11rig.ts";

const review = (n: number) => ({ agent: "reviewer", task: `review items ${n}` });
const planReview = (n: number) => ({ agent: "reviewer", task: `[plan-review] review plan-x.md version ${n}` });
const capRefused = (r: { block?: boolean; reason?: string } | undefined): boolean => r?.block === true && /\[review_cap\]/.test(r.reason ?? "");

test("review_cap_fix_round_counted_separately", async (t) => {
  const a = await r11Rig(t, { reviewRuns: 2 }, reviewAllowOpts());
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

test("ruling_review_cap_line_has_no_effect_but_ruling_file_lifts", async (t) => {
  const a = await r11Rig(t, { reviewRuns: 1 }, reviewAllowOpts());
  const dir = a.handoff("round", "child");
  const now = Date.now();
  writeAt(path.join(dir, "ask.md"), "ask: one more review round?\n", now - 60_000);
  assert.equal((await a.launch(review(1))).res, undefined);
  assert.ok(capRefused((await a.launch(review(2))).res), "capped before the ruling");
  // a parent-written ruling.md with the line, newer than the ask: nothing changes (no text parser, ruling.md is no reset file)
  writeAt(path.join(dir, "ruling.md"), "APPROVED\nreview-cap: +2\n", now - 1000);
  assert.ok(capRefused((await a.launch(review(2))).res), "the ruling line does not lift the cap");
  assert.deepEqual(a.events("review_cap_lift"), []);
  // a parent-written ruling-2.md resets the cap, whatever it says
  writeAt(path.join(dir, "ruling-2.md"), "go on\n", Date.now());
  assert.equal((await a.launch(review(2))).res, undefined, "a parent ruling-<n>.md lifts the cap");
  assert.equal(a.events("cap_reset").length, 1);
});

test("review_cap_refusal_names_reset_path", () => {
  for (const r of [reviewCapCheck(3, 1, 3), reviewCapCheck(3, 1, 3, "plan")]) {
    assert.equal(r?.reason, "review_cap");
    assert.match(r!.text, /new prompt/);
    assert.doesNotMatch(r!.text, /ruling|review-cap:/);
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
