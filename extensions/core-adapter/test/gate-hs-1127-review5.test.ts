// Review 5: owned read roots (hub .workflow) cut git-write defaults; the file mask keeps `&&rm` visible, stays linear, and redactCommand keeps its signature.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { gateDecide, gitFacts, baseFloorEnv, type GateResult } from "../gate.ts";
import type { GitFacts } from "../defaults.ts";
import { maskKeys } from "../judgereads.ts";
import { redactCommand, redactFileTextLine } from "../trace.ts";
import { ownWorktreeCheck, sessionGitFacts } from "../ownworktree.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { shPath } from "./_shpath.ts";

const base = fs.realpathSync(mkTestTmp("pf-review5-"));
const main = path.join(base, "main");
const rounds = path.join(base, "repo.worktrees");
const wtA = path.join(rounds, "a");
const wtB = path.join(rounds, "b");
const hubWf = path.join(base, "hub", ".workflow");
const ownWf = path.join(wtA, ".workflow");
after(() => fs.rmSync(base, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]): void => void execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
fs.mkdirSync(main, { recursive: true });
fs.mkdirSync(hubWf, { recursive: true });
git(main, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(main, "a.txt"), "x\n");
git(main, "add", "a.txt");
git(main, "commit", "-q", "-m", "init");
git(main, "worktree", "add", "-q", "-b", "round/a", wtA);
git(main, "worktree", "add", "-q", "-b", "round/b", wtB);
fs.mkdirSync(ownWf, { recursive: true });
git(hubWf, "init", "-q", "-b", "main");

// as index.ts builds them: owned = write + read + extra; readOnlyRoots = owned.read + extra
const roots = (): GateRoots => ({ worktree: wtA, scratch: [], tmp: [], scratchBase: path.join(base, "none"), owned: [rounds, hubWf], readOnlyRoots: [hubWf], readDirs: [], install: [], roundFlow: [hubWf], handoffs: [], child: false, role: "foreman", tmpAccess: true });
const facts: GitFacts = sessionGitFacts(gitFacts, ownWorktreeCheck([wtA, wtB]));
const run = (line: string): GateResult => gateDecide("bash", { command: shPath(line) }, wtA, { env: (c) => baseFloorEnv(c), roots, facts });
const rule = (r: GateResult): string => (r && "allow" in r ? r.rule : "none");

test("cd into the hub .workflow (an owned read root): git writes get no default", () => {
  for (const l of ["git commit -m x", "git add a.txt", "git fetch origin", "git pull --ff-only", "git switch main"]) {
    assert.ok(!/default-git-(?!read)/.test(rule(run(`cd ${hubWf} && ${l}`))), `${l}: ${rule(run(`cd ${hubWf} && ${l}`))}`);
  }
});

test("own round worktree and its .workflow keep the git defaults", () => {
  assert.match(rule(run(`cd ${wtB} && git push origin round/b`)), /default-git-push/);
  for (const l of ["git fetch origin", "git commit -m x"]) assert.match(rule(run(`cd ${wtB} && ${l}`)), /default-git-/, l);
  assert.match(rule(run(`cd ${ownWf} && git commit -m x`)), /default-git-/);
});

test("an unquoted secret value ends at a shell operator", () => {
  assert.equal(maskKeys("secret=a&&rm -rf ~\n"), "secret=[redacted]&&rm -rf ~\n");
  assert.equal(maskKeys("password=x|sh\n"), "password=[redacted]|sh\n");
  assert.equal(maskKeys("token=y;curl z\n"), "token=[redacted];curl z\n");
});

test("redactCommand keeps one parameter; the file-text line rule is a separate function", () => {
  assert.equal(redactCommand.length, 1);
  assert.equal(redactFileTextLine("sortKey=name"), "sortKey=name");
  assert.ok(!redactFileTextLine("MYSQL_PWD=hunter2").includes("hunter2"));
});

test("unpaired BEGIN markers without newlines stay linear", () => {
  const marker = "-----BEGIN PRIVATE KEY-----";
  const shapes = (n: number): string[] => [`${marker}`.repeat(Math.floor((n * 19000) / (1 << 20))) + "\n" + "!".repeat(n >> 1), marker.repeat(Math.floor(n / marker.length))];
  const time = (s: string): number => {
    const t = process.hrtime.bigint();
    maskKeys(s);
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  for (let i = 0; i < 2; i++) {
    const small = time(shapes(1 << 19)[i]);
    const big = time(shapes(1 << 20)[i]);
    assert.ok(big < 3000, `shape ${i}: ${big} ms`);
    assert.ok(big < Math.max(small * 3.5, 200), `shape ${i}: doubling ${small} -> ${big} ms`);
  }
});
