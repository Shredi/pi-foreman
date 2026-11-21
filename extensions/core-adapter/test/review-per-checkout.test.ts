// The review gate per checkout, wired into the adapter (ledger 1-6): two worktrees of one repository next to the session's own checkout.
// A builder run, a project edit or a rework in one checkout leaves another checkout's PASS standing; an unknown checkout acts on all.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { build, end, git, launch, pr, settle, setup, tick, traces, worktree } from "./_hsrig.ts";
import type { Rig } from "./_hsrig.ts";

const VERDICT = "Overall verdict: PASS";
/** A normal `[pre-pr]` review in `cwd` (the own checkout by default) and its verdict. */
const review = async (a: Rig, verdict: string, cwd?: string, task = "[pre-pr] review the branch") => {
  const r = await launch(a, "reviewer", task, cwd ? { cwd } : {});
  if (r.blocked === null) await end(a, r, "reviewer", verdict, cwd);
  return r;
};
const builder = async (a: Rig, cwd?: string) => {
  const b = await launch(a, "builder", "build the widget", cwd ? { cwd } : {});
  assert.equal(b.blocked, null, String(b.blocked));
  await end(a, b, "builder", "done", cwd);
};
/** The foreman edits a project file (its tool result; the gate of the edit itself is not under test). */
const edit = async (a: Rig, file: string) => a.fire("tool_result", { toolName: "write", toolCallId: `e${Math.random()}`, input: { path: file, content: "x\n" }, details: {}, content: [{ type: "text", text: "ok" }], isError: false });
const markV = async (a: Rig): Promise<string> => {
  const r = (await a.tool("foreman_ledger")!.execute("id", { action: "mark", items: ["V"] }, undefined, undefined, a.ctx)) as { content: { text: string }[]; isError?: boolean };
  return r.content.map((c) => c.text).join("\n");
};
const STALE = /revised after the last PASS|built, no review yet|last verdict FAIL/;

async function two(t: Parameters<typeof setup>[0]) {
  const s = await setup(t);
  const b = worktree(s.w, "wtb");
  s.w.state.answer = "allow once"; // a launch in another checkout asks the gate
  return { ...s, b, real: (p: string) => fs.realpathSync.native(p) };
}

test("(a) a PASS in A stands while a builder runs in B: the finish names only B, V is refused, a second review in A is a repeat, the PR gate and the high-stakes launch in A are unchanged; B's own PASS then lets both go", async (t) => {
  const { w, a, b } = await two(t);
  await build(a);
  await tick(300);
  assert.equal(await settle(a), "", "A: PASS stands");
  await builder(a, b);
  const text = await settle(a);
  assert.match(text, /requires reviewer/);
  assert.ok(text.includes(`${fs.realpathSync.native(b)}: built, no review yet`), text);
  assert.doesNotMatch(text, /revised after the last PASS/, "A is not named");
  assert.match(await markV(a), /V closes after a reviewer PASS with no revision since/);
  const again = await launch(a, "reviewer", "review the branch again");
  assert.match(again.blocked ?? "", /the last review passed/, "A: a second review is a repeat");
  assert.equal(await pr(a), "", "pr_create in A: its PASS stands");
  const hs = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.equal(hs.blocked, null, "[high-stakes] in A is not early: A's PASS stands");
  await end(a, hs, "reviewer", VERDICT);

  await review(a, VERDICT, b);
  await tick(300);
  assert.equal(await settle(a), "", "B has its own PASS: the finish stands without a new review in A");
  assert.doesNotMatch(await markV(a), /V closes after a reviewer PASS/);
  assert.equal((await traces(w, "review_dup_refused")).length, 1);
});

