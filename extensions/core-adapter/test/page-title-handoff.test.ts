// The page title of a child's handoff plan.md (show.ts titleOfCur): the topic from the handoff folder name when the plan has no heading and no plan-<topic> file name.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Show } from "../show.ts";
import type { PagesIndex } from "../pages.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

function start(t: { after: (fn: () => void) => void }, folder: string, plan: string) {
  const root = fs.realpathSync.native(mkTestTmp("pf-title-"));
  t.after(() => rmTestTmp(root));
  const ws = path.join(root, "ws");
  const handoff = path.join(root, "handoffs", folder);
  for (const d of [path.join(ws, ".git"), path.join(ws, ".workflow/scratch"), handoff, path.join(root, "agent")]) fs.mkdirSync(d, { recursive: true });
  const file = path.join(handoff, "plan.md");
  fs.writeFileSync(file, plan);
  const show = Show.start({ agentDir: path.join(root, "agent"), sessionId: "s1", cwd: ws, home: root, platform: process.platform, scratchDir: ".workflow/scratch", handoffDir: handoff, trace: () => undefined } as never)!;
  return { show, file };
}
const titles = (show: Show) => (JSON.parse(fs.readFileSync(path.join(show.dir, "pages", "pages.json"), "utf8")) as PagesIndex).pages.map((p) => p.title);

test("handoff plan.md without a heading: the page title is the handoff folder's label, not '## Summary'", async (t) => {
  const { show, file } = start(t, "20260101-120000-page-server", "## Summary\n\n**Goal:** serve pages.\n\n## For the owner\nx\n");
  assert.equal(show.planWritten(file), true);
  await show.idle();
  assert.deepEqual(titles(show), ["page-server"]);
});

test("handoff plan.md with a heading keeps it; a folder without a stamp keeps the first line", async (t) => {
  const a = start(t, "20260101-120000-page-server", "# Own title\n\n## Summary\nx\n");
  a.show.planWritten(a.file);
  await a.show.idle();
  assert.deepEqual(titles(a.show), ["Own title"]);
  const b = start(t, "plainfolder", "## Summary\n\nx\n");
  b.show.planWritten(b.file);
  await b.show.idle();
  assert.deepEqual(titles(b.show), ["## Summary"]);
});
