// PR 3 of the intercom round: a parent's `ruling-<n>.md` lifts neither the review-loop stop nor the read budget (`isCapsResetName`); a brief does.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { DEFAULT_READ_LIMITS } from "../budget.ts";
import { isCapsResetName } from "../ruling.ts";
import { r11Rig, reviewAllowOpts, writeAt } from "./_r11rig.ts";
import { loopRefused, rigStop } from "./_loopstop.ts";

type Rig = Awaited<ReturnType<typeof r11Rig>>;
const WARN = DEFAULT_READ_LIMITS.before.warn;
const review = (n: number) => ({ agent: "reviewer", task: `review items ${n}` });
// A read through the grep tool counts for the budget like a shell read and starts no guard process.
const grep = (a: Rig, pattern: string) => a.toolDoing("grep", { pattern, path: "src" }, () => undefined);
const reminds = (a: Rig): number => a.events("read_budget").filter((r) => r.action === "remind").length;

async function rig(t: Parameters<typeof r11Rig>[0]): Promise<Rig> {
  const saved = process.env.PI_FOREMAN_HANDOFF_DIR;
  delete process.env.PI_FOREMAN_HANDOFF_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.PI_FOREMAN_HANDOFF_DIR;
    else process.env.PI_FOREMAN_HANDOFF_DIR = saved;
  });
  return r11Rig(t, {}, reviewAllowOpts());
}

test("isCapsResetName: a brief name, never ruling-<n>.md or a plan ruling", () => {
  for (const n of ["brief-1.md", "brief-x.y_z-9.md"]) assert.equal(isCapsResetName(n), true, n);
  for (const n of ["ruling-1.md", "ruling-12.md", "ruling.md", "ruling-plan.md", "steer-1.md", "brief.md"]) assert.equal(isCapsResetName(n), false, n);
});

test("a ruling-<n>.md leaves the loop stop in place; a brief lifts it", async (t) => {
  const a = await rig(t);
  const dir = a.handoff("round", "child");
  await rigStop(a);
  assert.ok(loopRefused((await a.launch(review(3))).res));
  writeAt(path.join(dir, "ruling-1.md"), "go on\n", Date.now());
  await a.launch(review(3)); // the ruling pickup may hold this launch once
  assert.ok(loopRefused((await a.launch(review(3))).res), "still stopped");
  assert.deepEqual(a.events("cap_reset"), []);
  writeAt(path.join(dir, "brief-1.md"), "go on\n", Date.now());
  assert.equal((await a.launch(review(3))).res, undefined);
  assert.deepEqual(a.events("cap_reset").map((r) => r.by), ["brief"]);
});

test("a ruling-<n>.md does not reset the read budget; a brief does", async (t) => {
  const a = await rig(t);
  const dir = a.handoff("round", "child");
  for (let i = 0; i < WARN + 3; i++) assert.equal(await grep(a, `src${i}`), undefined);
  assert.equal(reminds(a), 1);
  writeAt(path.join(dir, "ruling-1.md"), "go on\n", Date.now());
  await a.turnStart();
  for (let i = 0; i < WARN - 1; i++) await grep(a, `ruled${i}`);
  assert.equal(a.events("cap_reset").length, 0);
  assert.ok(reminds(a) >= 1);
  const before = reminds(a);
  writeAt(path.join(dir, "brief-1.md"), "go on\n", Date.now());
  await a.turnStart();
  for (let i = 0; i < WARN - 1; i++) await grep(a, `briefed${i}`);
  assert.equal(a.events("cap_reset").length, 1);
  assert.equal(reminds(a), before, "the count restarted after the brief");
});
