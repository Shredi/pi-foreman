// R11 P2 fix round 1 (S2, m): a finalization command is a plain git commit/add/status/log; any background operator,
// redirection or process substitution refuses the exemption. A finalization started by a reviewer PASS
// ends on a project edit.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_READ_LIMITS, finalizationCommand } from "../budget.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

const WARN = DEFAULT_READ_LIMITS.before.warn;
const readDenied = (r: { block?: boolean; reason?: string } | undefined): boolean => r?.block === true && /\[read_budget_exceeded\]/.test(r.reason ?? "");
const fin = (command: string) => finalizationCommand("bash", { command });

test("finalization_command_background_ampersand_refused", () => {
  for (const c of ["git status & cat x", "git status&cat x", "git status &", "git log |& cat", "git add -A & git commit -m x", "git status && git log & cat y", "git status \\& cat x", "git commit -m \"it's\" & cat x"]) assert.equal(fin(c), false, c);
  // a quoted `&` is commit-message text
  assert.equal(fin('git commit -m "fix A & B"'), true);
  assert.equal(fin("git commit -m 'a & b' && git log -1"), true);
});

test("finalization_command_redirect_or_procsub_refused", () => {
  for (const c of ["git log > out.txt", "git log >> out.txt", "git status 2>&1", "git status &> log", "git log >&2", "git commit -F <(cat x)", "git log < in.txt", "git diff >(cat)", "git status >| f", 'git commit -m "$(cat secret)"', 'git commit -m "`id`"', "git commit -m 'unterminated"]) assert.equal(fin(c), false, c);
  assert.equal(fin('git commit -m "a > b < c"'), true, "quoted angle brackets are message text");
});

test("read_budget_reviewer_pass_phase_ends_on_edit", async (t) => {
  const a = await r11Rig(t, {}, reviewAllowOpts());
  const review = { agent: "reviewer", task: "review the diff" };
  const l = await a.launch(review);
  assert.equal(l.res, undefined);
  await a.started(l.id, review, "run-fin");
  a.end({ runId: "run-fin", agent: "reviewer", status: "completed", success: true, summary: "VERDICT: PASS" });
  await a.notice("Background task completed: **reviewer**\nOverall verdict: PASS");
  for (let i = 0; i < WARN + 2; i++) assert.ok(!readDenied(await a.call("bash", { command: `ls -la f${i}` })), "finalization: no read budget");
  assert.deepEqual(a.events("read_budget"), [], "finalization: no reminder");
  // a project edit ends the finalization
  const file = path.join(a.project, "src", "x.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "export const x = 1;\n");
  await a.wrote(file);
  for (let i = 0; i < WARN - 1; i++) assert.ok(!readDenied(await a.call("bash", { command: `ls -la g${i}` })));
  assert.deepEqual(a.events("read_budget"), [], "the window restarts from zero");
  await a.call("bash", { command: "ls -la g-last" });
  assert.equal(a.events("read_budget").filter((r) => r.action === "remind").length, 1, "the read budget applies again after the edit");
});
