// The review gate per checkout, second part: touch-up, rework, resumes, a deleted checkout, the child session, persistence (reload, an old entry, a malformed map).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { writeRework } from "../session.ts";
import { build, end, git, launch, settle, setup, tick, worktree } from "./_hsrig.ts";
import type { Rig, World } from "./_hsrig.ts";

const VERDICT = "Overall verdict: PASS";
const real = (p: string) => fs.realpathSync.native(p);

async function two(t: Parameters<typeof setup>[0], o: Parameters<typeof setup>[1] = {}) {
  const s = await setup(t, o);
  const b = worktree(s.w, "wtb");
  s.w.state.answer = "allow once";
  return { ...s, b };
}
const pass = async (a: Rig, cwd?: string) => {
  const r = await launch(a, "reviewer", "[pre-pr] review the branch", cwd ? { cwd } : {});
  assert.equal(r.blocked, null, String(r.blocked));
  await end(a, r, "reviewer", VERDICT, cwd);
  return r;
};
const lastEntry = (w: World) => w.ceremonyEntries().at(-1)!.data as { gate?: Record<string, unknown>; reviews: { cwd?: string }[] };
const reload = async (w: World, a: Rig): Promise<Rig> => {
  await a.down();
  return w.adapter("reload");
};
/** Waits until the newest ceremony entry holds `n` per-checkout pass marks (they land after the git reads). */
async function marks(w: World, n: number): Promise<void> {
  const stop = Date.now() + 8000;
  const count = () => Object.keys((lastEntry(w).gate?.passMarks ?? {}) as object).length;
  while (Date.now() < stop && count() < n) await tick(50);
  assert.equal(count(), n, "pass marks persisted");
}

test("a touch-up builder in A (docs only) withdraws A's revision, not B's", async (t) => {
  const { a, w, b } = await two(t, { world: { realSnapshot: true } });
  await build(a);
  await build(a, {}, b);
  await marks(w, 2);
  const nb = await launch(a, "builder", "build more", { cwd: b });
  await end(a, nb, "builder", "done", b);
  const ta = await launch(a, "builder", "tidy the docs");
  assert.equal(ta.blocked, null);
  fs.writeFileSync(path.join(w.project, "notes.md"), "words\n");
  await end(a, ta, "builder", "done");
  await tick(300);
  const text = await settle(a);
  assert.ok(text.includes(real(b)), text);
  assert.doesNotMatch(text, /unknown/);
  assert.match(text, /\(re-review needed: .*wtb: revised after the last PASS\)/, "only B stays open: A's touch-up was withdrawn");
});

test("a rework marker stales every checkout", async (t) => {
  const { a, w, b } = await two(t, { world: { handoff: true } });
  await build(a);
  await build(a, {}, b);
  await tick(300);
  assert.equal(await settle(a), "");
  writeRework(w.handoff);
  await a.call("read", { path: "x.txt" });
  const text = await settle(a);
  assert.match(text, /revised after the last PASS/);
  assert.ok(text.includes(real(b)), text);
});

test("a resumed reviewer's verdict applies to the checkouts of its target run; a resumed builder revises its target's checkout only", async (t) => {
  const { a, b } = await two(t);
  await build(a);
  const first = await launch(a, "reviewer", "[pre-pr] review the branch", { cwd: b });
  assert.equal(first.blocked, null);
  await end(a, first, "reviewer", "1. FAIL a.ts:1 broken\nOverall verdict: FAIL", b);
  assert.match(await settle(a), /last verdict FAIL/);
  const resumed = await launch(a, "reviewer", "x", { action: "resume", id: `run-${first.id}` });
  assert.equal(resumed.blocked, null, String(resumed.blocked));
  assert.ok(a.record(first.id, { verdict: "pass" }), "the resumed child records into the first launch's folder");
  await end(a, resumed, "reviewer", VERDICT);
  await tick(300);
  assert.equal(await settle(a), "", "B's gate got the PASS of its resumed review; A still stands");

  const bld = await launch(a, "builder", "build more", { cwd: b });
  await end(a, bld, "builder", "done", b);
  await pass(a, b);
  await tick(300);
  assert.equal(await settle(a), "");
  const again = await launch(a, "builder", "more", { action: "resume", id: `run-${bld.id}` });
  assert.equal(again.blocked, null, String(again.blocked));
  await end(a, again, "builder", "done", b);
  const text = await settle(a);
  assert.ok(text.includes(`${real(b)}: revised after the last PASS`), text);
  assert.doesNotMatch(text, /unknown|main: /);
});

