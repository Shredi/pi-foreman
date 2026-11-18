// The review gate per checkout, third part: a reviewer entry that does not count for items ([second-opinion], [plan-review]) gives its checkout no verdict of the launch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { build, end, launch, settle, setup, tick, worktree } from "./_hsrig.ts";
import type { Rig } from "./_hsrig.ts";

const PASS = "Overall verdict: PASS";
const FAIL = "1. FAIL src/x.ts:1 broken\nOverall verdict: FAIL";
const OPEN = /wtb: (built, no review yet|revised after the last PASS|last verdict FAIL)/;

async function two(t: Parameters<typeof setup>[0]) {
  const s = await setup(t);
  const b = worktree(s.w, "wtb");
  s.w.state.answer = "allow once";
  return { ...s, b };
}
/** PASS in A, then a builder in B. */
async function builtInB(a: Rig, b: string) {
  await build(a);
  const r = await launch(a, "builder", "build more", { cwd: b });
  assert.equal(r.blocked, null, String(r.blocked));
  await end(a, r, "builder", "done", b);
}
/** One launch with a `[pre-pr]` reviewer in A and `second` in B, ended with `outputs` (fewer results than entries allowed). */
async function mixed(a: Rig, b: string, second: string, outputs: string[]) {
  const r = await launch(a, "reviewer", "x", { tasks: [{ agent: "reviewer", task: "[pre-pr] review the branch" }, { agent: "reviewer", task: `${second} look at B`, cwd: b }] });
  assert.equal(r.blocked, null, String(r.blocked));
  a.endRunMany(r.id, outputs);
  await tick(300);
}

for (const tag of ["[second-opinion]", "[plan-review]"]) {
  test(`${tag} in B takes no verdict: A's PASS and B's FAIL leave B open`, async (t) => {
    const { a, b } = await two(t);
    await builtInB(a, b);
    assert.match(await settle(a), OPEN);
    await mixed(a, b, tag, [PASS, FAIL]);
    assert.match(await settle(a), OPEN, "B still asks for its own review");
  });
}

test("only a [second-opinion] in B leaves B open", async (t) => {
  const { a, b } = await two(t);
  await builtInB(a, b);
  const r = await launch(a, "reviewer", "[second-opinion] look at B", { cwd: b });
  assert.equal(r.blocked, null, String(r.blocked));
  await end(a, r, "reviewer", PASS, b);
  assert.match(await settle(a), OPEN);
});

test("[pre-pr] in A PASS and [pre-pr] in B FAIL: B fails", async (t) => {
  const { a, b } = await two(t);
  await builtInB(a, b);
  const r = await launch(a, "reviewer", "x", { tasks: [{ agent: "reviewer", task: "[pre-pr] review A" }, { agent: "reviewer", task: "[pre-pr] review B", cwd: b }] });
  assert.equal(r.blocked, null, String(r.blocked));
  a.endRunMany(r.id, [PASS, FAIL]);
  await tick(300);
  assert.match(await settle(a), /wtb: .*last verdict FAIL|last verdict FAIL.*wtb/s);
});

test("fewer counting results than counting entries: a PASS reaches no root", async (t) => {
  const { a, b } = await two(t);
  await builtInB(a, b);
  const r = await launch(a, "reviewer", "x", { tasks: [{ agent: "reviewer", task: "[pre-pr] review A" }, { agent: "reviewer", task: "[pre-pr] review B", cwd: b }] });
  assert.equal(r.blocked, null, String(r.blocked));
  a.endRunMany(r.id, [PASS]);
  await tick(300);
  assert.match(await settle(a), OPEN, "B got no verdict and stays open");
});
