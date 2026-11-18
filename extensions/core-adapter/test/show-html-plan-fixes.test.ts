// HTML plans, review fixes: a reloaded Show rolls on a handoff send, a deleted page frees the handoff plan, owner facts of a markdown plan readPlan refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { Show } from "../show.ts";
import type { PlanJson } from "../show.ts";
import { ownerFactsLines } from "../ownertext.ts";

const PAGE = "<html><body><h1>Widget plan</h1><section><h2>For the owner</h2><p>Goal: ship.</p></section></body></html>";
const MD = "# Child plan\n\n## For the owner\n\nGoal: x.\n";

function world(t: { after: (fn: () => void) => void }) {
  const root = fs.realpathSync.native(mkTestTmp("pf-showfix-"));
  t.after(() => rmTestTmp(root));
  const ws = path.join(root, "ws");
  const scratch = path.join(ws, ".workflow/scratch");
  const handoff = path.join(root, "handoffs", "20260101-120000-job");
  for (const d of [path.join(ws, ".git"), scratch, handoff, path.join(root, "agent")]) fs.mkdirSync(d, { recursive: true });
  const page = path.join(scratch, "plan-widget.html");
  const start = () => Show.start({ agentDir: path.join(root, "agent"), sessionId: "s1", cwd: ws, home: root, platform: process.platform, scratchDir: ".workflow/scratch", handoffDir: handoff, trace: () => undefined } as never)!;
  const read = (s: Show) => JSON.parse(fs.readFileSync(path.join(s.dir, "plan.json"), "utf8")) as PlanJson;
  return { root, ws, scratch, handoff, page, start, read, handoffPlan: path.join(handoff, "plan.md") };
}

test("a send of the handoff plan after a reload rolls the snapshot of the tracked page", async (t) => {
  const w = world(t);
  fs.writeFileSync(w.page, PAGE);
  const first = w.start();
  first.planWritten(w.page);
  await first.idle();
  assert.ok(!fs.existsSync(path.join(first.dir, "plan.ruled.md")));

  const show = w.start();
  fs.writeFileSync(w.handoffPlan, MD);
  show.planSent(`Plan from job: ${w.handoffPlan}`);
  await show.idle();
  assert.equal(w.read(show).path, w.page);
  assert.ok(fs.existsSync(path.join(show.dir, "plan.ruled.md")));
  assert.ok(w.read(show).ruledHash);
});

test("a deleted page no longer shadows the handoff plan, with and without a reload", async (t) => {
  const w = world(t);
  fs.writeFileSync(w.page, PAGE);
  const first = w.start();
  await first.checkpointed(w.page);
  await first.idle();
  fs.rmSync(w.page);
  fs.writeFileSync(w.handoffPlan, MD);
  assert.equal(first.planWritten(w.handoffPlan), true);
  const show = w.start();
  assert.equal(show.planWritten(w.handoffPlan), true);
  await first.idle();
  await show.idle();
});

test("owner facts of a markdown plan readPlan refuses fall back to the direct read", (t) => {
  const w = world(t);
  const sub = path.join(w.scratch, "sub");
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, "plan-a.md"), "# P\n\n## For the owner\nWe make the page faster.\n");
  const opts = { cwd: w.ws, home: w.root, platform: process.platform, scratchDir: ".workflow/scratch" };
  const [line] = ownerFactsLines([".workflow/scratch/sub/plan-a.md"], w.ws, opts);
  assert.match(line, /present \(checked by the harness\)/);
});
