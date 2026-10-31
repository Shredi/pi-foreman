// r79 item 3 (steering): the own-branch set of the push default spans the linked worktrees of the session's repo. A plain push of a branch that
// is checked out in another linked worktree is as routine as a push of the cwd branch; any other branch is not a default (it stays the
// dangerous class), and the protected branches never are. Real git, two linked worktrees.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { gateDecide, gitFacts, baseFloorEnv, type GateResult } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf79-pushwt-"));
const main = path.join(base, "main");
const wtA = path.join(base, "wt-a");
const wtB = path.join(base, "wt-b");
after(() => fs.rmSync(base, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]): void => void execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
fs.mkdirSync(main, { recursive: true });
git(main, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(main, "a.txt"), "x\n");
git(main, "add", "a.txt");
git(main, "commit", "-q", "-m", "init");
git(main, "branch", "feature/other");
git(main, "worktree", "add", "-q", "-b", "feature/a", wtA);
git(main, "worktree", "add", "-q", "-b", "feature/b", wtB);

const roots = (cwd: string): GateRoots => ({
  worktree: cwd, scratch: [], tmp: [], scratchBase: path.join(base, "none"), owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: true,
});
const push = (cwd: string, line: string): GateResult => gateDecide("bash", { command: line }, cwd, { env: (c) => baseFloorEnv(c), roots: () => roots(cwd), facts: gitFacts });
const rule = (r: GateResult): string | null => (r && "allow" in r ? r.rule : null);

test("from worktree A: pushing the cwd branch, HEAD, and the branch of worktree B are all routine", () => {
  assert.equal(rule(push(wtA, "git push -u origin feature/a")), "default-git-push");
  assert.equal(rule(push(wtA, "git push origin HEAD")), "default-git-push");
  assert.equal(rule(push(wtA, "git push origin feature/b")), "default-git-push");
});

test("from worktree A: a branch checked out nowhere, or only in the main checkout, is not a default; main is a floor deny", () => {
  assert.notEqual(rule(push(wtA, "git push origin feature/other")), "default-git-push");
  assert.notEqual(rule(push(wtA, "git push origin main")), "default-git-push");
  const res = push(wtA, "git push origin main");
  assert.ok(res && "block" in res, "main stays a floor deny");
});
