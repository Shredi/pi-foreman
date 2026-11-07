// R11 items 4/5 (parent ruling: ruling-file lifts dropped): the former forgery probes (a ruling rewritten with its old
// mtime restored, a ruling written through a symlink) have no effect on the loop stop or the read budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_READ_LIMITS } from "../budget.ts";
import { r11Rig, reviewAllowOpts, writeAt } from "./_r11rig.ts";
import { loopRefused, rigStop } from "./_loopstop.ts";

const review = (n: number) => ({ agent: "reviewer", task: `review items ${n}` });
const capRefused = loopRefused;
const readDenied = (r: { block?: boolean; reason?: string } | undefined): boolean => r?.block === true && /\[read_budget_exceeded\]/.test(r.reason ?? "");
const WARN = DEFAULT_READ_LIMITS.before.warn;

type Rig = Awaited<ReturnType<typeof r11Rig>>;
/** A rig with the loop stop set, and a child-side handoff dir with an old ask.md. */
async function capped(t: Parameters<typeof r11Rig>[0]): Promise<{ a: Rig; dir: string }> {
  const a = await r11Rig(t, {}, reviewAllowOpts());
  const dir = a.handoff("round", "child");
  writeAt(path.join(dir, "ask.md"), "ask: one more review round?\n", Date.now() - 60_000);
  await rigStop(a);
  assert.ok(capRefused((await a.launch(review(3))).res), "stopped before any ruling");
  return { a, dir };
}

test("ruling_no_effect_rewrite_mtime_restored", async (t) => {
  const { a, dir } = await capped(t);
  const file = path.join(dir, "ruling.md");
  writeAt(file, "APPROVED\nreview-cap: +0\nread-budget: +0\n", Date.now() - 1000);
  await a.toolDoing("bash", { command: "./tools/fixup.sh" }, () => {
    const st = fs.statSync(file);
    fs.writeFileSync(file, "APPROVED\nreview-cap: +9\nread-budget: +9\n");
    fs.utimesSync(file, st.atime, st.mtime);
  });
  assert.ok(capRefused((await a.launch(review(3))).res), "the rewritten ruling does not lift the stop");
  for (let i = 0; i < WARN; i++) assert.ok(!readDenied(await a.call("bash", { command: `ls -la r${i}` })));
  assert.deepEqual(a.events("read_budget").map((r) => r.action), ["remind"], "nor the read budget: the count runs on");
  assert.deepEqual(a.events("review_cap_lift"), []);
});

test("ruling_no_effect_write_via_symlink", async (t) => {
  const { a, dir } = await capped(t);
  const link = path.join(a.project, ".workflow", "notes.md");
  fs.symlinkSync(path.join(dir, "ruling.md"), link);
  const text = "APPROVED\nreview-cap: +2\nread-budget: +20\n";
  const res = await a.toolDoing("write", { path: link, content: text }, () => fs.writeFileSync(link, text));
  assert.equal(res, undefined, `write: ${res?.reason}`);
  assert.equal(fs.readFileSync(path.join(dir, "ruling.md"), "utf8"), text, "the write landed on the ruling");
  assert.ok(capRefused((await a.launch(review(3))).res), "a ruling written through a symlink does not lift the stop");
  for (let i = 0; i < WARN; i++) assert.ok(!readDenied(await a.call("bash", { command: `ls -la s${i}` })));
  assert.deepEqual(a.events("read_budget").map((r) => r.action), ["remind"], "nor the read budget: the count runs on");
  assert.deepEqual(a.events("review_cap_lift"), []);
});
