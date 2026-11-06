// Post-PASS exemptions of ceremony.recheckBudget (budget.ts afterPassExempt): the CI and merge steps of the reviewed head do
// not count; a merge of another sha and a plain read still do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { afterPassExempt, DEFAULT_READ_LIMITS, ReadBudget, readLimits } from "../budget.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

const PASS = "a".repeat(40);
const OTHER = "b".repeat(40);
const ctx = { passHeads: [PASS], head: PASS, branch: "feat/x" };
const ex = (command: string, c = ctx): boolean => afterPassExempt(command, c);

test("afterPassExempt: push of the PASS head, merge with the PASS sha, CI reads", () => {
  for (const c of [
    "git push",
    "git push -u origin feat/x",
    "git push origin HEAD",
    `gh pr merge 12 --squash --delete-branch --match-head-commit ${PASS}`,
    `gh pr merge 12 --match-head-commit=${PASS}`,
    "gh run view 123 --log-failed",
    "gh run list --branch main --limit 3",
    "gh run watch 5",
    "gh pr checks 12",
    "gh pr view 12 --json state",
    "gh api repos/o/r/actions/runs",
    "git fetch origin && git rev-parse HEAD",
    "cd /tmp/x && git push && gh pr checks 12",
  ]) assert.equal(ex(c), true, c);
});

test("afterPassExempt: another sha, a moved head, force, other refspec, writes and other programs still count", () => {
  for (const c of [
    `gh pr merge 12 --match-head-commit ${OTHER}`,
    "gh pr merge 12 --squash",
    `gh pr merge 12 --match-head-commit ${PASS.slice(0, 7)}`,
    "git push --force",
    "git push origin other:main",
    "git push origin HEAD:main",
    "gh api -X POST repos/o/r/issues",
    "gh api repos/o/r/issues -f title=x",
    "cat README.md",
    "git diff",
    "git push && rm -rf x",
    "gh run view 1 > out.txt",
    "",
  ]) assert.equal(ex(c), false, c);
  assert.equal(ex("git push", { ...ctx, head: OTHER }), false, "HEAD is not a PASS head");
  assert.equal(ex("git push", { ...ctx, head: null }), false);
  assert.equal(ex("git push", { ...ctx, passHeads: [] }), false);
});

test("ReadBudget: past recheckBudget an afterPass call is allowed, a plain read and a foreign merge are denied", () => {
  const b = new ReadBudget();
  const L = readLimits(DEFAULT_READ_LIMITS);
  b.enterPost();
  assert.equal(b.check("bash", "c1", L, 1, false, false, false).kind, "allow", "first read uses the budget");
  assert.equal(b.check("bash", "c2", L, 1, false, false, true).kind, "allow", "afterPass");
  assert.equal(b.check("pr_checks", "c3", L, 1, false, true, false).kind, "allow", "coordination");
  assert.equal(b.check("bash", "c4", L, 1, false, false, false).kind, "deny", "a plain read");
});

async function reviewPassed(t: Parameters<typeof r11Rig>[0], budget: number) {
  const a = await r11Rig(t, { recheckBudget: budget }, reviewAllowOpts());
  await a.notice("Background task completed: **reviewer**\nOverall verdict: PASS");
  return a;
}
const denied = (r: { block?: boolean; reason?: string } | undefined): boolean => r?.block === true && /\[recheck_budget_exceeded\]/.test(r.reason ?? "");

test("adapter: after a PASS, gh run view, gh pr checks and the pr_checks tool pass the spent budget; a plain read does not (a merge with another sha is covered by afterPassExempt above)", async (t) => {
  const a = await reviewPassed(t, 1);
  assert.equal(await a.toolDoing("bash", { command: "ls one" }, () => undefined), undefined, "uses the budget");
  assert.ok(denied(await a.toolDoing("bash", { command: "ls two" }, () => undefined)), "spent");
  for (const command of ["gh run view 123", "gh pr checks 12", "gh run list --branch main"]) assert.equal(await a.toolDoing("bash", { command }, () => undefined), undefined, command);
  assert.equal(await a.toolDoing("pr_checks", {}, () => undefined), undefined, "pr_checks");
  assert.ok(denied(await a.toolDoing("bash", { command: "cat notes.md" }, () => undefined)), "a plain read");
});
