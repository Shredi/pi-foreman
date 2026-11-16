// The child owns its plan (PR 4): the parent's plan approval is gone, its brief stays. A parent-written `brief-<x>.md` still lifts the
// loop stop; a `ruling-plan.md` beside it lifts nothing; the child still cannot write a brief into its own handoff dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { SELF_RULING_REASON, selfRulingRefusal } from "../ruling.ts";
import { r11Rig, reviewAllowOpts, writeAt } from "./_r11rig.ts";
import { loopRefused, rigStop } from "./_loopstop.ts";

const review = { agent: "reviewer", task: "review items 3" };

test("a ruling-plan.md lifts no stop and a brief still does; the child's own write of a brief is refused", async (t) => {
  const saved = process.env.PI_FOREMAN_HANDOFF_DIR;
  delete process.env.PI_FOREMAN_HANDOFF_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.PI_FOREMAN_HANDOFF_DIR;
    else process.env.PI_FOREMAN_HANDOFF_DIR = saved;
  });
  const a = await r11Rig(t, {}, reviewAllowOpts());
  const dir = a.handoff("round", "child");
  // the child's own write of a brief, by tool and by shell, is refused (the write protection stays)
  const own = path.join(dir, "brief-9.md");
  assert.equal(selfRulingRefusal("write", { path: own, content: "go\n" }, dir, [dir]), SELF_RULING_REASON);
  assert.equal(selfRulingRefusal("bash", { command: `printf go > ${own}` }, dir, [dir]), SELF_RULING_REASON);
  const blocked = await a.call("write", { path: own, content: "go\n" });
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /cannot write its own parent's ruling/);
  await rigStop(a);
  assert.ok(loopRefused((await a.launch(review)).res), "stopped");
  writeAt(path.join(dir, "ruling-plan.md"), "APPROVED\n", Date.now());
  assert.ok(loopRefused((await a.launch(review)).res), "a ruling-plan.md lifts nothing");
  writeAt(path.join(dir, "brief-2.md"), "go on\n", Date.now() + 1);
  assert.equal((await a.launch(review)).res, undefined, "a brief lifts the stop");
  assert.deepEqual(a.events("cap_reset").map((r) => [r.by, r.count]), [["brief", 1]]);
});
