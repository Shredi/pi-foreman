// R11 item 5 (P2): finalization (a reviewer PASS or a completed finalizer, no child run active) is exempt from
// read_budget_exceeded and a plain git commit is not refused; a parent ruling line `read-budget: +N` (attributed like
// item 4) lifts the read budget once per ruling file; with a launch pending the budget still refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { DEFAULT_READ_LIMITS, finalizationCommand, ReadBudget } from "../budget.ts";
import { r11Rig, writeAt } from "./_r11rig.ts";

const DENY = DEFAULT_READ_LIMITS.before.deny; // 8, the same for both phases
const readDenied = (r: { block?: boolean; reason?: string } | undefined): boolean => r?.block === true && /\[read_budget_exceeded\]/.test(r.reason ?? "");
const finalizer = { agent: "finalizer", task: "write the changelog and result" };
const explorer = { agent: "explorer", task: "look around" };

type Rig = Awaited<ReturnType<typeof r11Rig>>;
/** `n` plain reads; returns the results. */
async function reads(a: Rig, n: number): Promise<({ block?: boolean; reason?: string } | undefined)[]> {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await a.call("bash", { command: `ls -la src${i}` }));
  return out;
}

/** A finalizer launch that started and completed: finalization begins. */
async function finalize(a: Rig, runId: string): Promise<void> {
  const l = await a.launch(finalizer);
  assert.equal(l.res, undefined);
  await a.started(l.id, finalizer, runId);
  a.end({ runId, agent: "finalizer", status: "completed", success: true, summary: "done" });
}

test("read_budget_finalization_git_commit_allowed", async (t) => {
  const a = await r11Rig(t);
  await finalize(a, "run-fin");
  const out = await reads(a, DENY + 4);
  assert.ok(!out.some(readDenied), "no read_budget_exceeded in finalization");
  for (const command of ["git status --short", "git add CHANGELOG.md docs/ceremony.md", "git log --oneline -3", 'git commit -m "fix(budget): finalization; reads exempt"']) {
    const r = await a.call("bash", { command });
    assert.equal(r, undefined, `${command}: ${r?.reason}`);
  }
  assert.deepEqual(a.events("read_budget").filter((r) => r.action === "deny"), []);
});

test("read_budget_finalization_git_commit_allowed: a reviewer PASS (post-PASS) exempts git commit from the recheck budget", () => {
  const b = new ReadBudget();
  const lim = DEFAULT_READ_LIMITS;
  b.onLaunch(["reviewer"]);
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
  b.onLaunch(["builder"]);
  assert.equal(b.finalized, false);
  b.onFinalizer();
  b.resetPost();
  assert.equal(b.finalized, false);
  b.onFinalizer();
  b.resetAll();
  assert.equal(b.finalized, false);
});

test("read_budget_parent_ruling_lifts", async (t) => {
  const a = await r11Rig(t);
  const dir = a.handoff("round", "child");
  const now = Date.now();
  writeAt(path.join(dir, "ask.md"), "ask: more reads?\n", now - 60_000);
  const out = await reads(a, DENY + 1);
  assert.ok(out.slice(0, DENY).every((r) => !readDenied(r)));
  assert.ok(readDenied(out[DENY]), "denied past the limit");
  writeAt(path.join(dir, "ruling.md"), "APPROVED\nread-budget: +3\n", now - 1000);
  const more = await reads(a, 3);
  assert.ok(more.every((r) => !readDenied(r)), "the ruling lifts the deny by 3");
  assert.ok(readDenied(await a.call("bash", { command: "ls next" })), "the same ruling file lifts once");
  assert.deepEqual(a.events("read_budget").filter((r) => r.action === "lift").map((r) => [r.by, r.requested]), [["ruling", 3]]);
});

test("read_budget_self_or_child_written_ruling_ignored", async (t) => {
  const a = await r11Rig(t);
  const now = Date.now();
  const own = a.handoff("opened", "parent"); // this session's own child writes here
  writeAt(path.join(own, "ask.md"), "ask\n", now - 60_000);
  writeAt(path.join(own, "ruling.md"), "read-budget: +50\n", now - 1000);
  const mine = a.handoff("round", "child");
  writeAt(path.join(mine, "ask.md"), "ask\n", now - 60_000);
  writeAt(path.join(mine, "ruling.md"), "read-budget: +50\n", now - 500);
  await a.wrote(path.join(mine, "ruling.md")); // this session wrote it
  const out = await reads(a, DENY + 2);
  assert.ok(readDenied(out[DENY]) && readDenied(out[DENY + 1]), "neither a child-written nor a self-written ruling lifts");
  assert.deepEqual(a.events("read_budget").filter((r) => r.action === "lift"), []);
});

test("read_budget_still_refused_with_launch_pending", async (t) => {
  const a = await r11Rig(t);
  // an explorer run still active while the finalizer completes: no finalization exemption
  const e = await a.launch(explorer);
  await a.started(e.id, explorer, "run-exp");
  await finalize(a, "run-fin");
  const out = await reads(a, DENY + 1);
  assert.ok(readDenied(out[DENY]), "denied with a launch pending");
  // the explorer ends: finalization holds now; a later started launch ends it again
  a.end({ runId: "run-exp", agent: "explorer", status: "completed", success: true, summary: "done" });
  assert.ok(!readDenied(await a.call("bash", { command: "git commit -m done" })), "finalization once nothing is pending");
  const b = await a.launch({ agent: "builder", task: "touch up" });
  await a.started(b.id, { agent: "builder", task: "touch up" }, "run-b");
  const after = await reads(a, DENY + 1);
  assert.ok(readDenied(after[DENY]), "a started launch ends finalization");
});
