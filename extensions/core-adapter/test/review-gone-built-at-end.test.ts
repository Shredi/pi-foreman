// D189b: a deleted checkout never blocks the finish, also when its builder ended after the only PASS elsewhere or is still recorded as running there.
import assert from "node:assert/strict";
import { test } from "node:test";
import { build, end, git, launch, settle, setup, tick, worktree } from "./_hsrig.ts";

async function two(t: Parameters<typeof setup>[0]) {
  const s = await setup(t);
  const b = worktree(s.w, "wtb");
  s.w.state.answer = "allow once";
  return { ...s, b };
}

test("end to end: launch in B, build and PASS in A, B's builder ends, B deleted -> the finish is not refused", async (t) => {
  const { a, w, b } = await two(t);
  const nb = await launch(a, "builder", "build it", { cwd: b });
  assert.equal(nb.blocked, null, String(nb.blocked));
  await tick(20);
  await build(a); // build and PASS in the own checkout, after B's launch
  await tick(20);
  await end(a, nb, "builder", "done", b); // B is built after the PASS
  git(w.project, "worktree", "remove", "--force", b);
  assert.equal(await settle(a), "");
  assert.equal(w.notes.filter((n) => n.includes("deleted, dropped from the finish check")).length, 1);
});

test("end to end: a builder still running in B when B is deleted does not shield it: B is dropped, the finish is not refused", async (t) => {
  const { a, w, b } = await two(t);
  const nb = await launch(a, "builder", "build it", { cwd: b });
  assert.equal(nb.blocked, null, String(nb.blocked));
  await tick(20);
  await build(a);
  git(w.project, "worktree", "remove", "--force", b);
  await settle(a); // the open run holds the finish gate itself
  await end(a, nb, "builder", "done", b);
  assert.equal(await settle(a), "");
  assert.equal(w.notes.filter((n) => n.includes("deleted, dropped from the finish check")).length, 1);
});
