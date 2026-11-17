// The high-stakes dead ends, second part: the repeat refusal after a FAIL, the clear keys through a reload and an evicted root, D23 off and in a child, and the per-checkout climb and gates.
// Pure parts first (reviewgates, HighStakes, descendsFrom), then the wiring over real worktrees.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { initialReviewGate, onReviewVerdicts } from "../bound.ts";
import { descendsFrom, HighStakes, repoKeyOf } from "../highstakes.ts";
import { gatesClearFail, gatesVerdict } from "../reviewgates.ts";
import { build, commitIn, end, git, hsRun, launch, settle, setup, traces, worktree } from "./_hsrig.ts";
import { rmTestTmp } from "./_tmpbase.ts";

const X = "a".repeat(40);
const sized = (risk: string[]) => ({ size: { files: ["src/a/x.ts"] }, risk });
const REPEAT = /the last review passed/;

test("a FAIL saved and loaded back keeps its gate key and time: a later PASS still clears that entry and no other", () => {
  const hs = new HighStakes();
  hs.fire(["design"]);
  hs.recordFail("/w/a", X, "1. FAIL x", { repoKey: "/r/.git", gateKey: "/w/a", failAt: 7 });
  const back = new HighStakes();
  back.load(hs.snapshot());
  const fail = back.openFail()!;
  assert.equal(fail.gateKey, "/w/a");
  assert.equal(fail.failAt, 7);
  const failed = onReviewVerdicts(initialReviewGate(), ["fail"], 7, "r0");
  const g = gatesClearFail({ "/w/a": failed, "/w/b": failed }, fail.gateKey ?? null, fail.failAt, 10, "r2");
  assert.equal(g["/w/a"]!.last, "pass");
  assert.equal(g["/w/b"]!.last, "fail");
});

test("a PASS whose checkouts were evicted (no roots) clears only the session-wide entry, never a checkout's own", () => {
  const failed = onReviewVerdicts(initialReviewGate(), ["fail"], 7, "r0");
  const g = gatesVerdict({ "/w/a": failed, "": failed }, [], ["pass"], 9, "r1");
  assert.equal(g[""]!.last, "pass");
  assert.equal(g["/w/a"]!.last, "fail");
});

test("a FAIL with no recorded commit is cleared by a PASS in the same repository and not by one in another", async (t) => {
  const mk = () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-hs-nohead-")));
    t.after(() => rmTestTmp(dir));
    execFileSync("git", ["-C", dir, "init", "-q"]);
    return dir;
  };
  const one = mk();
  const two = mk();
  const run = { verdict: "fail", head: null, cwd: one, revised: false, handed: true, cleared: false, repoKey: await repoKeyOf(one) } as const;
  assert.equal(await descendsFrom(run, one, X), true, "the same repository");
  assert.equal(await descendsFrom(run, two, X), false, "another repository");
});

test("D30: a fresh untagged reviewer after a FAIL is not refused as a repeat when the PASS stood in the removed checkout and in main (the probe); a standing PASS in main alone is no exit to fake", async (t) => {
  const { w, a } = await setup(t, { onMain: true });
  w.state.answer = "allow once";
  const wt = worktree(w, "gone");
  commitIn(wt, "src/a/x.ts");
  await build(a, sized(["design"]), wt);
  git(w.project, "merge", "-q", "--ff-only", "gone");
  await end(a, await launch(a, "reviewer", "[pre-pr] review the branch"), "reviewer", "Overall verdict: PASS");
  await hsRun(a, "FAIL", wt);
  git(w.project, "worktree", "remove", "--force", wt);
  const r = await launch(a, "reviewer", "review the change");
  assert.equal(r.blocked, null, String(r.blocked));
  assert.ok(String(r.input.task).startsWith("[pi-foreman high-stakes findings]"), "it gets the findings");
});

test("D30: FAIL in A, main holds a standing PASS at X, A removed: an untagged reviewer in main is not refused", async (t) => {
  const { w, a } = await setup(t, { onMain: true });
  w.state.answer = "allow once";
  await build(a);
  const wt = worktree(w, "gone");
  commitIn(wt, "src/a/x.ts");
  await build(a, sized(["design"]), wt);
  await hsRun(a, "FAIL", wt);
  git(w.project, "worktree", "remove", "--force", wt);
  const r = await launch(a, "reviewer", "review the change");
  assert.equal(r.blocked, null, String(r.blocked));
});

