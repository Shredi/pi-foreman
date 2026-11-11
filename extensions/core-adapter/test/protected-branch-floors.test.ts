// Protected-branch patterns at every consumer: the push floor, the opaque-text floor, the push default and the branch-delete default.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { lineFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";
import { gateDecide, type GateResult } from "../gate.ts";
import type { GitFacts } from "../defaults.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync.native(mkTestTmp("pf-protpat-"));
after(() => rmTestTmp(base));

const env = (protectedBranches: string[], cur = "feature/x"): FloorEnv => ({ cwd: "/w/repo", home: "/h/me", agentDir: "/h/me/.pi/agent", writeRoots: ["/w/repo", "/tmp"], protectedBranches, currentBranch: () => cur, remoteHead: () => "trunk" });
const rule = (line: string, e: FloorEnv): string | null => lineFloors(line, parseShell(line, { cwd: e.cwd }), e)?.rule ?? null;
const PAT = env(["release/*"]);

test("push floor: with release/* configured, a main-session git push origin release/1.0 hits the protected floor", () => {
  assert.equal(rule("git push origin release/1.0", PAT), "floor-git-push-protected");
  assert.equal(rule("git push origin refs/heads/release/1.0", PAT), "floor-git-push-protected");
  assert.equal(rule("git push origin release/1.0", env([])), null);
});

test("push floor: Main matches main, ignoring case", () => {
  assert.equal(rule("git push origin Main", env([])), "floor-git-push-protected");
  assert.equal(rule("git push origin MASTER", env([])), "floor-git-push-protected");
});

test("push floor: a prefix-only name is not matched (mainline; release with release/* configured)", () => {
  assert.equal(rule("git push origin mainline", PAT), null);
  assert.equal(rule("git push origin release", PAT), null);
  assert.equal(rule("git push origin releases", PAT), null);
});

test("push floor: main, master and the remote default still match when a pattern is configured", () => {
  for (const b of ["main", "master", "trunk"]) assert.equal(rule(`git push origin ${b}`, PAT), "floor-git-push-protected", b);
});

test("push floor: a pushed bare git push from a pattern-matched current branch is protected", () => {
  assert.equal(rule("git push", env(["release/*"], "release/1.0")), "floor-git-push-protected");
});

// a command word the parser cannot read, so only the opaque-text floor sees the push
const unreadable = (tail: string) => tail.replace(/^git/, "$(echo git)");

test("opaque text: an unreadable push line naming release/1.0 with release/* configured meets the text floor (added match)", () => {
  assert.equal(rule(unreadable("git push origin release/1.0"), PAT), "floor-git-push-protected");
  assert.equal(rule(unreadable("git push origin refs/heads/release/1.0"), PAT), "floor-git-push-protected");
  assert.equal(rule(unreadable("git push origin release/1.0"), env([])), null);
});

test("opaque text: main and MAIN still meet the text floor, and a wildcard entry still matches its own text as a whole word (kept matches)", () => {
  assert.equal(rule(unreadable("git push origin main"), PAT), "floor-git-push-protected");
  assert.equal(rule(unreadable("git push origin MAIN"), PAT), "floor-git-push-protected");
  assert.equal(rule(unreadable("git push origin release/*"), PAT), "floor-git-push-protected");
});

test("opaque text: a line naming only mainline does not meet the text floor", () => {
  assert.equal(rule(unreadable("git push origin mainline"), PAT), null);
  assert.equal(rule(unreadable("git push origin release"), PAT), null);
});

// ---- defaults, through gateDecide with no floor list so only the default decides

const roots = (): GateRoots => ({ worktree: base, scratch: [], tmp: [], scratchBase: path.join(base, "s"), owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: false });
const fenv = (platform: NodeJS.Platform): FloorEnv => ({ cwd: base, home: "/pf/home", agentDir: "/pf/agent", platform, protectedBranches: [], currentBranch: () => "release/1.0", remoteHead: () => "trunk", writeRoots: [base] });
const facts = (list: string[]): GitFacts => ({ currentBranch: () => "release/1.0", protectedBranches: () => list, pushConfigured: () => false, branchMerged: () => true });
const decide = (line: string, list: string[], platform: NodeJS.Platform = process.platform): string | null => {
  const r: GateResult = gateDecide("bash", { command: line }, base, { env: () => fenv(platform), roots: roots, facts: facts(list) });
  return r && "allow" in r ? r.rule : null;
};

test("push default: does not relax for a branch a protected pattern matches (and does for the same branch without the pattern)", () => {
  assert.equal(decide("git push -u origin release/1.0", ["main", "master"]), "default-git-push");
  assert.equal(decide("git push -u origin release/1.0", ["main", "master", "release/*"]), null);
  assert.equal(decide("git push -u origin release/1.0", ["main", "master", "RELEASE/*"]), null);
});

test("branch-delete default: does not relax for a branch a protected pattern matches (and does without the pattern)", () => {
  assert.equal(decide("git branch -d release/1.0", ["main", "master"]), "default-git-branch-merged");
  assert.equal(decide("git branch -d release/1.0", ["main", "master", "release/*"]), null);
});

test("branch-delete default: letter case folds on darwin and win32 only, also for a pattern", () => {
  const list = ["main", "master", "release/*"];
  for (const p of ["darwin", "win32"] as const) assert.equal(decide("git branch -d Release/1.0", list, p), null, p);
  assert.equal(decide("git branch -d Release/1.0", list, "linux"), "default-git-branch-merged");
  assert.equal(decide("git branch -d release/1.0", list, "linux"), null);
});
