// The review gate per checkout, fourth part: the launch-time occasion decides the root (a quoted tag in the diff facts changes nothing), and a review, builder, review chain keeps its final PASS.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { build, commitIn, end, launch, settle, setup, tick, worktree } from "./_hsrig.ts";

const PASS = "Overall verdict: PASS";
const FAIL = "1. FAIL src/x.ts:1 broken\nOverall verdict: FAIL";
const OPEN = /wtb: (built, no review yet|revised after the last PASS|last verdict FAIL)/;

test("a [second-opinion] quoted in the diff facts does not drop an untagged reviewer's checkout", async (t) => {
  const { w, a } = await setup(t);
  commitIn(w.project, "x.test.ts", 'assert.match(t, "a [second-opinion] b");\n');
  const b = worktree(w, "wtb");
  w.state.answer = "allow once";
  await build(a);
  const r = await launch(a, "builder", "change the assertion", { cwd: b });
  assert.equal(r.blocked, null, String(r.blocked));
  fs.writeFileSync(path.join(b, "x.test.ts"), 'assert.match(t, "a changed b");\n');
  await end(a, r, "builder", "done", b);
  assert.match(await settle(a), OPEN);
  await end(a, await launch(a, "reviewer", "review the change", { cwd: b }), "reviewer", PASS, b);
  assert.doesNotMatch(await settle(a), OPEN, "B has its own PASS");
});

test("FAIL, builder, PASS in the own checkout: the final PASS stands", async (t) => {
  const { w, a } = await setup(t);
  w.state.answer = "allow once";
  const b = await launch(a, "builder", "build the widget");
  assert.equal(b.blocked, null, String(b.blocked));
  await end(a, b, "builder", "done");
  const r = await launch(a, "reviewer", "x", { tasks: [{ agent: "reviewer", task: "[pre-pr] review" }, { agent: "builder", task: "fix it" }, { agent: "reviewer", task: "[pre-pr] review again" }] });
  assert.equal(r.blocked, null, String(r.blocked));
  a.endRunResults(r.id, [{ agent: "reviewer", output: FAIL }, { agent: "builder", output: "fixed" }, { agent: "reviewer", output: PASS }]);
  await tick(300);
  assert.doesNotMatch(await settle(a), /requires reviewer|last verdict FAIL/);
});