test("(b) a PASS in A, then a builder in A: the finish is refused with today's hint, a review is no repeat, [high-stakes] is early", async (t) => {
  const { a, w } = await two(t);
  await build(a, {}, w.project);
  await tick(300);
  await builder(a, w.project);
  const text = await settle(a);
  assert.match(text, /requires reviewer \(re-review needed: revised after the last PASS\)/, "no path: the only open checkout is the session's own");
  const rev = await launch(a, "reviewer", "[pre-pr] review the branch");
  assert.equal(rev.blocked, null, "a review after work in the same checkout is no repeat");
  const hs = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.match(hs.blocked ?? "", /\[high_stakes_early\]/);
  assert.equal((await traces(w, "review_dup_refused")).length, 0);
});

test("an unknown checkout acts on every entry: a builder or a project edit there stales A; a review there while all stand is a repeat; its PASS clears only its own kind", async (t) => {
  const { a, w } = await two(t);
  const nowhere = fs.mkdtempSync(path.join(os.tmpdir(), "pf-nogit-"));
  t.after(() => fs.rmSync(nowhere, { recursive: true, force: true }));
  await build(a, {}, w.project);
  await tick(300);
  const rep = await launch(a, "reviewer", "review it", { cwd: nowhere });
  assert.match(rep.blocked ?? "", /the last review passed/, "an unknown root reads every entry: all stand, so a repeat");
  await builder(a, nowhere);
  assert.match(await settle(a), /requires reviewer \(re-review needed: revised after the last PASS\)/, "an unknown builder staled A");
  await review(a, VERDICT);
  await tick(300);
  assert.equal(await settle(a), "");
  await edit(a, path.join(w.project, "new", "deeper", "x.ts")); // a directory that does not exist yet: its checkout cannot be resolved
  assert.match(await settle(a), /revised after the last PASS/, "a project edit in an unresolvable dir stales every entry");
  assert.equal((await traces(w, "review_dup_refused")).length, 1);
});

test("an unknown-root reviewer PASS after a builder in B leaves B open; an unknown FAIL stales A", async (t) => {
  const { a, b } = await two(t);
  const nowhere = fs.mkdtempSync(path.join(os.tmpdir(), "pf-nogit-"));
  t.after(() => fs.rmSync(nowhere, { recursive: true, force: true }));
  await build(a);
  await builder(a, b);
  await review(a, VERDICT, nowhere);
  await tick(300);
  assert.ok((await settle(a)).includes(`${fs.realpathSync.native(b)}: built, no review yet`), "the unknown PASS cleared no checkout entry");
  await review(a, VERDICT, b);
  await tick(300);
  assert.equal(await settle(a), "");
  await review(a, "1. FAIL a.ts:1 broken\nOverall verdict: FAIL", nowhere);
  assert.match(await settle(a), /last verdict FAIL/);
});

test("a project edit in a never-reviewed B (a worktree inside the workspace) after A's PASS names B (built, no review yet); an edit in A stales A", async (t) => {
  const { a, w } = await two(t);
  const inner = path.join(w.project, "inner");
  git(w.project, "worktree", "add", "-q", "-b", "inner", inner);
  await build(a, {}, w.project);
  await tick(300);
  await edit(a, path.join(inner, "x.ts"));
  const text = await settle(a);
  assert.ok(text.includes(`${fs.realpathSync.native(inner)}: built, no review yet`) || text.includes("inner: built, no review yet"), text);
  await review(a, VERDICT, inner);
  await tick(300);
  assert.equal(await settle(a), "");
  await edit(a, path.join(a.ctx.cwd as string, "src.ts"));
  assert.match(await settle(a), /requires reviewer \(re-review needed: revised after the last PASS\)/);
});

test("a foreman_move from B to A stales both", async (t) => {
  const { a, b } = await two(t);
  await build(a);
  await review(a, VERDICT, b);
  await tick(300);
  assert.equal(await settle(a), "");
  await a.fire("tool_result", { toolName: "foreman_move", toolCallId: "m1", input: { src: path.join(b, "f.ts"), dst: path.join(a.ctx.cwd as string, "f.ts") }, details: {}, content: [{ type: "text", text: "ok" }], isError: false });
  const text = await settle(a);
  assert.match(text, /revised after the last PASS/);
  assert.ok(text.includes(fs.realpathSync.native(b)), text);
});
