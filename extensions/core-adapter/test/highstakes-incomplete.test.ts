// D90: a high-stakes run that ends `VERDICT: FAIL INCOMPLETE` records nothing, so a fresh high-stakes launch is judged on the unchanged state.
import assert from "node:assert/strict";
import { test } from "node:test";
import { build, commitIn, end, hsRun, launch, setup, traces, worktree, type Rig, type World } from "./_hsrig.ts";

const sized = (risk: string[]) => ({ size: { files: ["src/a/x.ts"] }, risk });
const INCOMPLETE = "VERDICT: FAIL INCOMPLETE\nchecks left: 3, 4";
const hsRuns = (w: World): number => (w.ceremonyEntries().at(-1)?.data as { highStakes?: { runs?: unknown[] } } | undefined)?.highStakes?.runs?.length ?? 0;

/** An incomplete high-stakes run: ended with no record, so the rig's record wait is skipped; resolves once the trace shows it. */
async function incompleteRun(a: Rig, w: World, cwd?: string) {
  const s = await launch(a, "reviewer", "[high-stakes] review the whole change", cwd ? { cwd } : {});
  assert.equal(s.blocked, null, String(s.blocked));
  a.endRunAs(s.id, "reviewer", INCOMPLETE, cwd);
  const stop = Date.now() + 15000;
  while ((await traces(w, "high_stakes")).filter((e) => e.kind === "incomplete").length === 0 && Date.now() < stop) await new Promise((r) => setTimeout(r, 20));
  return s;
}

async function standing(t: Parameters<typeof setup>[0]) {
  const r = await setup(t, { onMain: true });
  r.w.state.answer = "allow once";
  await build(r.a, sized(["design"]));
  return r;
}

test("an incomplete high-stakes run records nothing, traces incomplete, and never uses up the two passes", async (t) => {
  const { w, a } = await standing(t);
  for (let i = 0; i < 3; i++) {
    await incompleteRun(a, w);
    assert.equal((await traces(w, "high_stakes")).filter((e) => e.kind === "incomplete").length, i + 1);
    assert.equal((await traces(w, "review_high_stakes")).length, 0);
    assert.equal(hsRuns(w), 0);
  }
  const fresh = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.equal(fresh.blocked, null, String(fresh.blocked));
});

test("a fresh high-stakes launch right after an incomplete run is accepted (no pending record to wait for)", async (t) => {
  const { w, a } = await standing(t);
  const s = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.equal(s.blocked, null, String(s.blocked));
  a.endRunAs(s.id, "reviewer", INCOMPLETE);
  const fresh = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.equal(fresh.blocked, null, String(fresh.blocked));
  assert.equal(hsRuns(w), 0);
});

test("a plain high-stakes FAIL is recorded as today, and the second launch is refused as early", async (t) => {
  const { w, a } = await standing(t);
  await hsRun(a, "FAIL");
  assert.equal((await traces(w, "review_high_stakes")).length, 1);
  assert.equal(hsRuns(w), 1);
  const again = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.match(String(again.blocked), /high_stakes_early/);
});

test("a normal review ending FAIL INCOMPLETE is recorded as a FAIL as today", async (t) => {
  const { w, a } = await setup(t, { onMain: true });
  const s = await launch(a, "reviewer", "[pre-pr] review the branch");
  assert.equal(s.blocked, null, String(s.blocked));
  await end(a, s, "reviewer", INCOMPLETE);
  assert.equal((await traces(w, "high_stakes")).filter((e) => e.kind === "incomplete").length, 0);
  assert.equal((await traces(w, "review_recorded")).at(-1)?.verdict, "fail");
});

test("after a real high-stakes FAIL and a builder in another checkout, a fresh normal review is accepted", async (t) => {
  const { w, a } = await standing(t);
  await hsRun(a, "FAIL");
  const wt = worktree(w, "other");
  commitIn(wt, "src/a/y.ts");
  const b = await launch(a, "builder", "fix it", { cwd: wt });
  assert.equal(b.blocked, null, String(b.blocked));
  await end(a, b, "builder", "done", wt);
  const r = await launch(a, "reviewer", "review the change");
  assert.equal(r.blocked, null, String(r.blocked));
});
