// A plan review that fails again on a revised plan under the same checklist item does not set the [review_loop] stop
// (loopVerdictOf); the stop text names the parent in a session a parent opened (loopRefusalParented); the plan-review
// refusal texts say to revise until it passes; the plan gate itself is unchanged. Pure tables, plus one adapter scenario.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { PlanReviews, planReviewHash, planReviewRefusalText, type PlanVerdict } from "../planreview.ts";
import { failedItemsOf } from "../costguard.ts";
import { launchRefusalText } from "../checkpoint.ts";
import { loopRefusal, loopRefusalParented, loopVerdict, loopVerdictOf, sigOf, type LoopRound, type LoopStop } from "../reviewloop.ts";
import { tick, world } from "./_r46world.ts";

const fail = (state: string, sig: string[]): LoopRound => ({ verdict: "fail", state, sig });

test("loopVerdictOf: plan rounds", () => {
  assert.equal(loopVerdictOf("plan", fail("a", ["item:1"]), fail("b", ["item:1"])), null, "revised plan, same item only");
  assert.equal(loopVerdictOf("plan", fail("a", ["item:1", "item:3"]), fail("b", ["item:1", "item:3"])), null, "revised plan, same items");
  assert.equal(loopVerdictOf("plan", fail("a", ["item:1"]), fail("a", ["item:1"])), "repeat", "same version, same set");
  assert.equal(loopVerdictOf("plan", fail("a", ["item:1", "item:2"]), fail("a", ["item:1"])), "stalled", "same version, nothing new");
  assert.equal(loopVerdictOf("plan", fail("a", ["at:f:1:x", "item:1"]), fail("b", ["at:f:1:x", "item:1"])), "repeat", "revised plan, a located finding repeats");
  assert.equal(loopVerdictOf("plan", fail("a", ["item:1"]), fail("b", ["item:1", "item:2"])), null, "new finding");
  assert.equal(loopVerdictOf("plan", null, fail("a", ["item:1"])), null, "no round before");
  assert.equal(loopVerdictOf("plan", { verdict: "pass", state: "a", sig: [] }, fail("b", ["item:1"])), null, "a PASS before");
});

test("loopVerdictOf: code rounds are loopVerdict unchanged", () => {
  const rows: [LoopRound | null, LoopRound][] = [
    [fail("a", ["item:1"]), fail("b", ["item:1"])],
    [fail("a", ["item:1"]), fail("a", ["item:1"])],
    [fail("a", ["item:1", "item:2"]), fail("a", ["item:1"])],
    [fail("a", ["item:1"]), fail("b", ["item:2"])],
    [fail("", ["item:1"]), fail("", ["item:1", "item:2"])],
    [null, fail("a", ["item:1"])],
    [{ verdict: "pass", state: "a", sig: [] }, fail("a", ["item:1"])],
  ];
  for (const [p, c] of rows) assert.equal(loopVerdictOf("code", p, c), loopVerdict(p, c));
  assert.equal(loopVerdictOf("code", fail("a", ["item:1"]), fail("b", ["item:1"])), "repeat");
});

const STOP: LoopStop = { rule: "repeat", kind: "plan", sig: ["item:1"] };

