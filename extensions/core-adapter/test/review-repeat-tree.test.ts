// One reviewer per revision: the tree signal ignores `.workflow/` (commentonly.ts treeChangedSince).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dupRefusalText } from "../bound.ts";
import { treeChangedSince, worktreeTree } from "../commentonly.ts";

function repo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-rtree-")));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  g("init", "-q");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  return dir;
}

async function snap(dir: string): Promise<string> {
  const t = await worktreeTree(dir);
  assert.ok(t);
  return t;
}

test("a .workflow/ write alone is no tree change", async () => {
  const dir = repo();
  try {
    const tree = await snap(dir);
    fs.mkdirSync(path.join(dir, ".workflow/scratch"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".workflow/LEDGER-x.md"), "note\n");
    fs.writeFileSync(path.join(dir, ".workflow/scratch/n.md"), "note\n");
    assert.equal(await treeChangedSince(dir, tree), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a new untracked file is a tree change", async () => {
  const dir = repo();
  try {
    const tree = await snap(dir);
    fs.mkdirSync(path.join(dir, "docs"));
    fs.writeFileSync(path.join(dir, "docs/new.md"), "hi\n");
    assert.equal(await treeChangedSince(dir, tree), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a tracked edit is a tree change", async () => {
  const dir = repo();
  try {
    const tree = await snap(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
    assert.equal(await treeChangedSince(dir, tree), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dupRefusalText without a PASS time omits the time", () => {
  const text = dupRefusalText();
  assert.match(text, /the last review passed and nothing changed since \(/);
  assert.doesNotMatch(text, /\d\d:\d\d:\d\d/);
});
