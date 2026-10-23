// r31: the foreman's branch moves after a `cd <dir> &&` prefix, after a squash or rebase merge, and the untracked-overwrite refusal.
// Temp repositories with a bare origin; gh is an injected runner (absent unless a test replies), never the real one.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { branchMove, setGhRunnerForTest } from "../shellwriteguard.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { r11Rig } from "./_r11rig.ts";

const win = process.platform === "win32";

// a dir as a `cd` word: forward slashes, so a Windows path is a plain word (`D:/a/...`); a backslash path is refused
const cdWord = (dir: string) => dir.split(path.sep).join("/");

// gh reports absent (a failed call) unless a test injects a reply; PATH stays as it is, so git and python resolve
before(() => {
  setGhRunnerForTest(async () => ({ ok: false, out: "" }));
});
after(() => {
  setGhRunnerForTest(null);
});

/** A work clone with one commit on main pushed to a bare origin (as r29-branch-moves). `g` runs git in the work tree. */
function fixture() {
  // the long-name path: on Windows os.tmpdir() may hold an 8.3 short name (RUNNER~1), which a cd word cannot carry
  const base = fs.realpathSync.native(mkTestTmp("pf-r31-branch-"));
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

/** The next gh call answers `out`; `ok` false is a failing gh. The args must be the PR view of `round/31-g`. */
function ghReply(out: string, ok = true): void {
  setGhRunnerForTest(async (args) => {
    assert.deepEqual(args, ["pr", "view", "round/31-g", "--json", "state,headRefOid"]);
    return { ok, out };
  });
}

test("cd prefix: a switch and a reset from the session cwd are allowed", async () => {
  const f = fixture();
  try {
    f.g("branch", "round/31-x");
    assert.deepEqual(await branchMove(`cd ${cdWord(f.work)} && git switch round/31-x`, f.work, true), { allow: true });
    assert.deepEqual(await branchMove(`cd ${cdWord(f.work)} && git reset --hard origin/main`, f.work, true), { allow: true });
    assert.deepEqual(await branchMove(`cd ${cdWord(f.work)} && git switch -C round/31-y origin/main`, f.work, true), { allow: true });
  } finally {
    rmTestTmp(f.base);
  }
});

test("cd prefix: `.`/`./` allowed, `..` from a subdir refused", async () => {
  const f = fixture();
  try {
    f.g("branch", "round/31-x");
    fs.mkdirSync(path.join(f.work, "sub"));
    assert.deepEqual(await branchMove("cd . && git switch round/31-x", f.work, true), { allow: true });
    assert.deepEqual(await branchMove("cd ./ && git switch round/31-x", f.work, true), { allow: true });
    assert.equal(await branchMove("cd .. && git switch round/31-x", path.join(f.work, "sub"), true), null);
  } finally {
    rmTestTmp(f.base);
  }
});

test("cd prefix: a parent dir, a missing dir, or a symlink that resolves elsewhere is refused (null)", { skip: win }, async () => {
  const f = fixture();
  try {
    f.g("branch", "round/31-x");
    fs.mkdirSync(path.join(f.base, "elsewhere"));
    fs.symlinkSync(path.join(f.base, "elsewhere"), path.join(f.base, "link"));
    for (const c of ["cd .. && git switch round/31-x", `cd ${f.base} && git switch round/31-x`, "cd missing && git switch round/31-x", "cd ../link && git switch round/31-x", "cd -P && git switch round/31-x", "cd ~ && git switch round/31-x", "cd $HOME && git switch round/31-x"]) {
      assert.equal(await branchMove(c, f.work, true), null, c);
    }
  } finally {
    rmTestTmp(f.base);
  }
});

test("chains, env prefixes and git -C / -c are not branch moves (null)", async () => {
  const f = fixture();
  try {
    f.g("branch", "round/31-x");
    for (const c of [
      `cd ${cdWord(f.work)} && git switch round/31-x && echo done`,
      `cd ${cdWord(f.work)} && cd ${cdWord(f.work)} && git switch round/31-x`,
      `cd ${cdWord(f.work)} ; git switch round/31-x`,
      `cd ${cdWord(f.work)} && git reset --hard origin/main && echo`,
      `(git switch round/31-x)`,
      "git switch round/31-x; echo x",
      "git switch round/31-x | cat",
      "git switch round/31-x & echo",
      "GIT_DIR=x git switch round/31-x",
      `GIT_DIR=x cd ${cdWord(f.work)} && git switch round/31-x`,
      `git -C ${f.work} switch round/31-x`,
      `git -C ${f.work} reset --hard origin/main`,
      "git -c core.hooksPath=/x switch round/31-x",
    ]) {
      assert.equal(await branchMove(c, f.work, true), null, c);
    }
  } finally {
    rmTestTmp(f.base);
  }
});

test("force flags, merge/keep modes and path-shaped forms stay refused (null), with or without a cd prefix", async () => {
  const f = fixture();
  try {
    f.g("branch", "round/31-x");
    for (const c of [
      "git switch -f round/31-x",
      "git switch --force round/31-x",
      "git switch --discard-changes round/31-x",
      "git switch -C round/31-x --force origin/main",
      "git switch -C -f round/31-x origin/main",
      "git checkout -f round/31-x",
      "git checkout -- README.md",
      "git reset --hard --force origin/main",
      "git reset --hard --merge origin/main",
      "git reset --merge origin/main",
      "git reset --keep origin/main",
      "git reset --hard -- origin/main",
      "git reset --hard origin/main --",
      "git reset --hard -q origin/main",
      "git reset --hard -origin/main",
    ]) {
      assert.equal(await branchMove(c, f.work, true), null, c);
      assert.equal(await branchMove(`cd ${cdWord(f.work)} && ${c}`, f.work, true), null, `cd ${c}`);
    }
  } finally {
    rmTestTmp(f.base);
  }
});

test("squash-merged branch (remote branch deleted): reset --hard origin/main is allowed (merge-tree)", async () => {
  const f = fixture();
  try {
    f.g("checkout", "-q", "-b", "round/31-s");
    fs.writeFileSync(path.join(f.work, "feature.txt"), "feature\n");
    f.g("add", "feature.txt");
    f.g("commit", "-q", "-m", "feat: feature");
    f.pushOrigin("-q", "-u", "origin", "round/31-s");
    f.g("checkout", "-q", "main");
    f.g("merge", "-q", "--squash", "round/31-s");
    f.g("commit", "-q", "-m", "feat: feature (squash)");
    f.pushOrigin("-q", "origin", "main");
    f.pushOrigin("-q", "origin", "--delete", "round/31-s");
    f.g("fetch", "-q", "--prune", "origin");
    f.g("checkout", "-q", "round/31-s");
    assert.deepEqual(await branchMove("git reset --hard origin/main", f.work, true), { allow: true });
  } finally {
    rmTestTmp(f.base);
  }
});

test("rebase-merged branch: reset --hard origin/main is allowed when every commit has a patch-equal one in origin/main (cherry)", async () => {
  const f = fixture();
  try {
    f.g("checkout", "-q", "-b", "round/31-r");
    fs.writeFileSync(path.join(f.work, "README.md"), "two\n");
    f.g("commit", "-q", "-am", "chore: two");
    f.g("checkout", "-q", "main");
    f.g("cherry-pick", "round/31-r");
    // main changes the same line again, so merge-tree conflicts and only the patch-id match is left
    fs.writeFileSync(path.join(f.work, "README.md"), "three\n");
    f.g("commit", "-q", "-am", "chore: three");
    f.pushOrigin("-q", "origin", "main");
    f.g("fetch", "-q", "origin");
    f.g("checkout", "-q", "round/31-r");
    assert.deepEqual(await branchMove("git reset --hard origin/main", f.work, true), { allow: true });
  } finally {
    rmTestTmp(f.base);
  }
});

test("unmerged content is refused (gh absent: no PR check)", async () => {
  const f = fixture();
  try {
    f.g("checkout", "-q", "-b", "round/31-n");
    fs.writeFileSync(path.join(f.work, "n.txt"), "n\n");
    f.g("add", "n.txt");
    f.g("commit", "-q", "-m", "feat: n");
    assert.deepEqual(await branchMove("git reset --hard origin/main", f.work, true), {
      allow: false,
      precondition: "HEAD is neither contained in origin/main nor in a pushed branch",
    });
    assert.deepEqual(await branchMove(`cd ${cdWord(f.work)} && git switch -C round/31-m origin/main`, f.work, true), {
      allow: false,
      precondition: "HEAD is neither contained in origin/main nor in a pushed branch",
    });
  } finally {
    rmTestTmp(f.base);
  }
});

test("gh: a MERGED PR whose head is HEAD allows the move; other state, other head, detached HEAD, a failing gh refuse", async () => {
  const f = fixture();
  try {
    f.g("checkout", "-q", "-b", "round/31-g");
    fs.writeFileSync(path.join(f.work, "g.txt"), "g\n");
    f.g("add", "g.txt");
    f.g("commit", "-q", "-m", "feat: g");
    const head = f.g("rev-parse", "HEAD");
    const refused = { allow: false, precondition: "HEAD is neither contained in origin/main nor in a pushed branch" };
    const merged = `{"state":"MERGED","headRefOid":"${head}"}`;
    ghReply(merged);
    assert.deepEqual(await branchMove("git reset --hard origin/main", f.work, true), { allow: true });
    ghReply(`{"state":"OPEN","headRefOid":"${head}"}`);
    assert.deepEqual(await branchMove("git reset --hard origin/main", f.work, true), refused);
    ghReply(`{"state":"MERGED","headRefOid":"0000000000000000000000000000000000000000"}`);
    assert.deepEqual(await branchMove("git reset --hard origin/main", f.work, true), refused);
    ghReply("gh: no pull request", false);
    assert.deepEqual(await branchMove("git reset --hard origin/main", f.work, true), refused);
    f.g("checkout", "-q", "--detach");
    ghReply(merged);
    assert.deepEqual(await branchMove("git reset --hard origin/main", f.work, true), refused);
  } finally {
    rmTestTmp(f.base);
  }
});

test("untracked file that the ref adds refuses reset --hard; an untracked file the ref does not add does not", async () => {
  const f = fixture();
  try {
    f.g("branch", "round/31-u");
    fs.writeFileSync(path.join(f.work, "new.txt"), "from main\n");
    f.g("add", "new.txt");
    f.g("commit", "-q", "-m", "chore: new");
    f.pushOrigin("-q", "origin", "main");
    f.g("fetch", "-q", "origin");
    f.g("reset", "-q", "--hard", "HEAD~1");
    f.g("checkout", "-q", "round/31-u");
    fs.writeFileSync(path.join(f.work, "new.txt"), "local\n");
    assert.deepEqual(await branchMove("git reset --hard origin/main", f.work, true), { allow: false, precondition: "untracked or ignored file new.txt would be overwritten" });
    fs.rmSync(path.join(f.work, "new.txt"));
    fs.writeFileSync(path.join(f.work, "scratch.txt"), "x\n");
    assert.deepEqual(await branchMove("git reset --hard origin/main", f.work, true), { allow: true });
  } finally {
    rmTestTmp(f.base);
  }
});

test("ignored file that the ref adds refuses reset --hard (the exclude file counts)", async () => {
  const f = fixture();
  try {
    f.g("branch", "round/31-i");
    fs.writeFileSync(path.join(f.work, "ign.txt"), "from main\n");
    f.g("add", "ign.txt");
    f.g("commit", "-q", "-m", "chore: ign");
    f.pushOrigin("-q", "origin", "main");
    f.g("fetch", "-q", "origin");
    f.g("reset", "-q", "--hard", "HEAD~1");
    f.g("checkout", "-q", "round/31-i");
    fs.appendFileSync(path.join(f.work, ".git", "info", "exclude"), "ign.txt\n");
    fs.writeFileSync(path.join(f.work, "ign.txt"), "local\n");
    assert.deepEqual(await branchMove("git reset --hard origin/main", f.work, true), { allow: false, precondition: "untracked or ignored file ign.txt would be overwritten" });
  } finally {
    rmTestTmp(f.base);
  }
});

test("relative cd words other than '.' are refused (bash may use CDPATH or a logical $PWD); '.' and an absolute dir are allowed", async () => {
  const f = fixture();
  try {
    f.g("branch", "round/31-c");
    fs.mkdirSync(path.join(f.work, "sub"));
    for (const c of ["cd sub/.. && git switch main", "cd .. && git switch main", "cd sub && git switch main", "cd sub/../. && git switch main"]) {
      assert.equal(await branchMove(c, f.work, true), null, c);
    }
    assert.deepEqual(await branchMove("cd . && git switch round/31-c", f.work, true), { allow: true });
    assert.deepEqual(await branchMove(`cd ${cdWord(f.work)} && git switch round/31-c`, f.work, true), { allow: true });
  } finally {
    rmTestTmp(f.base);
  }
});

test("a path that ref adds under an untracked file (a non-directory ancestor) refuses reset --hard, and names it", async () => {
  const f = fixture();
  try {
    f.g("branch", "round/31-p");
    fs.mkdirSync(path.join(f.work, "d"));
    fs.writeFileSync(path.join(f.work, "d", "f"), "from main\n");
    f.g("add", "d/f");
    f.g("commit", "-q", "-m", "chore: d/f");
    f.pushOrigin("-q", "origin", "main");
    f.g("fetch", "-q", "origin");
    f.g("reset", "-q", "--hard", "HEAD~1");
    f.g("checkout", "-q", "round/31-p");
    fs.writeFileSync(path.join(f.work, "d"), "a file, not a directory\n");
    assert.deepEqual(await branchMove("git reset --hard origin/main", f.work, true), { allow: false, precondition: "d is not a directory, so d/f cannot be written" });
    fs.rmSync(path.join(f.work, "d"));
    fs.mkdirSync(path.join(f.work, "d"));
    assert.deepEqual(await branchMove("git reset --hard origin/main", f.work, true), { allow: true });
  } finally {
    rmTestTmp(f.base);
  }
});

test("plain switch|checkout to a branch that adds an ignored file refuses, and names it", async () => {
  const f = fixture();
  try {
    f.g("branch", "round/31-w");
    f.g("checkout", "-q", "round/31-w");
    fs.writeFileSync(path.join(f.work, "ign.txt"), "from w\n");
    f.g("add", "ign.txt");
    f.g("commit", "-q", "-m", "chore: ign");
    f.g("checkout", "-q", "main");
    fs.appendFileSync(path.join(f.work, ".git", "info", "exclude"), "ign.txt\n");
    fs.writeFileSync(path.join(f.work, "ign.txt"), "local\n");
    assert.deepEqual(await branchMove("git switch round/31-w", f.work, true), { allow: false, precondition: "untracked or ignored file ign.txt would be overwritten" });
    assert.deepEqual(await branchMove("git checkout round/31-w", f.work, true), { allow: false, precondition: "untracked or ignored file ign.txt would be overwritten" });
    fs.rmSync(path.join(f.work, "ign.txt"));
    assert.deepEqual(await branchMove("git switch round/31-w", f.work, true), { allow: true });
  } finally {
    rmTestTmp(f.base);
  }
});

test("a refused branch move traces shell_write_refused with its precondition", async (t) => {
  const a = await r11Rig(t);
  execFileSync("git", ["-C", a.project, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", a.project, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "chore: one"]);
  execFileSync("git", ["-C", a.project, "branch", "round/31-t"]);
  fs.writeFileSync(path.join(a.project, "README.md"), "dirty\n");
  execFileSync("git", ["-C", a.project, "add", "README.md"]);
  const block = await a.call("bash", { command: "git switch round/31-t" });
  assert.match(block?.reason ?? "", /branch move refused: working tree not clean/);
  assert.deepEqual(a.events("shell_write_refused").map((r) => r.precondition), ["working tree not clean"]);
});
