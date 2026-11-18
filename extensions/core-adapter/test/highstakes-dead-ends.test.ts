// The high-stakes dead ends (D30, D39, D32, D23): every uncleared FAIL has a real exit, with no fake edit and no owner tier change.
// Pure parts first (clearBy, the findings hand-over, the gate clear), then the wiring over real worktrees.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { initialReviewGate, onReviewVerdicts } from "../bound.ts";
import { emptyState, HighStakes, prRefusal, readyOverride } from "../highstakes.ts";
import { gatesClearFail, gatesVerdict } from "../reviewgates.ts";
import { entryOccasions, namesBothTags } from "../occasion.ts";
import { build, commitIn, end, git, hsRun, launch, pr, settle, setup, traces, worktree } from "./_hsrig.ts";
import { rmTestTmp } from "./_tmpbase.ts";

const X = "a".repeat(40);
const Y = "b".repeat(40);
const FINDINGS = "[pi-foreman high-stakes findings]";
const sized = (risk: string[]) => ({ size: { files: ["src/a/x.ts"] }, risk });
const FAILED = /\[pr_refused:high_stakes_failed\]/;

/** A state with a FAIL at X in `/w/a` (gate entry "/w/a", failed at 7). */
function failed(): HighStakes {
  const hs = new HighStakes();
  hs.fire(["design"]);
  assert.equal(hs.recordFail("/w/a", X, "1. FAIL x", { repoKey: "/r/.git", gateKey: "/w/a", failAt: 7 }), 1);
  return hs;
}
const handed = (hs: HighStakes, call: string, run: string) => {
  assert.equal(hs.findingsFor(), "1. FAIL x");
  hs.markHanded(call);
  hs.settleHanded(call, run, false);
};

test("clearBy: only a run that got the findings clears; in the FAIL's checkout at any head, elsewhere only when it descends; clearedAt keeps the FAIL head blocked", () => {
  const hs = failed();
  assert.equal(hs.clearBy("/w/a", { runId: "r0", head: Y, descends: true }), false, "a run that got no findings clears nothing");
  handed(hs, "c1", "r1");
  assert.equal(hs.clearBy("/w/b", { runId: "r1", head: Y, descends: false }), false, "elsewhere without descent");
  assert.equal(hs.openFail()?.cleared, false);
  assert.equal(hs.clearBy("/w/a", { runId: "r1", head: Y, descends: false }), true, "the FAIL's checkout: any head");
  assert.equal(hs.findingsFor(), null);
  const s = hs.state();
  assert.match(prRefusal(s, [], [X], "/w/a")?.message ?? "", FAILED, "a PR from the FAIL head stays blocked");
  assert.equal(prRefusal(s, [], [Y], "/w/a"), null);
  assert.equal(readyOverride(s, [], X), "wip");
  assert.equal(readyOverride(s, [], Y), null);
});

test("clearBy: a PASS on the FAIL head itself clears and opens that head; another checkout that descends clears; a failed launch and a later FAIL drop the hand-over", () => {
  const hs = failed();
  handed(hs, "c1", "r1");
  assert.equal(hs.clearBy("/w/b", { runId: "r1", head: X, descends: true }), true);
  assert.equal(prRefusal(hs.state(), [], [X], "/w/b"), null, "cleared at its own head");
  const gone = failed();
  gone.markHanded("c2");
  gone.settleHanded("c2", "r2", true);
  assert.equal(gone.clearBy("/w/a", { runId: "r2", head: Y, descends: true }), false, "a failed launch got no run id");
  handed(gone, "c3", "r3");
  assert.equal(gone.recordFail("/w/a", Y, "1. FAIL y", { repoKey: null, gateKey: null, failAt: 9 }), 2);
  assert.equal(gone.clearBy("/w/a", { runId: "r3", head: Y, descends: true }), false, "a run handed the earlier FAIL's findings does not clear the new one");
  assert.equal(emptyState().runs.length, 0);
});

test("gatesClearFail: the FAIL's entry passes when nothing happened there since; a revised entry stays open; null keys pass every entry that still carries it; no failAt: an old run", () => {
  const fail = { ...onReviewVerdicts(initialReviewGate(), ["fail"], 7, "r0"), stoodAtFail: true }; // a PASS stood there before the FAIL
  const g = { "/w/a": fail, "/w/b": onReviewVerdicts(initialReviewGate(), ["pass"], 3, "r1"), "": fail };
  const one = gatesClearFail(g, "/w/a", 7, 10, "r2");
  assert.equal(one["/w/a"]!.last, "pass");
  assert.equal(one[""]!.last, "fail");
  const all = gatesClearFail(g, null, 7, 10, "r2");
  assert.equal(all["/w/a"]!.last, "pass");
  assert.equal(all[""]!.last, "pass");
  const later = gatesClearFail({ "/w/a": gatesVerdict({ "/w/a": fail }, ["/w/a"], ["fail"], 9, "r3")["/w/a"]! }, "/w/a", 7, 10, "r2");
  assert.equal(later["/w/a"]!.last, "fail", "a FAIL of another time is not the cleared one");
  assert.equal(gatesClearFail({ "": fail }, "", undefined, 10, "r2")[""]!.last, "pass");
});

test("D30: after a high-stakes FAIL a fresh untagged reviewer is accepted, gets the findings, and its PASS at the same head clears it; the PR gate and the finish open", async (t) => {
  const { w, a } = await setup(t);
  commitIn(w.project, "src/a/x.ts");
  await build(a, sized(["design"]));
  await hsRun(a, "FAIL");
  assert.match(await pr(a), FAILED);
  assert.match(await settle(a), /revise or answer the high-stakes findings/);
  const r = await launch(a, "reviewer", "review the change");
  assert.equal(r.blocked, null, String(r.blocked));
  assert.ok(String(r.input.task).startsWith(FINDINGS), "it gets the findings");
  await end(a, r, "reviewer", "Overall verdict: PASS");
  assert.doesNotMatch(await pr(a), /high_stakes_failed/);
  assert.doesNotMatch(await settle(a), /FAILED|revise or answer/);
});

