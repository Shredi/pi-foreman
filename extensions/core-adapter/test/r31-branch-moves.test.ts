// r31: the foreman's branch moves after a `cd <dir> &&` prefix, after a squash or rebase merge, and the untracked-overwrite refusal.
// Temp repositories with a bare origin; gh is replaced by a fake on PATH or absent, never the real one.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { branchMove } from "../shellwriteguard.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const win = process.platform === "win32";
const gitBin = (process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, "git")).find((p) => fs.existsSync(p));
const tools = mkTestTmp("pf-r31-tools-");
const savedPath = process.env.PATH;

// no gh on PATH for the file, unless a test puts a fake one first
before(() => {
  if (!win && gitBin) fs.symlinkSync(fs.realpathSync(gitBin), path.join(tools, "git"));
  process.env.PATH = tools;
});
after(() => {
  process.env.PATH = savedPath;
  rmTestTmp(tools);
});

async function withPath<T>(dirs: string[], fn: () => Promise<T>): Promise<T> {
  process.env.PATH = dirs.join(path.delimiter);
  try {
    return await fn();
  } finally {
    process.env.PATH = tools;
  }
}

/** A work clone with one commit on main pushed to a bare origin (as r29-branch-moves). `g` runs git in the work tree. */
function fixture() {
  const base = mkTestTmp("pf-r31-branch-");
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

/** A fake `gh` in its own dir: prints `out` and exits with `code`. */
function fakeGh(base: string, n: string, out: string, code = 0): string {
  const dir = path.join(base, `gh-${n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "gh"), `#!/bin/sh\necho '${out}'\nexit ${code}\n`, { mode: 0o755 });
  return dir;
}

test("cd prefix: a switch and a reset from the session cwd are allowed", async () => {
  const f = fixture();
  try {
    f.g("branch", "round/31-x");
    assert.deepEqual(await branchMove(`cd ${f.work} && git switch round/31-x`, f.work, true), { allow: true });
    assert.deepEqual(await branchMove(`cd ${f.work} && git reset --hard origin/main`, f.work, true), { allow: true });
    assert.deepEqual(await branchMove(`cd ${f.work} && git switch -C round/31-y origin/main`, f.work, true), { allow: true });
  } finally {
    rmTestTmp(f.base);
  }
});

test("cd prefix: a relative dir that resolves to the cwd, or to its git toplevel from a subdir, is allowed", async () => {
  const f = fixture();
  try {
    f.g("branch", "round/31-x");
    fs.mkdirSync(path.join(f.work, "sub"));
    assert.deepEqual(await branchMove("cd . && git switch round/31-x", f.work, true), { allow: true });
    assert.deepEqual(await branchMove("cd ./ && git switch round/31-x", f.work, true), { allow: true });
    assert.deepEqual(await branchMove("cd .. && git switch round/31-x", path.join(f.work, "sub"), true), { allow: true });
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
      `cd ${f.work} && git switch round/31-x && echo done`,
      `cd ${f.work} && cd ${f.work} && git switch round/31-x`,
      `cd ${f.work} ; git switch round/31-x`,
      `cd ${f.work} && git reset --hard origin/main && echo`,
      `(git switch round/31-x)`,
      "git switch round/31-x; echo x",
      "git switch round/31-x | cat",
      "git switch round/31-x & echo",
      "GIT_DIR=x git switch round/31-x",
      `GIT_DIR=x cd ${f.work} && git switch round/31-x`,
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
      assert.equal(await branchMove(`cd ${f.work} && ${c}`, f.work, true), null, `cd ${c}`);
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

test("unmerged content is refused (no gh on PATH: no PR check)", async () => {
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
    assert.deepEqual(await branchMove(`cd ${f.work} && git switch -C round/31-m origin/main`, f.work, true), {
      allow: false,
      precondition: "HEAD is neither contained in origin/main nor in a pushed branch",
    });
  } finally {
    rmTestTmp(f.base);
  }
});

test("gh: a MERGED PR whose head is HEAD allows the move; other state, other head, detached HEAD, a failing gh refuse", { skip: win }, async () => {
  const f = fixture();
  try {
    f.g("checkout", "-q", "-b", "round/31-g");
    fs.writeFileSync(path.join(f.work, "g.txt"), "g\n");
    f.g("add", "g.txt");
    f.g("commit", "-q", "-m", "feat: g");
    const head = f.g("rev-parse", "HEAD");
    const refused = { allow: false, precondition: "HEAD is neither contained in origin/main nor in a pushed branch" };
    const merged = fakeGh(f.base, "merged", `{"state":"MERGED","headRefOid":"${head}"}`);
    await withPath([merged, tools], async () => assert.deepEqual(await branchMove("git reset --hard origin/main", f.work, true), { allow: true }));
    const open = fakeGh(f.base, "open", `{"state":"OPEN","headRefOid":"${head}"}`);
    await withPath([open, tools], async () => assert.deepEqual(await branchMove("git reset --hard origin/main", f.work, true), refused));
    const other = fakeGh(f.base, "other", `{"state":"MERGED","headRefOid":"0000000000000000000000000000000000000000"}`);
    await withPath([other, tools], async () => assert.deepEqual(await branchMove("git reset --hard origin/main", f.work, true), refused));
    const failing = fakeGh(f.base, "fail", "gh: no pull request", 1);
    await withPath([failing, tools], async () => assert.deepEqual(await branchMove("git reset --hard origin/main", f.work, true), refused));
    f.g("checkout", "-q", "--detach");
    await withPath([merged, tools], async () => assert.deepEqual(await branchMove("git reset --hard origin/main", f.work, true), refused));
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
