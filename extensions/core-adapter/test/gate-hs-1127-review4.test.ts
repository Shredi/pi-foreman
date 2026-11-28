// Fourth review of the defects-1127 gate round: the cd git default is cut for an additionalDirectories root also when it is listed in `owned` too (as index.ts does);
// the file-text mask reuses base's secret-name and command-login rules and hides base64 key data below an unpaired BEGIN.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { gateDecide, gitFacts, baseFloorEnv, type GateResult } from "../gate.ts";
import type { GitFacts } from "../defaults.ts";
import { maskKeys } from "../judgereads.ts";
import { ownWorktreeCheck, sessionGitFacts } from "../ownworktree.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { shPath } from "./_shpath.ts";

const R = "[redacted]";

test("secret-named values and command logins that base masked are masked; a bare key= stays visible", () => {
  for (const [line, secret] of [
    ["MYSQL_PWD=hunter2", "hunter2"],
    ["DB_PWD=hunter2", "hunter2"],
    ["SIGNING_KEY=8f3a9c1d5e7b2a4f", "8f3a9c1d5e7b2a4f"],
    ["ENCRYPTION_KEY=Zm9vYmFyYmF6", "Zm9vYmFyYmF6"],
    ["STRIPE_KEY=rk_live_abcdefgh12345678", "rk_live_abcdefgh12345678"],
    ["curl -u admin:hunter2 https://x", "hunter2"],
    ["wget --password hunter2 https://x", "hunter2"],
  ]) {
    const m = maskKeys(`${line}\n`);
    assert.ok(!m.includes(secret) && m.includes(R), `${line} -> ${m}`);
  }
  for (const l of ["sorted(rows, key=lambda r: r[0])", "sortKey=name", "author = Alice"]) assert.equal(maskKeys(`${l}\n`), `${l}\n`);
});

test("a BEGIN with no END hides the base64 lines below it up to the first other line; an rm line stays", () => {
  const b64 = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
  const m = maskKeys(`-----BEGIN PRIVATE KEY-----\n${b64}\n${b64}\nrm -rf ~/Documents\n${b64}\n`);
  assert.equal(m.split("\n").length, 6);
  assert.ok(!m.slice(0, m.indexOf("rm -rf")).includes("MIIEvQ") && m.includes("rm -rf ~/Documents"), m);
  assert.ok(m.endsWith(`${b64}\n`));
});

const base = fs.realpathSync(mkTestTmp("pf-review4-"));
const main = path.join(base, "main");
const rounds = path.join(base, "repo.worktrees");
const wtA = path.join(rounds, "a");
const wtB = path.join(rounds, "b");
const extra = path.join(base, "extra-read");
after(() => fs.rmSync(base, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]): void => void execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
fs.mkdirSync(main, { recursive: true });
fs.mkdirSync(path.join(extra, "repo"), { recursive: true });
git(main, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(main, "a.txt"), "x\n");
git(main, "add", "a.txt");
git(main, "commit", "-q", "-m", "init");
git(main, "worktree", "add", "-q", "-b", "round/a", wtA);
git(main, "worktree", "add", "-q", "-b", "round/b", wtB);

// as index.ts builds them: every additionalDirectories folder is in `owned` and in `readDirs`
const roots = (): GateRoots => ({ worktree: wtA, scratch: [], tmp: [], scratchBase: path.join(base, "none"), owned: [rounds, extra], readDirs: [rounds, extra], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: true });
const facts: GitFacts = sessionGitFacts(gitFacts, ownWorktreeCheck([wtA, wtB]));
const run = (line: string): GateResult => gateDecide("bash", { command: shPath(line) }, wtA, { env: (c) => baseFloorEnv(c), roots, facts });
const rule = (r: GateResult): string => (r && "allow" in r ? r.rule : "none");

test("cd into an additionalDirectories repo (in owned and readDirs): git commit, add and fetch get no default", () => {
  for (const l of ["git commit -m x", "git add a.txt", "git fetch origin"]) {
    assert.ok(!/default-git-(?!read)/.test(rule(run(`cd ${path.join(extra, "repo")} && ${l}`))), `${l}: ${rule(run(`cd ${path.join(extra, "repo")} && ${l}`))}`);
  }
});

test("cd into an own round worktree keeps the base defaults with the real-shaped roots", () => {
  assert.match(rule(run(`cd ${wtB} && git push origin round/b`)), /default-git-push/);
  for (const l of ["git fetch origin", "git commit -m x"]) assert.match(rule(run(`cd ${wtB} && ${l}`)), /default-git-/, l);
});
