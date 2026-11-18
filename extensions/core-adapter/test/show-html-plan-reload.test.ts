// D7 after a reload: a new Show on the same show dir loads the tracked HTML page from plan.json; no handoff trigger replaces it.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { Show } from "../show.ts";
import type { PlanJson } from "../show.ts";

const PAGE = "<html><body><h1>Widget plan</h1><section><h2>For the owner</h2><p>Goal: ship.</p></section></body></html>";
const MD = "# Child plan\n\n## For the owner\n\nGoal: x.\n";

test("html plan after a reload: handoff triggers keep the page, its version, the snapshots and the page render", async (t) => {
  const root = fs.realpathSync.native(mkTestTmp("pf-showreload-"));
  t.after(() => rmTestTmp(root));
  const ws = path.join(root, "ws");
  const scratch = path.join(ws, ".workflow/scratch");
  const handoff = path.join(root, "handoffs", "20260101-120000-job");
  for (const d of [path.join(ws, ".git"), scratch, handoff, path.join(root, "agent")]) fs.mkdirSync(d, { recursive: true });
  const page = path.join(scratch, "plan-widget.html");
  fs.writeFileSync(page, PAGE);
  const start = () => Show.start({ agentDir: path.join(root, "agent"), sessionId: "s1", cwd: ws, home: root, platform: process.platform, scratchDir: ".workflow/scratch", handoffDir: handoff, trace: () => undefined } as never)!;
  const first = start();
  await first.checkpointed(page);
  await first.idle();
  const read = (s: Show) => JSON.parse(fs.readFileSync(path.join(s.dir, "plan.json"), "utf8")) as PlanJson;
  const render = () => fs.readFileSync(path.join(first.dir, "pages", "plan.html"), "utf8");
  const before = read(first);
  const snaps = fs.readdirSync(first.dir).sort();
  const shown = render();
  assert.equal(before.path, page);

  const show = start();
  const handoffPlan = path.join(handoff, "plan.md");
  fs.writeFileSync(handoffPlan, MD);
  show.planWritten(handoffPlan);
  show.planSent(`Plan from job: ${handoffPlan}`);
  show.planReviewLaunched(`[plan-review] review ${handoffPlan}`);
  await show.idle();

  const after = read(show);
  assert.equal(after.path, page);
  assert.equal(after.v, before.v);
  assert.deepEqual(fs.readdirSync(show.dir).sort(), snaps);
  const body = (h: string) => h.replace(/<div id="pi-foreman-banner".*?<\/div>/, ""); // the banner state follows the review
  assert.equal(body(render()), body(shown));
  assert.match(render(), /Widget plan/);
  assert.ok(!render().includes("Child plan"));
});
