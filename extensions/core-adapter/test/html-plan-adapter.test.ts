// HTML plans through the adapter (index.ts): review launch, plan_copy_stale, the write hook for the page, the copy and the rulings
// sidecar, the checkpoint on the page, and the builder refusal that names the readPlan error. A page and its copy named together are one
// plan in a plan review; a rulings file is no plan for foreman_checkpoint; the loaded instructions carry the skeleton path.
// The cases share one adapter session (each case starts with `setPage`, which puts the page and its generated copy in the state it needs);
// they run in file order, which the later cases rely on (the dedup case needs the first verdict of the file).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { world, tick } from "./_r46world.ts";
import type { Block } from "./_r46world.ts";
import { readPlan, sha256 } from "../checkpoint.ts";
import { posix } from "./_platform.ts";

const PAGE = "<html><body><h1>Widget</h1><section><h2>For the owner</h2><p><strong>Goal:</strong> ship the widget.</p><ol><li>Ship it.</li></ol></section><h2>Work</h2><p>x</p></body></html>";
const BAD = "<html><body><h1>Widget</h1><h2>Work</h2><p>x</p></body></html>";
const HTML_TASK = "[plan-review] review .workflow/scratch/plan-widget.html";
const BOTH = "[plan-review] review .workflow/scratch/plan-widget.html and .workflow/scratch/plan-widget.md";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

const ends: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const fn of ends) await fn();
});
let made: ReturnType<typeof build> | undefined;
async function build() {
  const w = world({ after: (fn) => void ends.push(fn) });
  const scratch = path.dirname(w.planFile);
  fs.rmSync(w.planFile); // the markdown fixture would be a hand-written copy beside the page
  const pagePath = path.join(scratch, "plan-widget.html");
  /** The page with `page` as its text and the generated copy written again from it (the harness writes the copy). */
  const setPage = (page: string): void => {
    fs.writeFileSync(pagePath, page);
    readPlan(".workflow/scratch/plan-widget.html", { cwd: w.project, home: path.dirname(w.project), platform: process.platform, scratchDir: ".workflow/scratch" });
  };
  setPage(BAD);
  const a = await w.adapter("startup");
  return { w, a, scratch, pagePath, copy: w.planFile, setPage };
}
const shared = () => (made ??= build());

const refusedWith = (b: { blocked: string | null }, re: RegExp): boolean => re.test(b.blocked ?? "");

test("html plan: the form check of a launch runs on the copy; a write of the page reports the form faults, a write of a clean page adds nothing", async () => {
  const { a, pagePath, setPage } = await shared();
  setPage(BAD);
  const r = await a.reviewLaunch(HTML_TASK);
  assert.ok(refusedWith(r, /\[plan_form\]/), String(r.blocked));
  assert.match(r.blocked ?? "", /plan-widget\.html/);
  assert.match((await a.call("write", { path: pagePath, content: "x" })).note, /plan form is wrong/);
  fs.writeFileSync(pagePath, PAGE);
  assert.equal((await a.call("write", { path: pagePath, content: "x" })).note, "");
});

test("a task naming plan-widget.html and plan-widget.md: one form check; then one facts line, one verdict, no review_loop after a first FAIL", async () => {
  const { w, a, setPage } = await shared();
  setPage(BAD);
  const refused = await a.reviewLaunch(BOTH);
  assert.match(refused.blocked ?? "", /\[plan_form\]/);
  assert.equal(count(refused.blocked ?? "", /plan-widget\.(html|md): /g), 1, String(refused.blocked));
  setPage(PAGE);
  const r = await a.reviewLaunch(BOTH);
  assert.equal(r.blocked, null);
  assert.equal(count(r.task, /^Plan page /gm), 1, r.task);
  assert.equal(count(r.task, /^Plan: /gm), 1, r.task);
  a.endRun(r.id, "1. FAIL: the goal is vague\nOverall verdict: FAIL");
  const end = Date.now() + 10_000;
  while ((await w.traceEvents()).filter((e) => e.event === "plan_review").length < 1 && Date.now() < end) await tick(25);
  await tick(100);
  const events = await w.traceEvents();
  assert.equal(events.filter((e) => e.event === "plan_review").length, 1);
  assert.equal(events.filter((e) => e.event === "review_loop").length, 0);
  assert.equal((await a.reviewLaunch(BOTH)).blocked, null, "the next review is launched, no loop stop");
});

test("html plan: plan_copy_stale refuses a review launch when the copy cannot be written", { skip: !posix || process.getuid?.() === 0 }, async () => {
  const { w, a, scratch, pagePath, setPage } = await shared();
  setPage(PAGE);
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

test("html plan: checkpoint on the page; a page edit is plan_changed; a ruling keeps the approval; a refused rulings write names the error", async () => {
  const { w, a, scratch, pagePath, setPage } = await shared();
  setPage(PAGE);
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
  fs.rmSync(rulings);
});

test("html plan: a [plan-review] launch naming the page or its copy starts and writes the copy; the checkpoint tool text names both extensions; a write over the copy is refused or repaired", async () => {
  const { a, copy, setPage } = await shared();
  setPage(PAGE);
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

test("foreman_checkpoint does not accept rulings-x.md as a plan; the loaded instructions carry the skeleton path, byte-identical on every load", async () => {
  const { a, scratch } = await shared();
  fs.writeFileSync(path.join(scratch, "plan-x.html"), PAGE);
  fs.writeFileSync(path.join(scratch, "rulings-x.md"), "Use the small one.\n");
  const tool = a.tool("foreman_checkpoint")!;
  const res = (await tool.execute("ck", { path: ".workflow/scratch/rulings-x.md" }, undefined, undefined, a.ctx)) as { details: { decision: string } };
  assert.equal(res.details.decision, "refused");
  // the same world: the skeleton placeholder becomes the absolute skeleton path
  const load = async (): Promise<string> => {
    const event = { prompt: "go", systemPrompt: "", systemPromptOptions: { sections: {} as Record<string, string> } };
    await a.fire("before_agent_start", event);
    return event.systemPromptOptions.sections["pi-foreman"] ?? "";
  };
  const one = await load();
  const two = await load();
  const skeleton = path.join(root, "instructions", "plan-skeleton.html");
  assert.ok(one.includes(skeleton), "the absolute skeleton path is in the text");
  assert.ok(!one.includes("{{planSkeleton}}"));
  assert.equal(one, two);
});
