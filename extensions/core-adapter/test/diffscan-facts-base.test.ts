// diffscan.ts: the facts file beyond 20 facts (D143) and the per-review base (D152).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { factsBlock, ReviewFacts, writeFactsFile } from "../diffscan.ts";
import { reviewBaseOf } from "../highstakes.ts";

const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "skip" as const, text: `skip marker added in f${i}_test.go: t.Skip()` }));

test("43 facts: 20 inline, a file with all 43, its path in the text; 20 or fewer: no file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "facts-file-"));
  try {
    const facts = mk(43);
    const file = writeFactsFile(dir, facts);
    assert.ok(file && file.startsWith(path.join(dir, ".workflow", "facts", "facts-")));
    assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 43);
    const block = factsBlock(facts, "abcdef0123456789", file);
    assert.match(block, /Rule on every one/);
    assert.ok(block.includes(`(+23 more not shown; all 43 in ${file})`));
    assert.equal(block.split("\n").filter((l) => /^\d+\. /.test(l)).length, 20);
    const small = fs.mkdtempSync(path.join(os.tmpdir(), "facts-small-"));
    assert.equal(writeFactsFile(small, mk(20)), null);
    assert.equal(fs.existsSync(path.join(small, ".workflow")), false);
    fs.rmSync(small, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writing a facts file prunes older ones to the newest 20", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "facts-prune-"));
  try {
    const fd = path.join(dir, ".workflow", "facts");
    fs.mkdirSync(fd, { recursive: true });
    for (let i = 0; i < 25; i++) {
      const f = path.join(fd, `facts-old${String(i).padStart(2, "0")}.md`);
      fs.writeFileSync(f, "x");
      fs.utimesSync(f, 1000 + i, 1000 + i);
    }
    const file = writeFactsFile(dir, mk(30));
    const left = fs.readdirSync(fd);
    assert.equal(left.length, 20);
    assert.ok(left.includes(path.basename(file as string)));
    assert.ok(!left.includes("facts-old00.md") && left.includes("facts-old24.md"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- D152
const g = (cwd: string, ...a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8" }).trim();
const commit = (cwd: string, file: string, text: string): string => {
  fs.writeFileSync(path.join(cwd, file), text);
  g(cwd, "add", file);
  g(cwd, "commit", "-q", "-m", file);
  return g(cwd, "rev-parse", "HEAD");
};
/** A repo on main with `origin/main` as remote-tracking ref (no network). */
function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "facts-base-"));
  g(dir, "init", "-q", "-b", "main");
  commit(dir, "a.txt", "a\n");
  return dir;
}
const track = (dir: string): void => {
  g(dir, "update-ref", "refs/remotes/origin/main", g(dir, "rev-parse", "main"));
  g(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
};
test("squash case: a branch cut from the squashed main in the same dir reads against the merge-base", async () => {
  const dir = repo();
  try {
    g(dir, "checkout", "-q", "-b", "x");
    const h1 = commit(dir, "x1.go", "package x\n");
    const rf = new ReviewFacts();
    rf.mergeBase = (d) => reviewBaseOf(d, { baseBranch: null });
    await rf.noteBuilders({ agent: "builder" }, dir); // recorded: h1
    // main squash-merges X (h1 itself is not an ancestor of main) and adds a main-only file
    g(dir, "checkout", "-q", "main");
    commit(dir, "x1.go", "package x\n");
    const mainOnly = commit(dir, "mainonly.go", "package m\n");
    track(dir);
    g(dir, "checkout", "-q", "-b", "y", "main");
    commit(dir, "y.go", "package y\n");
    assert.notEqual(await rf.baseFor(dir), h1);
    assert.equal(await rf.baseFor(dir), g(dir, "merge-base", "HEAD", "origin/main"));
    assert.equal(g(dir, "merge-base", "HEAD", "origin/main"), mainOnly);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("merge case: X merged into main with a merge commit, a new branch from main moves the base to the merge-base", async () => {
  const dir = repo();
  try {
    g(dir, "checkout", "-q", "-b", "x");
    const h1 = commit(dir, "x1.go", "package x\n");
    const rf = new ReviewFacts();
    rf.mergeBase = (d) => reviewBaseOf(d, { baseBranch: null });
    await rf.noteBuilders({ agent: "builder" }, dir); // recorded: h1
    g(dir, "checkout", "-q", "main");
    commit(dir, "mainonly.go", "package m\n");
    g(dir, "merge", "-q", "--no-ff", "--no-edit", "x");
    commit(dir, "mainonly2.go", "package m2\n");
    track(dir);
    g(dir, "checkout", "-q", "-b", "y", "main");
    commit(dir, "y.go", "package y\n");
    g(dir, "merge-base", "--is-ancestor", h1, "HEAD"); // h1 stays an ancestor of HEAD
    const mb = g(dir, "merge-base", "HEAD", "origin/main");
    assert.notEqual(mb, h1);
    assert.equal(await rf.baseFor(dir), mb);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("normal in-round case: the recorded base stays (also with no resolvable base branch)", async () => {
  const dir = repo();
  try {
    g(dir, "checkout", "-q", "-b", "x");
    const rf = new ReviewFacts();
    rf.mergeBase = (d) => reviewBaseOf(d, { baseBranch: null });
    await rf.noteBuilders({ agent: "builder" }, dir);
    const rec = g(dir, "rev-parse", "HEAD");
    commit(dir, "x1.go", "package x\n");
    assert.equal(await rf.baseFor(dir), rec); // no origin/HEAD: nothing resolves
    track(dir);
    commit(dir, "x2.go", "package x2\n");
    assert.equal(await rf.baseFor(dir), rec); // recorded is main's tip = the merge-base
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
