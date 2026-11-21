// High-stakes state per checkout (items 2 and 4 of the review-routing round): the findings of a high-stakes FAIL go to a review of the checkout they were raised on (or one
// that builds on the FAIL commit, or any once that checkout is gone), the passes are counted per checkout, and a finish reminder names the checkouts that are due. Two real
// worktrees of one session (_hsrig.ts); the pure parts of highstakes.ts first.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { emptyState, finishNeeds, HighStakes, launchRefusal, openFails, prRefusal, routeFail, used } from "../highstakes.ts";
import { type Rig, build, commitIn, end, hsPass, launch, pr, setup, settle, tick, worktree } from "./_hsrig.ts";

const X = "a".repeat(40);
const Y = "b".repeat(40);
const FINDINGS = "[pi-foreman high-stakes findings]";
const FAILED = /\[pr_refused:high_stakes_failed\]/;
const sized = (risk: string[]) => ({ size: { files: ["src/a/x.ts"] }, risk });
const at = { repoKey: "/r/.git", gateKey: null, failAt: 7 };

/** A high-stakes FAIL run in `cwd` whose findings say `text`. */
async function hsFail(a: Rig, cwd: string | undefined, text: string) {
  const s = await launch(a, "reviewer", "[high-stakes] review the whole change", cwd ? { cwd } : {});
  assert.equal(s.blocked, null, String(s.blocked));
  await end(a, s, "reviewer", `1. FAIL src/x.ts:1 ${text}\nOverall verdict: FAIL`, cwd);
  return s;
}
/** A fresh normal review in `cwd`; its launch input shows which findings it got. */
const normal = async (a: Rig, cwd: string, task = "review the change") => {
  const r = await launch(a, "reviewer", task, { cwd });
  assert.equal(r.blocked, null, String(r.blocked));
  return r;
};

/** Two worktrees A and B with a tagged builder run and a normal PASS each (the tag makes a high-stakes review due). */
async function two(t: Parameters<typeof setup>[0]) {
  const s = await setup(t);
  s.w.state.answer = "allow once";
  const A = worktree(s.w, "wta");
  const B = worktree(s.w, "wtb");
  commitIn(A, "src/a/x.ts");
  commitIn(B, "src/b/y.ts");
  await build(s.a, sized(["design"]), A);
  await build(s.a, {}, B);
  return { ...s, A, B };
}

// ------------------------------------------------------------------ pure parts

const state = () => {
  const hs = new HighStakes();
  hs.fire(["design"]);
  return hs;
};

test("state per checkout: two runs each, a FAIL of one checkout is not the last run of another; used, uncleared and the launch refusal read the checkout", () => {
  const hs = state();
  assert.equal(hs.recordFail("/w/a", X, "fa", at), 1);
  assert.equal(hs.record("/w/b", "pass", Y, ""), 1);
  assert.equal(openFails(hs.state()).length, 1, "B's PASS does not hide A's FAIL");
  assert.equal(hs.openFailOf("/w/a")?.findings, "fa");
  assert.equal(hs.openFailOf("/w/b"), undefined);
  assert.equal(used(hs.state()), true, "no checkout: the session as before (a PASS is last)");
  assert.equal(used(hs.state(), "/w/a"), false);
  assert.equal(used(hs.state(), "/w/b"), true);
  const gate = { last: "pass" as const, revised: false };
  const refusal = (root?: string) => launchRefusal({ model: "m", single: true, resume: false, state: hs.state(), running: false, gate, ...(root ? { root } : {}) });
  assert.match(refusal("/w/a")?.text ?? "", /\[high_stakes_early\]/);
  assert.match(refusal("/w/b")?.text ?? "", /\[high_stakes_done\].*of this checkout/);
  assert.equal(refusal("/w/c"), null, "a checkout with no run is free");
  assert.equal(hs.record("/w/a", "pass", X, ""), 2, "the second run of A");
  assert.equal(hs.record("/w/a", "pass", X, ""), 0, "a third in A is not recorded");
});