test("D39: a FAIL at X in A is cleared by a findings run that passes the fix Y in B (Y builds on X); A's entry stands and a reviewer in A at Y is accepted", async (t) => {
  const { w, a } = await setup(t);
  w.state.answer = "allow once";
  commitIn(w.project, "src/a/x.ts");
  await build(a, sized(["design"]));
  await hsRun(a, "FAIL");
  const b = worktree(w, "wtb");
  commitIn(b, "src/b/y.ts");
  await build(a, {}, b);
  assert.doesNotMatch(await pr(a, { head: "wtb" }), /high_stakes_failed/);
  const fin = await settle(a);
  assert.doesNotMatch(fin, /FAILED|revise or answer|re-review needed/, fin);
  git(w.project, "merge", "-q", "--ff-only", "wtb");
  const again = await launch(a, "reviewer", "review the change");
  assert.equal(again.blocked, null, String(again.blocked));
});

test("D39: a pass in B on a commit that does not build on the FAIL commit leaves the FAIL standing", async (t) => {
  const { w, a } = await setup(t);
  w.state.answer = "allow once";
  const b = worktree(w, "sib");
  commitIn(w.project, "src/a/x.ts");
  await build(a, sized(["design"]));
  await hsRun(a, "FAIL");
  commitIn(b, "src/b/y.ts");
  await build(a, {}, b);
  assert.match(await pr(a, { head: "sib" }), FAILED);
  assert.match(await settle(a), /revise or answer/);
});

test("D39: the FAIL checkout removed after a merge: a findings run in main at the FAIL commit clears it, and the finish stands", async (t) => {
  const { w, a } = await setup(t, { onMain: true });
  w.state.answer = "allow once";
  const wt = worktree(w, "gone");
  commitIn(wt, "src/a/x.ts");
  await build(a, sized(["design"]), wt);
  await hsRun(a, "FAIL", wt);
  git(w.project, "merge", "-q", "--ff-only", "gone");
  git(w.project, "worktree", "remove", "--force", wt);
  const r = await launch(a, "reviewer", "review the change");
  assert.equal(r.blocked, null, String(r.blocked));
  assert.ok(String(r.input.task).startsWith(FINDINGS));
  await end(a, r, "reviewer", "Overall verdict: PASS");
  assert.doesNotMatch(await pr(a), /high_stakes_failed/);
  const fin = await settle(a);
  assert.doesNotMatch(fin, /FAILED|revise or answer|re-review needed|gone/, fin);
});

test("D39: a FAIL checkout outside git: a findings run that passes in the same directory clears it", async (t) => {
  const { w, a } = await setup(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-hs-nogit-"));
  t.after(() => rmTestTmp(dir));
  w.state.answer = "allow once";
  await build(a, sized(["design"]), dir);
  await hsRun(a, "FAIL", dir);
  assert.match(await settle(a), /revise or answer/);
  const r = await launch(a, "reviewer", "review the change", { cwd: dir });
  assert.equal(r.blocked, null, String(r.blocked));
  assert.ok(String(r.input.task).startsWith(FINDINGS));
  await end(a, r, "reviewer", "Overall verdict: PASS", dir);
  const fin = await settle(a);
  assert.doesNotMatch(fin, /FAILED|revise or answer|re-review needed/, fin);
});

test("namesBothTags: only a prose [pre-pr] next to a prose [high-stakes] counts; backticks, [second-opinion] and [plan-review] decide otherwise", () => {
  const of = (task: string) => namesBothTags(entryOccasions({ agent: "reviewer", task }));
  assert.equal(of("[pre-pr] and [high-stakes] review"), true);
  assert.equal(of("[high-stakes] review, not a [pre-pr]"), true);
  assert.equal(of("[pre-pr] review, `[high-stakes]` is quoted"), false);
  assert.equal(of("[high-stakes] review"), false);
  assert.equal(of("[second-opinion] [pre-pr] [high-stakes]"), false);
  assert.equal(of("[plan-review] [pre-pr] [high-stakes]"), false);
  assert.equal(namesBothTags(entryOccasions({ agent: "builder", task: "[pre-pr] [high-stakes]" })), false, "a builder task is no review");
});

test("D23: a task naming both tags is refused and traced; a quoted tag is a normal [pre-pr]; after a high-stakes FAIL a [pre-pr] launch is accepted, its PASS clears the FAIL and opens the gate on its head", async (t) => {
  const { w, a } = await setup(t);
  commitIn(w.project, "src/a/x.ts");
  await build(a, sized(["design"]));
  const both = await launch(a, "reviewer", "[pre-pr] review the branch; also [high-stakes]");
  assert.match(both.blocked ?? "", /\[review_occasion_ambiguous\]/);
  assert.equal((await traces(w, "review_occasion_ambiguous")).length, 1);
  await hsRun(a, "FAIL");
  assert.match(await pr(a), FAILED);
  const quoted = await launch(a, "reviewer", "[pre-pr] review the branch, not a `[high-stakes]` one");
  assert.equal(quoted.blocked, null, String(quoted.blocked));
  assert.ok(String(quoted.input.task).startsWith(FINDINGS), "it gets the findings");
  await end(a, quoted, "reviewer", "Overall verdict: PASS");
  assert.equal(await pr(a), "", "counts as a normal PASS: the gate opens on its head");
  assert.doesNotMatch(await settle(a), /FAILED|revise or answer/);
});
