// Review defects of the defects-1127 gate round, third pass: the file-text mask keeps base's handling of secret-named values, URL passwords and key blocks;
// the cd form of the git write default is cut only for a read root that is none of the session's own places.
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

test("a secret-named value is masked whatever characters it holds ($, (, ), [)", () => {
  for (const [line, secret] of [
    ["password: S3cr$t!", "S3cr$t!"],
    ["password=pa$$w0rd", "pa$$w0rd"],
    ["DB_PASSWORD=S3cr$t!", "S3cr$t!"],
    ["password=abc[1]xyz", "abc[1]xyz"],
    ["password=(hunter2)", "hunter2"],
  ]) {
    const m = maskKeys(`${line}\n`);
    assert.ok(!m.includes(secret) && m.includes(R), `${line} -> ${m}`);
  }
});

test("a URL with an empty user hides its password", () => {
  const m = maskKeys("REDIS=redis://:hunter2@localhost:6379\n");
  assert.ok(!m.includes("hunter2") && m.includes("@localhost:6379"), m);
});

test("a private key on one line with \\n escapes (JSON) is hidden whole", () => {
  const m = maskKeys('{"k": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkq\\n-----END PRIVATE KEY-----\\n", "x": 1}\n');
  assert.ok(!m.includes("MIIEvQ") && m.includes('"x": 1'), m);
});

test("a BEGIN with no END keeps the later lines visible", () => {
  const m = maskKeys("-----BEGIN PRIVATE KEY-----\nrm -rf ~/Documents\n");
  assert.ok(m.includes("rm -rf ~/Documents") && m.startsWith(R), m);
});

test("Authorization with a substitution is shown whole; a plain bearer value is masked", () => {
  for (const l of ["Authorization: Bearer $(rm -rf ~)", "Authorization: Bearer ${TOKEN}", "Authorization: Bearer `rm -rf ~`"]) assert.equal(maskKeys(`${l}\n`), `${l}\n`, l);
  assert.equal(maskKeys("Authorization: Bearer abc123def\n"), `Authorization: Bearer ${R}\n`);
});

test("the mask stays linear on many unpaired BEGIN markers", () => {
  const t0 = Date.now();
  maskKeys("-----BEGIN PRIVATE KEY-----\n".repeat(35000));
  assert.ok(Date.now() - t0 < 2000);
});

const base = fs.realpathSync(mkTestTmp("pf-basemask-"));
const main = path.join(base, "main");
const rounds = path.join(base, "repo.worktrees");
const wtA = path.join(rounds, "a");
const wtB = path.join(rounds, "b");
const extra = path.join(base, "extra-read");
after(() => fs.rmSync(base, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]): void => void execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
fs.mkdirSync(main, { recursive: true });
fs.mkdirSync(extra, { recursive: true });
git(main, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(main, "a.txt"), "x\n");
git(main, "add", "a.txt");
git(main, "commit", "-q", "-m", "init");
git(main, "worktree", "add", "-q", "-b", "round/a", wtA);
git(main, "worktree", "add", "-q", "-b", "round/b", wtB);

// the round worktrees lie under an owned root and an additionalDirectories root, as in a real round
const roots = (): GateRoots => ({ worktree: wtA, scratch: [], tmp: [], scratchBase: path.join(base, "none"), owned: [rounds], readDirs: [rounds, extra], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: true });
const facts: GitFacts = sessionGitFacts(gitFacts, ownWorktreeCheck([wtA, wtB]));
const run = (line: string): GateResult => gateDecide("bash", { command: shPath(line) }, wtA, { env: (c) => baseFloorEnv(c), roots, facts });
const rule = (r: GateResult): string => (r && "allow" in r ? r.rule : "none");

test("cd into an own round worktree keeps the git defaults of base", () => {
  assert.match(rule(run(`cd ${wtB} && git push origin round/b`)), /default-git-push/);
  for (const l of ["git fetch origin", "git pull --ff-only", "git switch round/b", "git commit -m x"]) assert.match(rule(run(`cd ${wtB} && ${l}`)), /default-git-|default-read/, l);
});

test("cd into an additionalDirectories root outside the own places: no git write default", () => {
  assert.ok(!/default-git-(?!read)/.test(rule(run(`cd ${extra} && git commit -m x`))));
});
