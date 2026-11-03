// Push guard: the branch checked out in the worktree the push runs in (cwd after `cd`, or `git -C <path>`) is own when that worktree is the session's
// checkout or one this session created. Real git, a session checkout on branch A and a second linked worktree on branch B outside the session roots.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { gateDecide, gitFacts, baseFloorEnv, type GateResult } from "../gate.ts";
import type { GitFacts } from "../defaults.ts";
import { ownWorktreeCheck, sessionGitFacts } from "../ownworktree.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf-pushwt2-"));
const main = path.join(base, "main");
const wtA = path.join(base, "repo.worktrees", "a");
const wtB = path.join(base, "repo.worktrees", "b");
after(() => fs.rmSync(base, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]): void => void execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
fs.mkdirSync(main, { recursive: true });
git(main, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(main, "a.txt"), "x\n");
git(main, "add", "a.txt");
git(main, "commit", "-q", "-m", "init");
git(main, "worktree", "add", "-q", "-b", "round/a", wtA);
git(main, "worktree", "add", "-q", "-b", "round/b", wtB);

const roots = (): GateRoots => ({
  worktree: wtA, scratch: [], tmp: [], scratchBase: path.join(base, "none"), owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: true,
});
/** The session facts: only the worktrees in `created` count as own (what index.ts does with the session manifest). */
const factsWith = (created: string[]): GitFacts => sessionGitFacts(gitFacts, ownWorktreeCheck([wtA, ...created]));
const run = (line: string, created: string[]): GateResult => gateDecide("bash", { command: line }, wtA, { env: (c) => baseFloorEnv(c), roots, facts: factsWith(created) });
const rule = (r: GateResult): string | null => (r && "allow" in r ? r.rule.replace(/^default-read\+/, "") : null); // `cd <wt> && git push` joins the cd's rule

test("cd into the own second worktree: plain push of its branch is routine", () => {
  assert.equal(rule(run(`cd ${wtB} && git push -u origin round/b`, [wtB])), "default-git-push");
  assert.equal(rule(run(`cd ${wtB} && git push origin round/b`, [wtB])), "default-git-push");
});

test("git -C the own second worktree: plain push of its branch is routine", () => {
  assert.equal(rule(run(`git -C ${wtB} push origin round/b`, [wtB])), "default-git-push");
  assert.equal(rule(run(`git -C ${wtB} push -u origin round/b`, [wtB])), "default-git-push");
});

test("a worktree this session did not create is not own", () => {
  assert.notEqual(rule(run(`cd ${wtB} && git push -u origin round/b`, [])), "default-git-push");
  assert.notEqual(rule(run(`git -C ${wtB} push origin round/b`, [])), "default-git-push");
});

test("a symlink inside the own worktree pointing at a foreign worktree is not own", (t) => {
  const lnk = path.join(wtA, "lnk");
  try {
    fs.symlinkSync(wtB, lnk, "dir");
  } catch {
    t.skip("symlinks cannot be created here");
    return;
  }
  try {
    assert.notEqual(rule(run(`cd ${lnk} && git push origin round/b`, [])), "default-git-push");
    assert.notEqual(rule(run(`git -C ${lnk} push origin round/b`, [])), "default-git-push");
  } finally {
    fs.rmSync(lnk, { force: true });
  }
});

test("force, HEAD:B, --delete and main stay refused from the own second worktree", () => {
  for (const line of [
    `cd ${wtB} && git push -f origin round/b`,
    `cd ${wtB} && git push --force-with-lease origin round/b`,
    `cd ${wtB} && git push origin +round/b`,
    `cd ${wtB} && git push origin HEAD:round/b`,
    `cd ${wtB} && git push --delete origin round/b`,
    `cd ${wtB} && git push origin main`,
    `git -C ${wtB} push -f origin round/b`,
    `git -C ${wtB} push origin HEAD:round/b`,
    `git -C ${wtB} push --delete origin round/b`,
    `git -C ${wtB} push origin main`,
    `git -C ${wtB} push --all origin`,
    `git -C ${wtB} push origin round/b --tags`,
  ]) assert.notEqual(rule(run(line, [wtB])), "default-git-push", line);
});

// -C is resolved once (shellast moves the segment's cwd); own = the worktree top level is an own root exactly
test("relative and subdir -C forms from the session checkout", () => {
  fs.mkdirSync(path.join(wtA, "sub"), { recursive: true });
  assert.equal(rule(run("git -C ../b push origin round/b", [wtB])), "default-git-push");
  assert.equal(rule(run("git -C sub push origin round/a", [])), "default-git-push");
  assert.equal(rule(run(`git -C ${wtA}/sub push origin round/a`, [])), "default-git-push");
  assert.equal(rule(run(`git -C ${wtB} push origin round/b`, [wtB])), "default-git-push");
  assert.equal(rule(run("cd sub && git push origin round/a", [])), "default-git-push");
});

test("a foreign worktree nested inside the session checkout is not own, in the cd and -C forms", () => {
  const nested = path.join(wtA, "nested");
  git(main, "worktree", "add", "-q", "-b", "round/n", nested);
  for (const line of [`cd ${nested} && git push origin round/n`, `git -C ${nested} push origin round/n`, "git -C nested push origin round/n", "cd nested && git push origin round/n"])
    assert.notEqual(rule(run(line, [])), "default-git-push", line);
  assert.equal(rule(run(`git -C ${nested} push origin round/n`, [nested])), "default-git-push");
});

test("a nonexistent path is not own", () => {
  const gone = path.join(base, "repo.worktrees", "gone");
  assert.ok(!ownWorktreeCheck([wtA, gone])(gone));
  assert.notEqual(rule(run(`git -C ${gone} push origin round/b`, [gone])), "default-git-push");
  assert.notEqual(rule(run(`cd ${gone} && git push origin round/b`, [gone])), "default-git-push");
});
