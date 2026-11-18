// A reviewer launched right after a high-stakes run end, while the record of that run end is still being written (it lands in `reviewSync` after git reads): the launch gates wait for it.
// No sleep between the run end and the next launch; each case checks first that the record is still pending.
import assert from "node:assert/strict";
import { test } from "node:test";
import { build, commitIn, launch, setup, worktree, type Rig, type World } from "./_hsrig.ts";

const sized = (risk: string[]) => ({ size: { files: ["src/a/x.ts"] }, risk });
const REPEAT = /the last review passed/;
const FINDINGS = "[pi-foreman high-stakes findings]";
const FAIL = "1. FAIL src/x.ts:1 broken\nOverall verdict: FAIL";

/** The high-stakes runs of the newest persisted ceremony state (a run record carries no run id, so the pending check counts them). */
const recordedRuns = (w: World): number => (w.ceremonyEntries().at(-1)?.data as { highStakes?: { runs?: unknown[] } } | undefined)?.highStakes?.runs?.length ?? 0;

/** A standing PASS in main (the builder and a [pre-pr] PASS), a high-stakes launch in `cwd`; returns its end, which delivers the run end with no wait. */
async function startHs(a: Rig, w: World, cwd?: string) {
  const s = await launch(a, "reviewer", "[high-stakes] review the whole change", cwd ? { cwd } : {});
  assert.equal(s.blocked, null, String(s.blocked));
  return (output: string) => {
    const before = recordedRuns(w);
    a.endRunAs(s.id, "reviewer", output, cwd);
    assert.equal(recordedRuns(w), before, "the record of the run end is still pending");
  };
}

/** The FAIL ended in a worktree while main holds a standing PASS; the run end is delivered and its record is pending. */
async function pendingFail(t: Parameters<typeof setup>[0]) {
  const { w, a } = await setup(t, { onMain: true });
  w.state.answer = "allow once";
  await build(a);
  const wt = worktree(w, "other");
  commitIn(wt, "src/a/x.ts");
  await build(a, sized(["design"]), wt);
  const endHs = await startHs(a, w, wt);
  endHs(FAIL);
  return { a };
}

test("a fresh untagged reviewer launched while a high-stakes FAIL of another checkout is still being recorded is not refused as a repeat and gets the findings", async (t) => {
  const { a } = await pendingFail(t);
  const r = await launch(a, "reviewer", "review the change");
  assert.equal(r.blocked, null, String(r.blocked));
  assert.ok(String(r.input.task).startsWith(FINDINGS), "it gets the findings");
});

// The launch hook's loop-guard wait and its own git reads also let the record land first, so this case is an outcome guard: the findings-prepend read is ordered by the loop-guard await, not by a wait of its own.
test("a [pre-pr] reviewer launched while a high-stakes FAIL is still being recorded gets the findings", async (t) => {
  const { a } = await pendingFail(t);
  const r = await launch(a, "reviewer", "[pre-pr] review the branch");
  assert.equal(r.blocked, null, String(r.blocked));
  assert.ok(String(r.input.task).startsWith(FINDINGS), "it gets the findings");
});

test("control: an untagged reviewer launched while a high-stakes PASS is still being recorded is still refused as a repeat of the standing PASS", async (t) => {
  const { w, a } = await setup(t, { onMain: true });
  w.state.answer = "allow once";
  await build(a, sized(["design"]));
  const endHs = await startHs(a, w);
  endHs("Overall verdict: PASS");
  const r = await launch(a, "reviewer", "review the change");
  assert.match(String(r.blocked), REPEAT);
});