test("state per checkout: the run caps are two per checkout and sixteen in all; the running mark is per checkout", () => {
  const hs = state();
  for (let i = 0; i < 20; i++) hs.record(`/w/${i}`, "pass", X, "");
  assert.equal(hs.state().runs.length, 16);
  assert.equal(hs.state().runs[0].cwd, "/w/4", "the oldest go first");
  hs.beginKeyed("c1", "/w/a", "/w/a");
  assert.equal(hs.isRunning("/w/a"), true);
  assert.equal(hs.isRunning("/w/b"), false);
  assert.equal(hs.isRunning(), true);
  assert.equal(emptyState().runs.length, 0);
});

test("T3d unit: a launch that got two FAILs' findings clears each only by its own head and checkout", () => {
  const hs = state();
  hs.recordFail("/w/a", X, "fa", at);
  hs.recordFail("/w/b", Y, "fb", at);
  const [fa, fb] = openFails(hs.state());
  hs.markHanded("c1", fa);
  hs.markHanded("c1", fb);
  hs.settleHanded("c1", "r1", false);
  assert.deepEqual(hs.handedFailsOf("r1"), [fa, fb]);
  assert.equal(hs.clearBy("/w/b", { runId: "r1", head: Y, descends: false, fail: fa }), false, "a PASS in B that does not build on A's head leaves A's FAIL");
  assert.equal(hs.clearBy("/w/b", { runId: "r1", head: Y, descends: false, fail: fb }), true, "B's own FAIL clears in B");
  assert.equal(hs.openFailOf("/w/a"), fa);
  assert.equal(hs.openFailOf("/w/b"), undefined);
  assert.equal(hs.clearBy("/w/b", { runId: "r1", head: Y, descends: true, fail: fb }), false, "already cleared");
  assert.equal(hs.clearBy("/w/b", { runId: "r1", head: Y, descends: true, fail: fa }), true, "a descendant clears A's");
});

test("T3c unit: a PASS of another checkout does not drop A's hand-over; a newer FAIL in A drops it", () => {
  const hs = state();
  hs.recordFail("/w/a", X, "fa", at);
  const fa = hs.openFailOf("/w/a")!;
  hs.markHanded("c1", fa);
  hs.settleHanded("c1", "r1", false);
  hs.record("/w/b", "pass", Y, "");
  assert.deepEqual(hs.handedFailsOf("r1"), [fa]);
  assert.equal(hs.clearBy("/w/a", { runId: "r1", head: X, descends: false, fail: fa }), true);
  const again = state();
  again.recordFail("/w/a", X, "fa", at);
  const old = again.openFailOf("/w/a")!;
  again.markHanded("c2", old);
  again.settleHanded("c2", "r2", false);
  again.state().runs[0].cleared = false;
  again.recordFail("/w/a", Y, "fb", at);
  assert.deepEqual(again.handedFailsOf("r2"), [], "the replaced FAIL's hand-over is void");
});

test("PR and finish read the uncleared FAIL of the PR's checkouts, not the session's last run", () => {
  const hs = state();
  hs.recordFail("/w/a", X, "fa", at);
  hs.record("/w/b", "pass", Y, "");
  assert.match(prRefusal(hs.state(), [], [], "/w/a", ["/w/a"])?.message ?? "", FAILED);
  assert.equal(prRefusal(hs.state(), [], [], "/w/b", ["/w/b"]), null);
  assert.equal(prRefusal(hs.state(), [], [], "/w/b"), null, "no scope: the session's last run, a PASS");
  assert.deepEqual(finishNeeds(hs.state(), { due: ["design"], ledgerDone: true, own: "/w/b" }).missing.length, 1);
});

test("T3e: route of the findings: own checkout, else the newest FAIL the review's head builds on (a FAIL without a head is never routed so), else the newest FAIL of a gone checkout", async () => {
  const hs = state();
  hs.recordFail("/w/a", X, "fa", at);
  hs.recordFail("/w/b", null, "fb", at); // no recorded head
  hs.recordFail("/w/c", Y, "fc", at);
  const fails = openFails(hs.state());
  const [fa, fb, fc] = fails;
  const yes = async () => true;
  const no = async () => false;
  assert.equal(await routeFail(fails, "/w/a", no, () => false), fa, "own checkout first");
  assert.equal(await routeFail(fails, "/w/b", no, () => false), fb);
  assert.equal(await routeFail(fails, "/w/d", no, () => false), undefined, "a sibling that builds on nothing gets nothing");
  assert.equal(await routeFail(fails, "/w/d", yes, () => false), fc, "descent: the newest FAIL with a head; the headless FAIL is skipped");
  assert.equal(await routeFail([fb], "/w/d", yes, () => false), undefined, "the headless FAIL never reaches a sibling by descent");
  assert.equal(await routeFail(fails, "/w/d", no, (r) => r === fa || r === fb), fb, "a gone checkout: the newest one gone");
  assert.equal(await routeFail([fb], "/w/d", no, () => true), fb, "gone: even without a head");
});

