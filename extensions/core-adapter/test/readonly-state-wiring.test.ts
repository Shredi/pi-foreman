// Run-end state hint, adapter wiring (plan readonly-target v11, B): a reviewer launch is pictured at the tool_call, compared at run end;
// a difference is one notice and a `readonly_state_diff` trace record; a builder launch gets no hint.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";
import { gitIn } from "./_submodules.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const wait = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
};

async function setup(t: { after(fn: () => void | Promise<void>): void }) {
  const repo = fs.realpathSync(mkTestTmp("pf-ro-wire-"));
  t.after(() => rmTestTmp(repo));
  gitIn(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "f.txt"), "f\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "init");
  const sent: Array<{ customType?: string; content?: string }> = [];
  const o = reviewAllowOpts();
  const rig = await r11Rig(t, {}, { ctx: { ...o.ctx, cwd: repo }, config: o.config, piExtra: { sendMessage: (m: { customType?: string; content?: string }) => void sent.push(m) } });
  return { rig, repo, sent };
}

test("a reviewer run that edits a tracked file ends with one notice and a trace record", async (t) => {
  const { rig, repo, sent } = await setup(t);
  const input = { agent: "reviewer", task: "look" };
  const { id, res } = await rig.launch(input);
  assert.equal(res, undefined);
  await rig.started(id, input, "run-ro-1");
  fs.writeFileSync(path.join(repo, "f.txt"), "edited\n");
  rig.end({ runId: "run-ro-1", agent: "reviewer", success: true });
  await wait(() => sent.length > 0);
  const notices = sent.filter((m) => m.customType === "pi-foreman-readonly-state");
  assert.equal(notices.length, 1);
  assert.match(notices[0].content ?? "", /f\.txt/);
  assert.ok(!(notices[0].content ?? "").includes("edited"));
  const rec = rig.events("readonly_state_diff");
  assert.equal(rec.length, 1);
  assert.equal(rec[0].outcome, "changed");
});

test("an unchanged checkout gives a trace record and no notice; a builder launch gives neither", async (t) => {
  const { rig, sent } = await setup(t);
  const a = { agent: "reviewer", task: "look" };
  const l1 = await rig.launch(a);
  await rig.started(l1.id, a, "run-ro-2");
  rig.end({ runId: "run-ro-2", agent: "reviewer", success: true });
  await wait(() => rig.events("readonly_state_diff").length > 0);
  assert.equal(rig.events("readonly_state_diff")[0].outcome, "unchanged");
  const b = { agent: "builder", task: "build" };
  const l2 = await rig.launch(b);
  await rig.started(l2.id, b, "run-ro-3");
  rig.end({ runId: "run-ro-3", agent: "builder", success: true });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(rig.events("readonly_state_diff").length, 1);
  assert.equal(sent.filter((m) => m.customType === "pi-foreman-readonly-state").length, 0);
});
