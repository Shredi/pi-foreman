// A review keeps its head when HEAD moved only by a commit whose tree id is exactly the working-tree snapshot taken at the
// reviewer's launch (reviews.ts reviewedHeadVia); any other move, and any failed snapshot or comparison, stays head_moved.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { worktreeTree } from "../commentonly.ts";
import { headOf, headsAt, reviewedHeadVia, reviewedHeadWhy, treesAt } from "../reviews.ts";
import { rmTestTmp } from "./_tmpbase.ts";

interface Rig {
  dir: string;
  git: (...a: string[]) => string;
  write: (rel: string, text: string) => void;
}

function rig(): Rig {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-tree-")));
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.autocrlf=false", ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write("a.txt", "a\n");
  write("b.txt", "b\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return { dir, git, write };
}

/** Launch state: heads and snapshots, taken before the work of the same message is committed. */
async function launch(r: Rig): Promise<{ start: Map<string, string | null>; trees: Map<string, string | null> }> {
  return { start: await headsAt([r.dir]), trees: await treesAt([r.dir], worktreeTree) };
}

test("same-content commit after the launch snapshot keeps the head, via same_tree", async () => {
  const r = rig();
  try {
    r.write("a.txt", "a2\n");
    r.write("new.txt", "n\n");
    const { start, trees } = await launch(r);
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "work");
    const end = await headOf(r.dir);
    assert.equal(reviewedHeadWhy(start, r.dir, end).why, "head_moved");
    assert.deepEqual(await reviewedHeadVia(start, trees, r.dir, end), { head: end, via: "same_tree" });
  } finally {
    rmTestTmp(r.dir);
  }
});

test("an unmoved head keeps its head without via", async () => {
  const r = rig();
  try {
    const { start, trees } = await launch(r);
    const end = await headOf(r.dir);
    assert.deepEqual(await reviewedHeadVia(start, trees, r.dir, end), { head: end });
  } finally {
    rmTestTmp(r.dir);
  }
});

test("a commit that leaves one worktree file out stays head_moved", async () => {
  const r = rig();
  try {
    r.write("a.txt", "a2\n");
    r.write("b.txt", "b2\n");
    const { start, trees } = await launch(r);
    r.git("add", "a.txt");
    r.git("commit", "-q", "-m", "partial");
    const out = await reviewedHeadVia(start, trees, r.dir, await headOf(r.dir));
    assert.deepEqual(out, { head: null, why: "head_moved" });
  } finally {
    rmTestTmp(r.dir);
  }
});

test("a commit that adds a file not in the snapshot stays head_moved", async () => {
  const r = rig();
  try {
    r.write("a.txt", "a2\n");
    const { start, trees } = await launch(r);
    r.write("extra.txt", "x\n");
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "more");
    const out = await reviewedHeadVia(start, trees, r.dir, await headOf(r.dir));
    assert.deepEqual(out, { head: null, why: "head_moved" });
  } finally {
    rmTestTmp(r.dir);
  }
});

test("a commit that changes a mode bit stays head_moved", { skip: process.platform === "win32" ? "mode bits are not tracked the same way on Windows" : false }, async () => {
  const r = rig();
  try {
    r.write("a.txt", "a2\n");
    const { start, trees } = await launch(r);
    r.git("add", "-A");
    r.git("update-index", "--chmod=+x", "b.txt");
    r.git("commit", "-q", "-m", "mode");
    const out = await reviewedHeadVia(start, trees, r.dir, await headOf(r.dir));
    assert.deepEqual(out, { head: null, why: "head_moved" });
  } finally {
    rmTestTmp(r.dir);
  }
});

