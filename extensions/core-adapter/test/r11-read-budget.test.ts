// R11 item 5 (P2): finalization (a reviewer PASS, no child run active) is exempt from
// read_budget_exceeded and a plain git commit is not refused; a ruling line never changes the read budget, but a
// parent-written ruling-<n>.md or brief-<x>.md resets it (R18 item 1, r18-caps-reset.test.ts); with a launch pending
// the budget still refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { DEFAULT_READ_LIMITS, finalizationCommand, ReadBudget } from "../budget.ts";
import { r11Rig, reviewAllowOpts, writeAt, type Block } from "./_r11rig.ts";

const WARN = DEFAULT_READ_LIMITS.before.warn; // 8, the same for both phases
const readDenied = (r: { block?: boolean; reason?: string } | undefined): boolean => r?.block === true && /\[read_budget_exceeded\]/.test(r.reason ?? "");
const reviewerLaunch = () => ({ agent: "reviewer", task: "review the diff" }); // fresh: a launch rewrites its task
const explorer = { agent: "explorer", task: "look around" };

type Rig = Awaited<ReturnType<typeof r11Rig>>;
/** `n` plain reads; returns the results. */
async function reads(a: Rig, n: number): Promise<({ block?: boolean; reason?: string } | undefined)[]> {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await a.call("bash", { command: `ls -la src${i}` }));
  return out;
}

/** A reviewer launch that started and passed: finalization begins. */
async function finalize(a: Rig, runId: string): Promise<void> {
  const review = reviewerLaunch();
  const l = await a.launch(review);
  assert.equal(l.res, undefined);
  await a.started(l.id, review, runId);
  a.end({ runId, agent: "reviewer", status: "completed", success: true, summary: "VERDICT: PASS" });
  await a.notice("Background task completed: **reviewer**\nOverall verdict: PASS");
}

test("read_budget_finalization_git_commit_allowed", async (t) => {
  const a = await r11Rig(t, {}, reviewAllowOpts());
  await finalize(a, "run-fin");
  const out = await reads(a, WARN + 4);
  assert.ok(!out.some(readDenied), "no read_budget_exceeded in finalization");
  assert.deepEqual(a.events("read_budget"), [], "finalization reads are exempt: no reminder either");
  for (const command of ["git status --short", "git add CHANGELOG.md docs/ceremony.md", "git log --oneline -3", 'git commit -m "fix(budget): finalization; reads exempt"']) {
    const r = await a.call("bash", { command });
    assert.equal(r, undefined, `${command}: ${r?.reason}`);
  }
  assert.deepEqual(a.events("read_budget").filter((r) => r.action === "deny"), []);
});

test("read_budget_finalization_git_commit_allowed: a reviewer PASS (post-PASS) exempts git commit from the recheck budget", () => {
  const b = new ReadBudget();
  const lim = DEFAULT_READ_LIMITS;
  b.onLaunch();
  assert.equal(b.finalized, false);
  b.enterPost();
  assert.equal(b.finalized, true);
  for (let i = 0; i < 3; i++) assert.equal(b.check("bash", `r${i}`, lim, 3, false).kind, "allow");
  assert.equal(b.check("bash", "r3", lim, 3, false).kind, "deny", "plain re-checks stay capped after the pass");
  // index.ts readBudgetCheck: finalized, no active run, and a finalization command -> exempt
  assert.equal(finalizationCommand("bash", { command: 'git add -A && git commit -m "x; y | z"' }), true);
  assert.equal(b.check("bash", "r4", lim, 3, finalizationCommand("bash", { command: "git commit -m done" })).kind, "allow");
  // not finalization commands
  for (const command of ["git commit -m \"$(cat /etc/passwd)\"", "git commit -m x; cat secret.txt", "git diff", "git -C ../other show HEAD", "cat x"]) {
    assert.equal(finalizationCommand("bash", { command }), false, command);
  }
  assert.equal(finalizationCommand("read", { path: "x" }), false);
  // a started launch, a FAIL/edit (resetPost) or a user prompt ends finalization
  b.onLaunch();
  assert.equal(b.finalized, false);
  b.enterPost();
  b.resetPost();
  assert.equal(b.finalized, false);
  b.enterPost();
  b.resetAll();
  assert.equal(b.finalized, false);
});

const reminds = (a: Rig): number => a.events("read_budget").filter((r) => r.action === "remind").length;

test("ruling_read_budget_line_has_no_effect_but_ruling_file_resets", async (t) => {
  const a = await r11Rig(t, {}, reviewAllowOpts());
  const dir = a.handoff("round", "child");
  const now = Date.now();
  writeAt(path.join(dir, "ask.md"), "ask: more reads?\n", now - 60_000);
  const out = await reads(a, WARN + 1);
  assert.ok(!out.some(readDenied), "a read is never denied");
  assert.equal(reminds(a), 1);
  // a parent-written ruling.md with the line, newer than the ask: nothing changes (no text parser, ruling.md is no reset file)
  writeAt(path.join(dir, "ruling.md"), "APPROVED\nread-budget: +3\n", now - 1000);
  assert.ok(!(await reads(a, 2)).some(readDenied));
  assert.equal(reminds(a), 1, "the ruling line changes nothing");
  // a parent-written ruling-2.md resets the read budget: the count restarts, so WARN - 1 further reads raise no reminder
  writeAt(path.join(dir, "ruling-2.md"), "go on\n", Date.now());
  await a.turnStart(); // the reads above were tool_calls only: none is in flight on the next turn
  await reads(a, WARN - 1);
  assert.equal(reminds(a), 1, "a parent ruling-<n>.md resets the read count");
  assert.equal(a.events("cap_reset").length, 1);
});

test("read_budget_still_reminds_with_launch_pending", async (t) => {
  const a = await r11Rig(t, {}, reviewAllowOpts());
  // an explorer run still active while the reviewer passes: no finalization exemption
  const review = reviewerLaunch();
  const l = await a.launch(review);
  assert.equal(l.res, undefined);
  await a.started(l.id, review, "run-fin");
  const e = await a.launch(explorer);
  assert.equal(e.res, undefined);
  await a.started(e.id, explorer, "run-exp");
  a.end({ runId: "run-fin", agent: "reviewer", status: "completed", success: true, summary: "VERDICT: PASS" });
  await a.notice("Background task completed: **reviewer**\nOverall verdict: PASS");
  const out = await reads(a, WARN + 1);
  assert.ok(!out.some(readDenied), "never denied");
  const recheckDenied = (r: Block): boolean => r?.block === true && /\[recheck_budget_exceeded\]/.test(r.reason ?? "");
  assert.ok(out.some(recheckDenied), "the spent recheck budget applies with a run active");
  assert.ok(recheckDenied(await a.call("bash", { command: "git commit -m done" })), "no finalization exemption while the explorer runs");
  // the explorer ends: finalization holds now; a later started launch ends it again
  a.end({ runId: "run-exp", agent: "explorer", status: "completed", success: true, summary: "done" });
  assert.ok(!recheckDenied(await a.call("bash", { command: "git commit -m done" })), "finalization once nothing is pending");
  const b = await a.launch({ agent: "builder", task: "touch up" });
  await a.started(b.id, { agent: "builder", task: "touch up" }, "run-b");
  await reads(a, WARN);
  assert.equal(reminds(a), 1, "a started launch ends finalization: reads count again");
});