// ------------------------------------------------------------------ wiring

test("T3: a high-stakes FAIL in A: a [pre-pr] in B gets no findings; a normal review in A gets them; a PASS in B does not clear A's FAIL", async (t) => {
  const { a, A, B } = await two(t);
  await hsFail(a, A, "alpha defect");
  const inB = await launch(a, "reviewer", "[pre-pr] review the branch", { cwd: B });
  assert.equal(inB.blocked, null, String(inB.blocked));
  assert.doesNotMatch(String(inB.input.task), /high-stakes findings|alpha defect/, "B gets none");
  await end(a, inB, "reviewer", "Overall verdict: PASS", B);
  assert.match(await pr(a, { head: "wta" }), FAILED, "a PASS in B does not clear A's FAIL");
  assert.equal(await pr(a, { head: "wtb" }), "", "B's PR is not held by A's FAIL");
  const inA = await normal(a, A);
  assert.ok(String(inA.input.task).startsWith(FINDINGS) && String(inA.input.task).includes("alpha defect"), "A gets them");
});

test("T3b: FAIL in A then FAIL in B: a normal PASS in A that got A's findings clears A's FAIL only", async (t) => {
  const { a, A, B } = await two(t);
  await hsFail(a, A, "alpha defect");
  await hsFail(a, B, "beta defect");
  const inA = await normal(a, A);
  const task = String(inA.input.task);
  assert.ok(task.includes("alpha defect") && !task.includes("beta defect"), task);
  await end(a, inA, "reviewer", "Overall verdict: PASS", A);
  assert.doesNotMatch(await pr(a, { head: "wta" }), /high_stakes_failed/, "A's PR is no longer held");
  assert.match(await pr(a, { head: "wtb" }), FAILED, "B's FAIL stands");
  const inB = String((await normal(a, B)).input.task);
  assert.ok(inB.includes("beta defect") && !inB.includes("alpha defect"), inB);
});

