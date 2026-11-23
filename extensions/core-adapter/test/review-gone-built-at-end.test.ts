// D165: the build time of a checkout is the end of its last builder run; a builder still running in a deleted checkout keeps it blocking.
import assert from "node:assert/strict";
import { test } from "node:test";
import { gatesBuilt, supersededGone } from "../reviewgates.ts";
import type { ReviewGates } from "../reviewgates.ts";
import { build, end, git, launch, settle, setup, tick, worktree } from "./_hsrig.ts";

const gone = (...dirs: string[]) => (d: string) => !dirs.includes(d);

test("gatesBuilt: the end time moves up the build time of the named entries only, never back", () => {
  const g: ReviewGates = { "/a": { last: null, revised: true, builtAt: 100 }, "/b": { last: null, revised: true, builtAt: 100 } };
  const r = gatesBuilt(g, ["/a"], 300);
  assert.equal(r["/a"].builtAt, 300);
  assert.equal(r["/b"].builtAt, 100);
  assert.equal(gatesBuilt(r, ["/a"], 200)["/a"].builtAt, 300);
  assert.equal(gatesBuilt(g, null, 400)["/b"].builtAt, 400);
});

test("supersededGone: a PASS between the build launch and the build end does not supersede; a running builder is never dropped", () => {
  const stamped: ReviewGates = { "/a": { last: "pass", revised: false, passAt: 200 }, "/b": { last: null, revised: true, builtAt: 100 } };
  assert.deepEqual(supersededGone(stamped, gone("/b")).dropped.map((d) => d.dir), ["/b"], "launch-time stamp alone is superseded");
  const ended = gatesBuilt(stamped, ["/b"], 250);
  assert.deepEqual(supersededGone(ended, gone("/b")).dropped, []);
  assert.deepEqual(supersededGone(stamped, gone("/b"), new Set(["/b"])).dropped, []);
});

async function two(t: Parameters<typeof setup>[0]) {
  const s = await setup(t);
  const b = worktree(s.w, "wtb");
  s.w.state.answer = "allow once";
  return { ...s, b };
}

test("end to end: launch in B, build and PASS in A, B's builder ends, B deleted -> the finish stays refused", async (t) => {
  const { a, w, b } = await two(t);
  const nb = await launch(a, "builder", "build it", { cwd: b });
  assert.equal(nb.blocked, null, String(nb.blocked));
  await tick(20);
  await build(a); // build and PASS in the own checkout, after B's launch
  await tick(20);
  await end(a, nb, "builder", "done", b); // B is built after the PASS
  git(w.project, "worktree", "remove", "--force", b);
  assert.match(await settle(a), /wtb/);
  assert.equal(w.notes.filter((n) => n.includes("superseded")).length, 0);
});

test("end to end: a builder still running in B when B is deleted drops nothing; once it ends the finish is refused", async (t) => {
  const { a, w, b } = await two(t);
  const nb = await launch(a, "builder", "build it", { cwd: b });
  assert.equal(nb.blocked, null, String(nb.blocked));
  await tick(20);
  await build(a);
  git(w.project, "worktree", "remove", "--force", b);
  await settle(a); // the open run holds the finish gate itself; the gates read meanwhile drop nothing
  assert.equal(w.notes.filter((n) => n.includes("superseded")).length, 0);
  await end(a, nb, "builder", "done", b);
  assert.match(await settle(a), /wtb/);
  assert.equal(w.notes.filter((n) => n.includes("superseded")).length, 0);
});