test("a checkout deleted before its review keeps blocking the finish (the valve ends it after two refusals)", async (t) => {
  const { a, w, b } = await two(t);
  await build(a);
  const nb = await launch(a, "builder", "build it", { cwd: b });
  await end(a, nb, "builder", "done", b);
  git(w.project, "worktree", "remove", "--force", b);
  const first = await settle(a);
  assert.ok(first.includes(`${real(w.project)}/../wtb`) || first.includes("wtb: built, no review yet") || /wtb/.test(first), first);
  assert.match(await settle(a), /requires reviewer/);
  assert.equal(await settle(a), "", "the third try goes through (ceremony incomplete)");
  assert.equal((await w.traceEvents()).filter((e) => e.event === "ceremony_incomplete").length, 1);
});

test("a session opened by another session (handoff and parent) keeps the gate per checkout too", async (t) => {
  const { a, b } = await two(t, { world: { handoff: true, parent: true } });
  await build(a);
  const nb = await launch(a, "builder", "build it", { cwd: b });
  await end(a, nb, "builder", "done", b);
  const text = await settle(a);
  assert.ok(text.includes(`${real(b)}: built, no review yet`), text);
  const again = await launch(a, "reviewer", "review once more");
  assert.match(again.blocked ?? "", /the last review passed/, "A still stands");
});

test("reload: the per-checkout gates and marks come back; B's work after the reload stales B only", async (t) => {
  const { a, w, b } = await two(t);
  await build(a, {}, w.project);
  await build(a, {}, b);
  await marks(w, 2);
  const g = lastEntry(w).gate as { reviewGates: Record<string, unknown> };
  assert.deepEqual(Object.keys(g.reviewGates).sort(), [real(b), real(w.project)].sort());
  const a2 = await reload(w, a);
  assert.equal(await settle(a2), "");
  const again = await launch(a2, "reviewer", "review once more");
  assert.match(again.blocked ?? "", /the last review passed/, "the mark came back: nothing changed");
  const nb = await launch(a2, "builder", "build it", { cwd: b });
  await end(a2, nb, "builder", "done", b);
  const text = await settle(a2);
  assert.ok(text.includes(`${real(b)}: revised after the last PASS`), text);
});

test("reload of an entry from before the per-checkout gate: its single gate is the session-wide entry (a review in the own checkout is still a repeat; a later PASS clears it)", async (t) => {
  const { a, w, b } = await two(t);
  await build(a);
  await marks(w, 1);
  const gate = lastEntry(w).gate!;
  delete gate.reviewGates;
  delete gate.passMarks;
  const a2 = await reload(w, a);
  assert.equal(await settle(a2), "");
  const again = await launch(a2, "reviewer", "review once more");
  assert.match(again.blocked ?? "", /the last review passed/, "the old gate reads for the own checkout");
  const nb = await launch(a2, "builder", "build it", { cwd: b });
  await end(a2, nb, "builder", "done", b);
  assert.ok((await settle(a2)).includes(`${real(b)}: built, no review yet`), "B is open, the session-wide PASS stands");
  await pass(a2, b);
  await tick(300);
  assert.equal(await settle(a2), "");
  const bld = await launch(a2, "builder", "more");
  await end(a2, bld, "builder", "done");
  assert.match(await settle(a2), /requires reviewer/, "the own checkout is built without a review");
  await pass(a2);
  await tick(300);
  assert.equal(await settle(a2), "", "a PASS in A clears the old shared entry too");
});

test("reload: a malformed per-checkout map is dropped with the marks and the combined gate stands in as the session-wide entry", async (t) => {
  const { a, w } = await two(t);
  await build(a);
  await marks(w, 1);
  (lastEntry(w).gate as Record<string, unknown>).reviewGates = { x: 3 };
  const a2 = await reload(w, a);
  assert.equal(await settle(a2), "", "the combined PASS stands");
  const bld = await launch(a2, "builder", "more");
  await end(a2, bld, "builder", "done");
  assert.match(await settle(a2), /requires reviewer/, "the own checkout is built without a review; the session-wide PASS does not cover it");
});

test("reload with no stored gate: the newest PASS review keys the gate by its checkout; HEAD moved there stales its entry", async (t) => {
  const { a, w, b } = await two(t);
  await build(a, {}, b);
  await tick(500);
  delete lastEntry(w).gate;
  await a.down();
  execFileSync("git", ["-C", b, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "moved"]);
  const a2 = await w.adapter("reload");
  await tick(300);
  const text = await settle(a2);
  assert.match(text, /requires reviewer/);
  assert.ok(text.includes(real(b)) || /wtb/.test(text), text);
});
