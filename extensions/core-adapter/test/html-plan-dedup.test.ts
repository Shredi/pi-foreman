// A `[plan-review]` task naming a plan page and its markdown copy is one plan (index.ts readPlansOnce): one form check, one facts line,
// one verdict recorded, and no [review_loop] after a first FAIL.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { world, tick } from "./_r46world.ts";
import { readPlan } from "../checkpoint.ts";

const PAGE = "<html><body><h1>Widget</h1><section><h2>For the owner</h2><p>Goal: ship the widget.</p></section><h2>Work</h2><p>x</p></body></html>";
const BAD = "<html><body><h1>Widget</h1><h2>Work</h2><p>x</p></body></html>";
const BOTH = "[plan-review] review .workflow/scratch/plan-widget.html and .workflow/scratch/plan-widget.md";
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

function htmlWorld(t: Parameters<typeof world>[0], page: string) {
  const w = world(t);
  const scratch = path.dirname(w.planFile);
  fs.rmSync(w.planFile);
  fs.writeFileSync(path.join(scratch, "plan-widget.html"), page);
  readPlan(".workflow/scratch/plan-widget.html", { cwd: w.project, home: path.dirname(w.project), platform: process.platform, scratchDir: ".workflow/scratch" });
  return w;
}

test("a task naming plan-widget.html and plan-widget.md: one form check", async (t) => {
  const w = htmlWorld(t, BAD);
  const a = await w.adapter("startup");
  const r = await a.reviewLaunch(BOTH);
  assert.match(r.blocked ?? "", /\[plan_form\]/);
  assert.equal(count(r.blocked ?? "", /plan-widget\.(html|md): /g), 1, String(r.blocked));
});

test("a task naming plan-widget.html and plan-widget.md: one facts line, one verdict, no review_loop after a first FAIL", async (t) => {
  const w = htmlWorld(t, PAGE);
  const a = await w.adapter("startup");
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