test("with no high-stakes model the repeat refusal of a standing PASS stays (no findings exist to count as a change)", async (t) => {
  const { a } = await setup(t, { ceremony: { highStakes: {} } });
  await build(a);
  const r = await launch(a, "reviewer", "review the change");
  assert.match(r.blocked ?? "", REPEAT);
});

test("D23: with the feature off a task naming both tags is still refused as ambiguous; in a child session it is not", async (t) => {
  const { w, a } = await setup(t, { ceremony: { highStakes: {} } });
  const both = await launch(a, "reviewer", "[pre-pr] review the branch; also [high-stakes]");
  assert.match(both.blocked ?? "", /\[review_occasion_ambiguous\]/);
  assert.equal((await traces(w, "review_occasion_ambiguous")).length, 1);
  process.env.PI_SUBAGENT_CHILD = "1"; // the world restores the environment at its end
  const c = await w.adapter("startup");
  const r = await launch(c, "reviewer", "[pre-pr] review the branch; also [high-stakes]");
  assert.doesNotMatch(r.blocked ?? "", /review_occasion_ambiguous/);
  assert.equal((await traces(w, "review_occasion_ambiguous")).length, 1, "no new trace");
});

test("a builder climbs for a FAIL only in its own checkout: FAIL in A, a builder in B does not climb, a builder in A does", async (t) => {
  const roles = { explorer: { model: "fake/explorer" }, builder: { model: "fake/builder", strong: { model: "fake/strong" } }, reviewer: { model: "fake/reviewer" } };
  const { w, a } = await setup(t, { cfg: { providers: { fake: { review: { model: "fake/review" }, roles } } } });
  w.state.answer = "allow once";
  const b = worktree(w, "wtb");
  for (const dir of [undefined, b]) {
    const x = await launch(a, "builder", "build the widget", dir ? { cwd: dir } : {});
    assert.equal(x.blocked, null, String(x.blocked));
    await end(a, x, "builder", "done", dir);
  }
  await end(a, await launch(a, "reviewer", "[pre-pr] review the branch"), "reviewer", "1. FAIL a.ts:1 broken\nOverall verdict: FAIL");
  const rev = async (cwd?: string) => {
    const x = await launch(a, "builder", "fix it", cwd ? { cwd } : {});
    assert.equal(x.blocked, null, String(x.blocked));
    await end(a, x, "builder", "done", cwd);
    return (await traces(w, "revision")).at(-1)?.reason;
  };
  assert.equal(await rev(b), "none", "B never failed");
  assert.equal(await rev(), "review_fail", "A failed");
});

test("a builder in A after the FAIL, then B's PASS (B builds on the FAIL) clears the FAIL but A's gate entry stays open", async (t) => {
  const { w, a } = await setup(t);
  w.state.answer = "allow once";
  commitIn(w.project, "src/a/x.ts");
  await build(a, sized(["design"]));
  await hsRun(a, "FAIL");
  const x = await launch(a, "builder", "fix it");
  assert.equal(x.blocked, null, String(x.blocked));
  await end(a, x, "builder", "done");
  const b = worktree(w, "wtb");
  commitIn(b, "src/b/y.ts");
  const r = await launch(a, "reviewer", "review the change", { cwd: b });
  assert.equal(r.blocked, null, String(r.blocked));
  await end(a, r, "reviewer", "Overall verdict: PASS", b);
  const fin = await settle(a);
  assert.doesNotMatch(fin, /revise or answer the high-stakes findings/, "the FAIL is cleared");
  assert.match(fin, /re-review needed/, fin);
  assert.doesNotMatch(fin, /wtb/, "only A is open");
});

test("[high-stakes] in main with a PASS only in a worktree is refused as early", async (t) => {
  const { w, a } = await setup(t, { onMain: true });
  w.state.answer = "allow once";
  const wt = worktree(w, "wtb");
  commitIn(wt, "src/a/x.ts");
  await build(a, sized(["design"]), wt);
  const hs = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.match(hs.blocked ?? "", /\[high_stakes_early\]/);
});
