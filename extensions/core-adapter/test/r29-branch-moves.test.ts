// r29: the foreman's branch-only git on a clean tree (branchMove) and the guard shapes it relies on.
// Temp repositories with a bare origin; nothing outside them is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import { branchMove, runShellWriteGuard, shellWriteGuardPayload, shellWriteVerdict } from "../shellwriteguard.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });

/** A work clone with one commit on main pushed to a bare origin. `g` runs git in the work tree. */
function fixture() {
  const base = mkTestTmp("pf-r29-branch-");
  const origin = path.join(base, "origin.git");
  const work = path.join(base, "work");
  const g = (...a: string[]) => execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { encoding: "utf8" }).trim();
  // the harness sets url.invalid-push:.pushInsteadOf for every URL; the fixture's own origin keeps its path
  const pushOrigin = (...a: string[]) => g("-c", `url.${origin}.pushInsteadOf=${origin}`, "push", ...a);
  execFileSync("git", ["init", "-q", "--bare", origin]);
  fs.mkdirSync(work);
  execFileSync("git", ["init", "-q", work]);
  g("checkout", "-q", "-b", "main");
  fs.writeFileSync(path.join(work, "README.md"), "one\n");
  g("add", "README.md");
  g("commit", "-q", "-m", "chore: one");
  g("remote", "add", "origin", origin);
  pushOrigin("-q", "-u", "origin", "main");
  return { base, work, g, pushOrigin };
}

test("clean switch and checkout of an existing local branch are allowed", async () => {
  const f = fixture();
  try {
    f.g("branch", "round/29-x");
    assert.deepEqual(await branchMove("git switch round/29-x", f.work, true), { allow: true });
    assert.deepEqual(await branchMove("git checkout round/29-x", f.work, true), { allow: true });
    assert.deepEqual(await branchMove("git switch main", f.work, true), { allow: true });
  } finally {
    rmTestTmp(f.base);
  }
});

test("a switch on a dirty tree is refused and names the precondition", async () => {
  const f = fixture();
  try {
    f.g("branch", "round/29-x");
    fs.appendFileSync(path.join(f.work, "README.md"), "two\n");
    assert.deepEqual(await branchMove("git switch round/29-x", f.work, true), { allow: false, precondition: "working tree not clean" });
    // an untracked file does not count (only tracked changes, as foreman_worktree_remove's clean check reads them)
    f.g("checkout", "--", "README.md");
    fs.writeFileSync(path.join(f.work, "scratch.txt"), "x\n");
    assert.deepEqual(await branchMove("git switch round/29-x", f.work, true), { allow: true });
  } finally {
    rmTestTmp(f.base);
  }
});

test("a switch to a name that is not a local branch is refused", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await branchMove("git switch nope", f.work, true), { allow: false, precondition: "no local branch nope" });
  } finally {
    rmTestTmp(f.base);
  }
});

test("path checkouts, forced switches and chains are not branch moves (null: the refusal stands)", async () => {
  const f = fixture();
  try {
    f.g("branch", "round/29-x");
    // a bare name with no such branch is a path checkout in git's eyes: refused as a missing branch
    assert.deepEqual(await branchMove("git checkout README.md", f.work, true), { allow: false, precondition: "no local branch README.md" });
    for (const c of [
      "git checkout -- README.md",
      "git checkout HEAD -- README.md",
      "git switch -f round/29-x",
      "git switch --force round/29-x",
      "git checkout --discard-changes round/29-x",
      "git switch round/29-x && rm -rf src",
      "git switch round/29-x; echo x",
      "git switch 'round/29-x'",
      "git switch round/29-x\nrm -rf src",
      "git switch -c round/29-y",
      "git reset --hard",
      "git reset --hard HEAD~1",
      "git reset --hard -- README.md",
      "git branch -f round/29-x main",
    ]) assert.equal(await branchMove(c, f.work, true), null, c);
  } finally {
    rmTestTmp(f.base);
  }
});

test("switch -C and reset --hard to origin/main: allowed when HEAD is pushed and the tree is clean, refused otherwise", async () => {
  const f = fixture();
  try {
    f.g("fetch", "-q", "origin");
    // HEAD is origin/main: contained in the target
    assert.deepEqual(await branchMove("git reset --hard origin/main", f.work, true), { allow: true });
    assert.deepEqual(await branchMove("git switch -C round/29-x origin/main", f.work, true), { allow: true });
    // an unpushed commit that the target lacks: refused
    fs.writeFileSync(path.join(f.work, "README.md"), "two\n");
    f.g("commit", "-q", "-am", "chore: two");
    assert.deepEqual(await branchMove("git reset --hard origin/main", f.work, true), {
      allow: false,
      precondition: "HEAD is neither contained in origin/main nor in a pushed branch",
    });
    // the same commit pushed to a remote branch: contained in a pushed upstream
    f.pushOrigin("-q", "origin", "HEAD:refs/heads/round/29-x");
    f.g("fetch", "-q", "origin");
    assert.deepEqual(await branchMove("git reset --hard origin/main", f.work, true), { allow: true });
    // a dirty tree refuses even when HEAD is pushed
    fs.writeFileSync(path.join(f.work, "README.md"), "three\n");
    assert.deepEqual(await branchMove("git reset --hard origin/main", f.work, true), { allow: false, precondition: "working tree not clean" });
  } finally {
    rmTestTmp(f.base);
  }
});

test("a child session gets no branch move (null) even on a clean tree", async () => {
  const f = fixture();
  try {
    f.g("branch", "round/29-x");
    assert.equal(await branchMove("git switch round/29-x", f.work, false), null);
    assert.equal(await branchMove("git reset --hard origin/main", f.work, false), null);
  } finally {
    rmTestTmp(f.base);
  }
});

test("real script: the branch-move shapes are refused by the guard (so the adapter is reached), branch -f and fetch are not", { skip: !py.ok ? "no Python >= 3.9" : false }, async () => {
  const f = fixture();
  try {
    const python = py.ok ? py.info.executable : null;
    const verdict = async (command: string) =>
      shellWriteVerdict(await runShellWriteGuard({ python, pkgRoot: repo, payload: shellWriteGuardPayload({ command }, { sessionId: "s1", cwd: f.work, home: "/" }, f.work), env: { ...process.env } as Record<string, string>, cwd: f.work, spawner: defaultSpawner }), python);
    for (const c of ["git switch round/29-x", "git checkout round/29-x", "git switch -C round/29-x origin/main", "git reset --hard origin/main", "git checkout -- README.md"]) {
      assert.equal((await verdict(c)).decision, "refuse", c);
    }
    for (const c of ["git branch -f round/29-x main", "git fetch origin", "git branch"]) {
      assert.deepEqual(await verdict(c), { decision: "allow" }, c);
    }
  } finally {
    rmTestTmp(f.base);
  }
});