test("T3b: the finish reminder names the checkouts a high-stakes review is due in; a third checkout becoming due reminds again", async (t) => {
  const { w, a, A } = await two(t);
  await hsPass(a, A);
  const first = await settle(a);
  assert.match(first, /a \[high-stakes\] review is due \(risk tag design/);
  assert.ok(first.includes("wtb") && !first.includes("wta"), first);
  assert.equal(await settle(a), "", "held once per set");
  w.state.answer = "allow once";
  const C = worktree(w, "wtc");
  commitIn(C, "src/c/z.ts");
  await build(a, {}, C);
  const again = await settle(a);
  assert.match(again, /a \[high-stakes\] review is due/);
  assert.ok(again.includes("wtc"), again);
});

test("T3c: FAIL in A, high-stakes PASS in B: a normal review in A still gets A's findings and its PASS clears A's FAIL; B's gate entry stays", async (t) => {
  const { a, A, B } = await two(t);
  await hsFail(a, A, "alpha defect");
  await hsPass(a, B);
  assert.match(await pr(a, { head: "wta" }), FAILED, "B's PASS does not hide A's FAIL");
  const inA = await normal(a, A);
  assert.ok(String(inA.input.task).includes("alpha defect"), String(inA.input.task));
  await end(a, inA, "reviewer", "Overall verdict: PASS", A);
  assert.doesNotMatch(await pr(a, { head: "wta" }), /high_stakes_failed|pr_refused/);
  assert.equal(await pr(a, { head: "wtb" }), "");
});

test("T3d: a review of A and a review of B each get their own FAIL; a PASS in B clears B's FAIL only", async (t) => {
  const { a, A, B } = await two(t);
  await hsFail(a, A, "alpha defect");
  await hsFail(a, B, "beta defect");
  const inA = await normal(a, A);
  const inB = await normal(a, B);
  const ta = String(inA.input.task);
  const tb = String(inB.input.task);
  assert.ok(ta.includes("alpha defect") && !ta.includes("beta defect"), ta);
  assert.ok(tb.includes("beta defect") && !tb.includes("alpha defect"), tb);
  await end(a, inB, "reviewer", "Overall verdict: PASS", B);
  assert.match(await pr(a, { head: "wta" }), FAILED, "A's FAIL stands");
  assert.doesNotMatch(await pr(a, { head: "wtb" }), /high_stakes_failed/, "B's FAIL is cleared");
});

test("T3: a FAIL whose checkout is gone routes its findings to a review elsewhere, and a PASS there does not clear it", async (t) => {
  const { a, A, B } = await two(t);
  await hsFail(a, A, "alpha defect");
  const inB = await normal(a, B, "[pre-pr] review the branch");
  assert.doesNotMatch(String(inB.input.task), /alpha defect/, "B does not build on A's commit");
  fs.rmSync(A, { recursive: true, force: true });
  const gone = await normal(a, B, "[pre-pr] review the branch");
  assert.ok(String(gone.input.task).includes("alpha defect"), "A is gone: any checkout gets the findings");
  await end(a, gone, "reviewer", "Overall verdict: PASS", B);
  assert.match(await pr(a, { head: "wta" }), FAILED, "a gone checkout is a route, not a clearing reason");
});

test("T6: two high-stakes runs in A: a launch in B is not refused high_stakes_done; a third in A is, naming the checkout", async (t) => {
  const { a, A, B } = await two(t);
  await hsFail(a, A, "alpha defect");
  const inA = await normal(a, A);
  await end(a, inA, "reviewer", "Overall verdict: PASS", A);
  await tick(50);
  await hsFail(a, A, "alpha again");
  const third = await launch(a, "reviewer", "[high-stakes] review the whole change", { cwd: A });
  assert.match(third.blocked ?? "", /\[high_stakes_done\].*of this checkout/);
  const inB = await launch(a, "reviewer", "[high-stakes] review the whole change", { cwd: B });
  assert.equal(inB.blocked, null, String(inB.blocked));
});

test("T7: a high-stakes FAIL in B does not refuse a high-stakes launch in A, also from a subdirectory of A", async (t) => {
  const { a, A, B } = await two(t);
  await hsFail(a, B, "beta defect");
  const sub = `${A}/src/a`;
  const viaSub = await launch(a, "reviewer", "[high-stakes] review the whole change", { cwd: sub });
  assert.equal(viaSub.blocked, null, String(viaSub.blocked));
  await end(a, viaSub, "reviewer", "Overall verdict: PASS", sub);
  const plain = await launch(a, "reviewer", "[high-stakes] review the whole change", { cwd: A });
  assert.match(plain.blocked ?? "", /\[high_stakes_done\]/, "A's own pass is used");
  assert.match(await pr(a, { head: "wtb" }), FAILED);
});

test("T7: the report's order: B builder, PASS, high-stakes FAIL; then A builder, PASS, high-stakes launch (cwd the checkout, then a subdirectory)", async (t) => {
  const s = await setup(t);
  s.w.state.answer = "allow once";
  const A = worktree(s.w, "wta");
  const B = worktree(s.w, "wtb");
  commitIn(B, "src/b/y.ts");
  await build(s.a, sized(["design"]), B);
  await hsFail(s.a, B, "beta defect");
  commitIn(A, "src/a/x.ts");
  await build(s.a, {}, A);
  const sub = `${A}/src/a`;
  const viaSub = await launch(s.a, "reviewer", "[high-stakes] review the whole change", { cwd: sub });
  assert.equal(viaSub.blocked, null, String(viaSub.blocked));
  await end(s.a, viaSub, "reviewer", "1. FAIL src/x.ts:1 alpha\nOverall verdict: FAIL", sub);
  const again = await launch(s.a, "reviewer", "[high-stakes] review the whole change", { cwd: A });
  assert.match(again.blocked ?? "", /\[high_stakes_early\]|\[high_stakes_done\]/, "A's own FAIL holds A");
  assert.match(await pr(s.a, { head: "wtb" }), FAILED, "B's FAIL holds B");
});
