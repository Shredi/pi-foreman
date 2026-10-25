import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { ownedRoots } from "../owned.ts";
import { recheckExempt } from "../recheckexempt.ts";
import { ReadBudget, DEFAULT_READ_LIMITS } from "../budget.ts";

const cwd = path.resolve("/t/work/repo");
const owned = ownedRoots({ agentDir: path.resolve("/t/agent"), workspaceRoot: cwd, tmpRoot: path.resolve("/t/tmp") });
const ctx = { cwd, home: path.resolve("/t/home"), platform: process.platform, owned };
const bash = (command: string): boolean => recheckExempt("bash", { command }, ctx);

test("r41 recheckexempt: PR coordination tools and read-only gh/glab views are exempt", () => {
  for (const n of ["pr_status", "pr_checks", "pr_comments", "pr_watch"]) assert.equal(recheckExempt(n, {}, ctx), true, n);
  for (const c of ["gh pr view 12", "gh pr checks 12", "gh pr list --state open", "gh run view 99 --log-failed", "glab mr view 3", "glab ci status"]) assert.equal(bash(c), true, c);
  assert.equal(bash("gh pr merge 12"), false);
  assert.equal(bash("gh pr view 12 > /etc/out"), false);
  assert.equal(bash("gh pr view $(cat x)"), false);
});

test("r41 recheckexempt: default-branch fetch and pull --ff-only are exempt, force and non-ff are not", () => {
  for (const c of ["git fetch", "git fetch origin main", "git -C /t/work/repo fetch origin master", "git pull --ff-only", "git pull --ff-only origin main"]) assert.equal(bash(c), true, c);
  for (const c of ["git pull", "git pull --rebase origin main", "git pull --ff-only --force", "git pull --force origin main", "git fetch --force origin main", "git fetch origin feature", "git pull --ff-only origin feature", "git push origin main"]) assert.equal(bash(c), false, c);
});

test("r41 recheckexempt: read-only peer commands are exempt, their writing neighbours are not", () => {
  for (const c of ["herdr pane read 1-2", "herdr pane read w1:p2 --lines 80", "herdr agent list", "herdr pane list", "foreman session list", "bin/foreman session list", "foreman worktree sweep --dry-run"]) assert.equal(bash(c), true, c);
  for (const c of ["herdr agent prompt 1-2 hi", "herdr pane close 1-2", "herdr pane split 1-2", "foreman worktree sweep", "foreman session close x", "herdr pane read 1-2 > /etc/out.txt", "herdr pane list > out.txt", "foreman session list --out /etc/x"]) assert.equal(bash(c), false, c);
});

test("r41 recheckexempt: an exempt family counts zero after a PASS, a plain command still counts", () => {
  const b = new ReadBudget();
  b.enterPost();
  const run = (id: string, name: string, input: unknown) => b.check("bash", id, DEFAULT_READ_LIMITS, 1, recheckExempt(name, input, ctx));
  for (let i = 0; i < 5; i++) assert.equal(run(`e${i}`, "bash", { command: "gh pr view 1" }).kind, "allow");
  assert.equal(b.recheckCount, 0);
  assert.equal(run("c1", "bash", { command: "git diff" }).kind, "allow");
  assert.equal(b.recheckCount, 1);
  assert.equal(run("c2", "bash", { command: "git show" }).kind, "deny");
});
