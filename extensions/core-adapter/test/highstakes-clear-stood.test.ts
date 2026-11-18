// F1: clearing a high-stakes FAIL from another checkout passes only the entries whose PASS stood just before the FAIL; work done during the high-stakes run stays open.
import assert from "node:assert/strict";
import { test } from "node:test";
import { initialReviewGate, onReviewVerdicts } from "../bound.ts";
import { gatesClearFail, gatesMarkStood, gatesVerdict } from "../reviewgates.ts";
import { build, commitIn, end, hsRun, launch, persisted, settle, setup, worktree } from "./_hsrig.ts";

const sized = (risk: string[]) => ({ size: { files: ["src/a/x.ts"] }, risk });
const passed = onReviewVerdicts(initialReviewGate(), ["pass"], 1, "r0");

/** FAIL in A (a PASS stood there; a builder runs in A during the run when `during`), then a fix passed in B whose reviewer got the findings. */
async function failInAClearInB(t: Parameters<typeof setup>[0], during: boolean): Promise<string> {
  const { w, a } = await setup(t);
  w.state.answer = "allow once";
  commitIn(w.project, "src/a/x.ts");
  await build(a, sized(["design"]));
  const s = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.equal(s.blocked, null, String(s.blocked));
  if (during) {
    const x = await launch(a, "builder", "more work");
    assert.equal(x.blocked, null, String(x.blocked));
    await end(a, x, "builder", "done");
  }
  await end(a, s, "reviewer", "1. FAIL src/x.ts:1 broken\nOverall verdict: FAIL");
  const b = worktree(w, "wtb");
  commitIn(b, "src/b/y.ts");
  const r = await launch(a, "reviewer", "[pre-pr] review the change", { cwd: b });
  assert.equal(r.blocked, null, String(r.blocked));
  await end(a, r, "reviewer", "Overall verdict: PASS", b);
  return settle(a);
}

test("F1: a builder in A during the high-stakes run, FAIL, then B's PASS clears the FAIL but A stays open", async (t) => {
  const fin = await failInAClearInB(t, true);
  assert.doesNotMatch(fin, /revise or answer the high-stakes findings/, "the FAIL is cleared");
  assert.match(fin, /re-review needed/, fin);
});

test("F1: the same without a builder in A: A's gate entry passes with the clear", async (t) => {
  const fin = await failInAClearInB(t, false);
  assert.doesNotMatch(fin, /re-review needed/, fin);
  assert.doesNotMatch(fin, /revise or answer the high-stakes findings/, fin);
});

test("F1: a FAIL written to every entry (no gate key) leaves a checkout that was open at FAIL time open after the clear", () => {
  const open = { last: "pass", revised: true } as const;
  const before = { "/w/a": passed, "/w/c": open };
  const failed = gatesMarkStood(before, gatesVerdict(before, null, ["fail"], 7, "r1"));
  const cleared = gatesClearFail(failed, null, 7, 9, "r2");
  assert.equal(cleared["/w/a"]!.last, "pass");
  assert.equal(cleared["/w/c"]!.last, "fail");
});

test("F1: the stood marker survives a reload between the FAIL and the clear", async (t) => {
  const { w, a } = await setup(t);
  w.state.answer = "allow once";
  commitIn(w.project, "src/a/x.ts");
  await build(a, sized(["design"]));
  const run = await hsRun(a, "FAIL");
  await persisted(w, (hs) => hs?.runIds?.some((r: { id: string }) => r.id === `run-${run.id}`) && hs.runs.length === 1);
  await a.down();
  const b = await w.adapter("reload");
  const wtb = worktree(w, "wtb");
  commitIn(wtb, "src/b/y.ts");
  const r = await launch(b, "reviewer", "[pre-pr] review the change", { cwd: wtb });
  assert.equal(r.blocked, null, String(r.blocked));
  await end(b, r, "reviewer", "Overall verdict: PASS", wtb);
  const fin = await settle(b);
  assert.doesNotMatch(fin, /revise or answer the high-stakes findings/, "the FAIL is cleared");
  assert.doesNotMatch(fin, /re-review needed: [^)]*last verdict FAIL/, fin);
});