test("the loop-stop text: byte-identical without a parent; the parented text names the parent and the owner decision", () => {
  assert.equal(
    loopRefusal(STOP),
    "pi-foreman: launch refused [review_loop]: the last two plan review rounds failed with the same findings (item:1). Stop and report the open findings, then ask the owner with ask_user_question (an answer lifts this stop) or wait for a new prompt. A parent ruling or brief, or a /ceremony tier change, also lifts this; a [second-opinion] review is still allowed.",
  );
  assert.equal(
    loopRefusal({ rule: "stalled", kind: "code", sig: ["item:2", "item:4"] }),
    "pi-foreman: launch refused [review_loop]: the last code review failed again with no new finding and no change to the work since the round before (item:2, item:4). Stop and report the open findings, then ask the owner with ask_user_question (an answer lifts this stop) or wait for a new prompt. A parent ruling or brief, or a /ceremony tier change, also lifts this; a [second-opinion] review is still allowed.",
  );
  const p = loopRefusalParented(STOP);
  assert.match(p, /^pi-foreman: launch refused \[review_loop\]: the last two plan review rounds failed with the same findings \(item:1\)\. /);
  assert.match(p, /report the open findings to the parent by file \(ask\.md in the handoff dir\) and wait for its ruling/);
  assert.match(p, /ask_user_question only when a finding needs the owner's decision/);
  assert.match(loopRefusalParented({ rule: "stalled", kind: "code", sig: ["item:2"] }), /no change to the work since the round before \(item:2\)/);
});

test("a DECISION: marker after the verdict word keeps the line a failed item", () => {
  const text = "3. FAIL: DECISION: scope of the guard\nOverall verdict: FAIL";
  assert.deepEqual(failedItemsOf(text), ["3"]);
  assert.deepEqual(sigOf(text, []), ["item:3"]);
});

const P = "/ws/.workflow/scratch/plan-x.md";
const A = planReviewHash(Buffer.from("# Plan A\n"));
const B = planReviewHash(Buffer.from("# Plan B\n"));
const v = (hash: string, verdict: "pass" | "fail"): PlanVerdict => ({ hash, verdict, model: "p/m", findings: Promise.resolve([]) });

test("PlanReviews.gate results are as before: PASS, FAIL below the cap, FAIL at the cap, a stale verdict", () => {
  const pass = new PlanReviews();
  pass.record(P, v(A, "pass"));
  const g = pass.gate(P, A);
  assert.ok("verdict" in g && g.verdict.verdict === "pass" && g.capped === undefined);
  const below = new PlanReviews();
  below.record(P, v(A, "fail"));
  assert.deepEqual(below.gate(P, A), { refusal: "plan_revision_required", stale: false });
  assert.deepEqual(below.gate(P, B), { refusal: "plan_review_required", stale: true }, "stale");
  below.record(P, v(B, "fail"));
  const capped = below.gate(P, B);
  assert.ok("verdict" in capped && capped.capped === true && capped.rounds === 2, "FAIL at the cap");
  assert.deepEqual(below.gate(P, A), { refusal: "plan_review_required", stale: true }, "an older version is stale");
  const three = new PlanReviews();
  three.record(P, v(A, "fail"));
  three.record(P, v(B, "fail"));
  assert.deepEqual(three.gate(P, B, 3), { refusal: "plan_revision_required", stale: false }, "a higher cap keeps asking for a revision");
  assert.deepEqual(new PlanReviews().gate(P, A), { refusal: "plan_review_required", stale: false }, "no review");
});

test("the plan-review refusal texts", () => {
  const t = planReviewRefusalText("plan_revision_required", "plan-x.md", "heavy", false);
  assert.match(t, /\[plan_revision_required\]: the plan review of plan-x\.md failed\. Revise the plan with the review's findings/);
  assert.match(t, /repeat until it passes/);
  assert.match(t, /checkpoint with a FAIL/);
  assert.doesNotMatch(t, /\bonce\b|whatever the verdict/);
  const phase = launchRefusalText("plan_phase", null, ".workflow/scratch");
  assert.match(phase, /ask only for real decisions until it is decision-complete/);
  assert.doesNotMatch(phase, /ask the owner with ask_user_question/);
});

const FAIL1 = "1. FAIL: the goal is vague\nOverall verdict: FAIL";
const FAIL2 = "1. FAIL: the scope is unclear\nOverall verdict: FAIL";
const isLoop = (s: string | null): boolean => /\[review_loop\]/.test(s ?? "");

test("a parented session: a revised plan failing under the same item goes on; the same version failing again stops with the parented text; a ruling lifts it", async (t) => {
  const w = world(t, { handoff: true, parent: true });
  const a = await w.adapter("startup");
  // polls the plan_review trace event of this round (emitted when the verdict is kept), 10 s deadline, every 25 ms
  let planRounds = 0;
  const until = async (what: string, cond: () => Promise<boolean>): Promise<void> => {
    const end = Date.now() + 10_000;
    while (!(await cond())) {
      assert.ok(Date.now() < end, `${what} within 10 s`);
      await tick(25);
    }
  };
  const review = async (report: string): Promise<string | null> => {
    const r = await a.reviewLaunch();
    if (r.blocked) return r.blocked;
    const want = ++planRounds;
    a.endRun(r.id, report);
    await until(`plan review ${want} was recorded`, async () => (await w.traceEvents()).filter((e) => e.event === "plan_review").length >= want);
    return null;
  };
  assert.equal(await review(FAIL1), null);
  fs.writeFileSync(w.planFile, fs.readFileSync(w.planFile, "utf8").replace("Ship it.", "Ship it twice."));
  assert.equal(await review(FAIL2), null, "a revised plan under the same item");
  assert.equal((await w.traceEvents()).filter((e) => e.event === "review_loop").length, 0, "no stop for a revised plan");
  assert.equal(await review(FAIL2), null, "the next review is launched");
  await until("the loop stop is set", async () => (await w.traceEvents()).some((e) => e.event === "review_loop"));
  const refused = await review(FAIL2);
  assert.ok(isLoop(refused), "the same version failing again with nothing new stops");
  assert.match(refused ?? "", /to the parent by file \(ask\.md in the handoff dir\)/);
  w.rule("ruling-1.md", "go on\n");
  const first = await review(FAIL1); // the first launch after a ruling is told about it, once
  assert.match(first ?? "", /a newer ruling arrived/);
  assert.ok(!isLoop(first));
  assert.equal(await review(FAIL1), null, "the ruling lifts the stop");
});
