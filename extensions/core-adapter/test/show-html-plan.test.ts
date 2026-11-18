// HTML plans in show.ts and pages.ts (D5, D7): the plan page is the model's page with a banner and the rulings; a page and its copy
// are one tracked plan; the child's handoff plan.md never replaces a tracked scratch page.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { sha256 } from "../checkpoint.ts";
import { Show } from "../show.ts";
import type { PlanJson } from "../show.ts";

const PAGE = "<html><body><h1>Widget plan</h1><section><h2>For the owner</h2><p>Goal: ship.</p></section><pre class=\"mermaid\">graph TD\n A-->B</pre></body></html>";
const MD = "# Child plan\n\n## For the owner\n\nGoal: x.\n";

function env(t: { after: (fn: () => void) => void }) {
  const root = fs.realpathSync.native(mkTestTmp("pf-showhtml-"));
  t.after(() => rmTestTmp(root));
  const ws = path.join(root, "ws");
  const scratch = path.join(ws, ".workflow/scratch");
  const handoff = path.join(root, "handoffs", "20260101-120000-job");
  for (const d of [path.join(ws, ".git"), scratch, handoff, path.join(root, "agent")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(scratch, "plan-widget.html"), PAGE);
  const show = Show.start({ agentDir: path.join(root, "agent"), sessionId: "s1", cwd: ws, home: root, platform: process.platform, scratchDir: ".workflow/scratch", handoffDir: handoff, trace: () => undefined } as never)!;
  return { scratch, handoff, show, page: path.join(scratch, "plan-widget.html"), copy: path.join(scratch, "plan-widget.md") };
}

const json = (show: Show) => JSON.parse(fs.readFileSync(path.join(show.dir, "plan.json"), "utf8")) as PlanJson;
const pageFile = (show: Show): string => {
  const dir = path.join(show.dir, "pages");
  const f = fs.readdirSync(dir).find((n) => n.endsWith(".html"));
  assert.ok(f, "a page file");
  return fs.readFileSync(path.join(dir, f!), "utf8");
};

test("html plan: tracked under the page path, hash of the whole page, title from the h1, page shown with banner and escaped rulings", async (t) => {
  const e = env(t);
  fs.writeFileSync(path.join(e.scratch, "rulings-widget.md"), "# Ruling\n<script>x()</script>\n");
  assert.equal(e.show.planWritten(e.page), true);
  await e.show.idle();
  const j = json(e.show);
  assert.equal(j.path, e.page);
  assert.equal(j.title, "Widget plan");
  assert.equal(j.hash, sha256(Buffer.from(PAGE)));
  const html = pageFile(e.show);
  assert.match(html, /pi-foreman-banner/);
  assert.match(html, /Widget plan/);
  assert.ok(!html.includes("<script>x()</script>"));
});

test("html plan: a write naming the generated copy tracks the page", async (t) => {
  const e = env(t);
  e.show.planWritten(e.page);
  await e.show.idle();
  assert.equal(e.show.planWritten(e.copy), true);
  await e.show.idle();
  assert.equal(json(e.show).path, e.page);
  assert.equal(json(e.show).v, 1);
});

test("html plan: the child's handoff plan.md write, the Plan-from send and a review naming it keep the scratch page", async (t) => {
  const e = env(t);
  e.show.planWritten(e.page);
  await e.show.idle();
  const handoffPlan = path.join(e.handoff, "plan.md");
  fs.writeFileSync(handoffPlan, MD);
  e.show.planWritten(handoffPlan);
  e.show.planSent(`Plan from job: ${handoffPlan}`);
  e.show.planReviewLaunched(`[plan-review] review ${handoffPlan}`);
  await e.show.idle();
  const j = json(e.show);
  assert.equal(j.path, e.page);
  assert.equal(j.title, "Widget plan");
  assert.equal(j.v, 1);
});

test("html plan: a rulings write refreshes the page without a new version", async (t) => {
  const e = env(t);
  e.show.planWritten(e.page);
  await e.show.idle();
  fs.writeFileSync(path.join(e.scratch, "rulings-widget.md"), "Use the small one.\n");
  e.show.rulingsWritten(e.page);
  await e.show.idle();
  assert.equal(json(e.show).v, 1);
  assert.match(pageFile(e.show), /Use the small one/);
});
