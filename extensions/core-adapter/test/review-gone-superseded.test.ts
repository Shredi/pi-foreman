// D165: the finish gate drops a deleted checkout only when another checkout got a PASS after the deleted one's last build; a visible line names it.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { goneDropped } from "../reviewgates.ts";
import type { ReviewGates } from "../reviewgates.ts";
import { build, end, git, launch, settle, setup, tick, worktree } from "./_hsrig.ts";
import type { Rig } from "./_hsrig.ts";

const real = (p: string) => fs.realpathSync.native(p);
const gone = (...dirs: string[]) => (d: string) => !dirs.includes(d);

test("goneDropped: a gone entry is dropped whatever its state, with or without a PASS elsewhere, and named", () => {
  const g: ReviewGates = {
    "/a": { last: "pass", revised: false },
    "/b": { last: null, revised: true },
  };
  const r = goneDropped(g, gone("/b"));
  assert.deepEqual(Object.keys(r.gates), ["/a"]);
  assert.deepEqual(r.dropped, ["/b"]);
  const only: ReviewGates = { "/b": { last: null, revised: true } };
  assert.deepEqual(goneDropped(only, gone("/b")).dropped, ["/b"], "no PASS anywhere");
  const failed: ReviewGates = { "/a": { last: "pass", revised: false }, "/b": { last: "fail", revised: false, failAt: 300 } };
  assert.deepEqual(goneDropped(failed, gone("/b")).dropped, ["/b"], "a FAIL");
  const bothGone: ReviewGates = { "/a": { last: "pass", revised: false }, "/b": { last: null, revised: true } };
  assert.deepEqual(goneDropped(bothGone, gone("/b", "/a")).dropped, ["/a", "/b"]);
});

test("goneDropped: a live entry and the session-wide one are never dropped", () => {
  const live: ReviewGates = { "/a": { last: "pass", revised: false }, "/b": { last: null, revised: true }, "": { last: null, revised: true } };
  assert.deepEqual(Object.keys(goneDropped(live, () => true).gates).sort(), ["", "/a", "/b"]);
  assert.deepEqual(Object.keys(goneDropped(live, () => false).gates), [""]);
});

async function two(t: Parameters<typeof setup>[0]) {
  const s = await setup(t);
  const b = worktree(s.w, "wtb");
  s.w.state.answer = "allow once";
  return { ...s, b };
}
const rebuiltAndPassed = async (a: Rig): Promise<void> => {
  await tick(20);
  await build(a); // a builder in the own checkout, then its PASS: after B's last build
};

test("end to end: a deleted checkout built before a later PASS in the own checkout does not block, one visible line, also after a reload", async (t) => {
  const { a, w, b } = await two(t);
  await build(a);
  const nb = await launch(a, "builder", "build it", { cwd: b });
  await end(a, nb, "builder", "done", b);
  git(w.project, "worktree", "remove", "--force", b);
  await rebuiltAndPassed(a);
  assert.equal(await settle(a), "");
  const lines = w.notes.filter((n) => n.includes("deleted, dropped from the finish check"));
  assert.equal(lines.length, 1, w.notes.join("\n"));
  assert.ok(lines[0].includes(path.join(path.dirname(real(w.project)), "wtb")), lines[0]);
  assert.equal(await settle(a), "");
  assert.equal(w.notes.filter((n) => n.includes("deleted, dropped")).length, 1, "one line per dropped checkout");
  await a.down();
  const a2 = await w.adapter("reload");
  assert.equal(await settle(a2), "", "after a reload the gone checkout is still dropped");
});

test("end to end: a deleted checkout built after the only PASS no longer blocks (D189b)", async (t) => {
  const { a, w, b } = await two(t);
  await build(a);
  await tick(20);
  const nb = await launch(a, "builder", "build it", { cwd: b });
  await end(a, nb, "builder", "done", b);
  git(w.project, "worktree", "remove", "--force", b);
  assert.equal(await settle(a), "");
  assert.equal(w.notes.filter((n) => n.includes("deleted, dropped from the finish check")).length, 1);
});