test("a snapshot that could not be taken or compared stays head_moved, never an accept", async () => {
  const r = rig();
  try {
    r.write("a.txt", "a2\n");
    const { start, trees } = await launch(r);
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "work");
    const end = await headOf(r.dir);
    const moved = { head: null, why: "head_moved" };
    assert.deepEqual(await reviewedHeadVia(start, undefined, r.dir, end), moved, "no snapshots stored");
    assert.deepEqual(await reviewedHeadVia(start, new Map([[r.dir, null]]), r.dir, end), moved, "snapshot failed at launch");
    assert.deepEqual(await reviewedHeadVia(start, new Map(), r.dir, end), moved, "no snapshot for the directory");
    assert.deepEqual(await reviewedHeadVia(start, trees, r.dir, end, async () => null), moved, "end tree unreadable");
    assert.deepEqual(await reviewedHeadVia(start, trees, r.dir, end, async () => { throw new Error("boom"); }), moved, "comparison threw");
    assert.deepEqual(await reviewedHeadVia(start, trees, r.dir, end, async () => "0".repeat(40)), moved, "different tree");
    const none = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-tree-none-")));
    try {
      assert.deepEqual(await treesAt([none], worktreeTree), new Map([[none, null]]), "no repository: no snapshot");
      assert.deepEqual(await treesAt([none], async () => { throw new Error("boom"); }), new Map([[none, null]]));
    } finally {
      rmTestTmp(none);
    }
  } finally {
    rmTestTmp(r.dir);
  }
});

test("the other reasons are unchanged: no_launch_head, cwd_unmatched, head_unread", async () => {
  const r = rig();
  try {
    const { start, trees } = await launch(r);
    const h = await headOf(r.dir);
    assert.equal((await reviewedHeadVia(undefined, trees, r.dir, h)).why, "no_launch_head");
    assert.equal((await reviewedHeadVia(new Map([[r.dir, null]]), trees, r.dir, h)).why, "no_launch_head");
    assert.equal((await reviewedHeadVia(start, trees, r.dir, null)).why, "head_unread");
    assert.equal((await reviewedHeadVia(new Map([[r.dir, h], [path.join(r.dir, "x"), h]]), trees, path.join(r.dir, "elsewhere"), h)).why, "cwd_unmatched");
  } finally {
    rmTestTmp(r.dir);
  }
});

test("a differently spelled cwd uses the single start entry only for the same checkout", async () => {
  const r = rig();
  const other = rig();
  try {
    r.write("a.txt", "a2\n");
    const { start, trees } = await launch(r);
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "work");
    const sub = path.join(r.dir, "sub");
    fs.mkdirSync(sub);
    const end = await headOf(r.dir);
    assert.deepEqual(await reviewedHeadVia(start, trees, sub, end), { head: end, via: "same_tree" }, "a subdirectory of the same checkout");
    // another repository whose commit has the same tree id as the snapshot: still not the run's checkout
    other.write("a.txt", "a2\n");
    other.git("add", "-A");
    other.git("commit", "-q", "-m", "work");
    const otherEnd = await headOf(other.dir);
    assert.deepEqual(await reviewedHeadVia(start, trees, other.dir, otherEnd, async () => trees.get(r.dir) ?? null), { head: null, why: "head_moved" });
  } finally {
    rmTestTmp(r.dir);
    rmTestTmp(other.dir);
  }
});

test("the snapshot leaves the index and working tree alone: git status is byte-identical", async () => {
  const r = rig();
  try {
    r.write("a.txt", "staged\n");
    r.git("add", "a.txt");
    r.write("b.txt", "unstaged\n");
    r.write("untracked.txt", "u\n");
    const status = () => r.git("status", "--porcelain=v1", "--untracked-files=all");
    const idx = fs.readFileSync(path.join(r.dir, ".git", "index"));
    const before = status();
    assert.deepEqual(before.split("\n").sort(), ["?? untracked.txt", "M  a.txt", " M b.txt"].sort());
    const tree = await worktreeTree(r.dir);
    assert.match(tree ?? "", /^[0-9a-f]{40,64}$/);
    assert.equal(status(), before);
    assert.ok(idx.equals(fs.readFileSync(path.join(r.dir, ".git", "index"))), "the real index file is untouched");
    assert.equal(fs.readFileSync(path.join(r.dir, "b.txt"), "utf8"), "unstaged\n");
  } finally {
    rmTestTmp(r.dir);
  }
});
