// D149: a resumed reviewer whose first launch ran in another checkout (cwd = a worktree): its PASS on an unchanged head and tree keeps the head, and counts for that checkout
// (the review gate and the PR gate of the checkout), not the session's.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { commitIn, end, launch, settle, setup, tick, traces, worktree } from "./_hsrig.ts";

const real = (p: string) => fs.realpathSync.native(p);

async function resumedPass(t: Parameters<typeof setup>[0], runEndCwd: "target" | "none") {
  const s = await setup(t, { remote: true, world: { realSnapshot: true } });
  const b = worktree(s.w, "wtb");
  s.w.state.answer = "allow once";
  commitIn(b, "b.txt");
  const first = await launch(s.a, "reviewer", "[pre-pr] review the branch", { cwd: b });
  assert.equal(first.blocked, null, String(first.blocked));
  await end(s.a, first, "reviewer", "1. FAIL a.ts:1 broken\nOverall verdict: FAIL", b);
  const resumed = await launch(s.a, "reviewer", "x", { action: "resume", id: `run-${first.id}` });
  assert.equal(resumed.blocked, null, String(resumed.blocked));
  assert.ok(s.a.record(first.id, { verdict: "pass" }), "the resumed child records into the first launch's folder");
  await end(s.a, resumed, "reviewer", "Overall verdict: PASS", runEndCwd === "target" ? b : undefined);
  await tick(300);
  return { ...s, b };
}

for (const runEndCwd of ["target", "none"] as const) {
  test(`a resumed reviewer's PASS on an unchanged head and tree keeps its head (run end cwd: ${runEndCwd})`, async (t) => {
    const { w } = await resumedPass(t, runEndCwd);
    const recorded = await traces(w, "review_recorded");
    const last = recorded.at(-1)!;
    assert.equal(last.verdict, "pass");
    assert.notEqual(last.why, "head_moved", JSON.stringify(last));
    assert.equal(typeof last.head, "string", JSON.stringify(last));
  });

  test(`a resumed reviewer's PASS is recorded for its launch checkout, not the session's (run end cwd: ${runEndCwd})`, async (t) => {
    const { a, b, w } = await resumedPass(t, runEndCwd);
    const reviews = (w.ceremonyEntries().at(-1)!.data as { reviews: { verdict: string; cwd?: string; head: string | null }[] }).reviews;
    const last = reviews.at(-1)!;
    assert.equal(last.verdict, "pass");
    assert.equal(last.cwd, real(b));
    assert.equal(typeof last.head, "string");
    assert.doesNotMatch(await settle(a), new RegExp(`${real(b).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: .*(last verdict FAIL|revised)`));
  });
}
