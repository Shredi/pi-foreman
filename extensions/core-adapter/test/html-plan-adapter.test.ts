// HTML plans through the adapter (index.ts): review launch, plan_copy_stale, the write hook for the page, the copy and the rulings
// sidecar, the checkpoint on the page, and the builder refusal that names the readPlan error.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { world } from "./_r46world.ts";
import type { Block } from "./_r46world.ts";
import { readPlan, sha256 } from "../checkpoint.ts";

const PAGE = "<html><body><h1>Widget</h1><section><h2>For the owner</h2><p>Goal: ship the widget.</p></section><h2>Work</h2><p>x</p></body></html>";
const BAD = "<html><body><h1>Widget</h1><h2>Work</h2><p>x</p></body></html>";
const HTML_TASK = "[plan-review] review .workflow/scratch/plan-widget.html";

function htmlWorld(t: Parameters<typeof world>[0], page = PAGE) {
  const w = world(t);
  const scratch = path.dirname(w.planFile);
  fs.rmSync(w.planFile); // the markdown fixture would be a hand-written copy beside the page
  fs.writeFileSync(path.join(scratch, "plan-widget.html"), page);
  // the world expects plan-widget.md to exist: the harness writes the generated copy now
  readPlan(".workflow/scratch/plan-widget.html", { cwd: w.project, home: path.dirname(w.project), platform: process.platform, scratchDir: ".workflow/scratch" });
  return { w, scratch, pagePath: path.join(scratch, "plan-widget.html"), copy: w.planFile };
}

const refusedWith = (b: { blocked: string | null }, re: RegExp): boolean => re.test(b.blocked ?? "");

test("html plan: a [plan-review] launch naming the page or its copy starts and writes the copy; the checkpoint tool text names both extensions; a write over the copy is refused or repaired", async (t) => {
  const { w, copy } = htmlWorld(t);
  const a = await w.adapter("startup");
  assert.equal((await a.reviewLaunch(HTML_TASK)).blocked, null);
  assert.match(fs.readFileSync(copy, "utf8"), /## For the owner/);
  assert.equal((await a.reviewLaunch()).blocked, null, "the default task names plan-widget.md, the copy");
  // the same world: the checkpoint tool text names both extensions
  const tool = a.tool("foreman_checkpoint") as unknown as { description: string; parameters: { properties: { path: { description: string } } } };
  assert.match(tool.description, /plan-<topic>\.html/);
  assert.match(tool.parameters.properties.path.description, /\.html/);
  // the same world: a write over the generated copy is told to edit the page and the copy is written again
  const marker = fs.readFileSync(copy, "utf8");
  fs.writeFileSync(copy, `${marker}\nedited\n`);
  const first = await a.call("write", { path: copy, content: "x" });
  assert.match(first.note, /generated from plan-widget\.html/);
  assert.equal(fs.readFileSync(copy, "utf8"), marker);
  // and a write that drops the marker of the copy puts the readPlan refusal into the write result
  fs.writeFileSync(copy, "# mine\n");
  const r = await a.call("write", { path: copy, content: "x" });
  assert.match(r.note, /plan-widget\.md/);
  assert.equal(fs.readFileSync(copy, "utf8"), "# mine\n", "a hand-written file is never overwritten");
});

test("html plan: the form check of a launch runs on the copy; a write of the page reports the form faults, a write of a clean page adds nothing", async (t) => {
  const { w, pagePath } = htmlWorld(t, BAD);
  const a = await w.adapter("startup");
  const r = await a.reviewLaunch(HTML_TASK);
  assert.ok(refusedWith(r, /\[plan_form\]/), String(r.blocked));
  assert.match(r.blocked ?? "", /plan-widget\.html/);
  assert.match((await a.call("write", { path: pagePath, content: "x" })).note, /plan form is wrong/);
  fs.writeFileSync(pagePath, PAGE);
  assert.equal((await a.call("write", { path: pagePath, content: "x" })).note, "");
});

test("html plan: plan_copy_stale refuses a review launch when the copy cannot be written", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
  const { w, scratch, pagePath } = htmlWorld(t);
  const a = await w.adapter("startup");
  assert.equal((await a.reviewLaunch(HTML_TASK)).blocked, null);
  fs.writeFileSync(pagePath, PAGE.replace("ship the widget", "ship the gadget"));
  fs.chmodSync(scratch, 0o555);
  let r: { blocked: string | null };
  try {
    r = await a.reviewLaunch(HTML_TASK);
  } finally {
    fs.chmodSync(scratch, 0o755); // before the world's cleanup
  }
  assert.ok(refusedWith(r, /\[plan_copy_stale\]/), String(r.blocked));
  assert.match(r.blocked ?? "", /no reviewer was started/);
  const trace = await w.traceEvents();
  assert.ok(trace.some((e) => e.event === "launch_refused" && e.reason === "plan_copy_stale"));
});

test("html plan: checkpoint on the page; a page edit is plan_changed; a ruling keeps the approval; a refused rulings write names the error", async (t) => {
  const { w, scratch, pagePath } = htmlWorld(t);
  const a = await w.adapter("startup");
  assert.equal(await a.review("PASS"), null);
  const tool = a.tool("foreman_checkpoint")!;
  const ck = async (p: string) => (await tool.execute("ck", { path: p }, undefined, undefined, a.ctx)) as { details: { decision: string } };
  assert.equal((await ck(".workflow/scratch/plan-widget.html")).details.decision, "approve");
  const rec = w.ceremonyEntries().at(-1)!.data as { plan: { hash: string } };
  assert.equal(rec.plan.hash, sha256(Buffer.from(PAGE)));
  assert.equal(await a.launch("builder"), undefined, "the approval opens the gate");

  const rulings = path.join(scratch, "rulings-widget.md");
  fs.writeFileSync(rulings, "Use the small one.\n");
  assert.equal((await a.call("write", { path: rulings, content: "x" })).note, "");
  assert.equal(await a.launch("builder"), undefined, "a ruling does not reset the approval");
  assert.match(fs.readFileSync(path.join(scratch, "plan-widget.md"), "utf8"), /Use the small one/);

  fs.writeFileSync(rulings, "x".repeat(300 * 1024));
  const bad = await a.call("write", { path: rulings, content: "x" });
  assert.match(bad.note, /256|large|limit/i, "the readPlan refusal reaches the write result");
  const refused = (await a.launch("builder")) as Block;
  assert.ok(refused?.block);
  assert.match(refused?.reason ?? "", /plan_changed/);
  assert.match(refused?.reason ?? "", /cannot be read/);

  fs.writeFileSync(rulings, "ok\n");
  fs.writeFileSync(pagePath, PAGE.replace("<p>x</p>", "<p>y</p>"));
  const changed = (await a.launch("builder")) as Block;
  assert.match(changed?.reason ?? "", /plan_changed/);
});
