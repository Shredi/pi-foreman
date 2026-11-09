// worktreeroot.ts: the close.worktreeDir resolver (shared case table with tests/test_worktree_root.py), the root collision scan and the nested checkout rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mainCheckoutOf, nestedCheckout, resolveWorktreeRoot, rootCollision, rootTemplateGlobs } from "../worktreeroot.ts";
import { buildSubmoduleRig, gitIn } from "./_submodules.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const skip = process.platform === "win32" ? "POSIX path and symlink fixtures" : false;

interface Case { name: string; setting: string | null; main?: string; superproject?: string | null; expect: { spelled: string; custom: boolean; code?: string; requested?: string } }
const TABLE = JSON.parse(fs.readFileSync(new URL("../../../tests/fixtures/worktree-root-cases.json", import.meta.url), "utf8")) as { home: string; agentDir: string; tmpRoot: string; main: string; cases: Case[] };

const tmp = fs.realpathSync(mkTestTmp("pf-wtroot-"));
process.on("exit", () => rmTestTmp(tmp));
const sub = (s: string): string => s.replaceAll("{tmp}", tmp);

for (const c of TABLE.cases) {
  test(`resolver case table: ${c.name}`, { skip }, () => {
    const r = resolveWorktreeRoot(sub(c.main ?? TABLE.main), c.setting === null ? null : sub(c.setting), {
      home: sub(TABLE.home), agentDir: sub(TABLE.agentDir), tmpRoot: sub(TABLE.tmpRoot), pkgRoot: path.join(tmp, "pkg"),
      superproject: c.superproject == null ? null : sub(c.superproject),
    });
    assert.equal(r.spelled, sub(c.expect.spelled));
    assert.equal(r.custom, c.expect.custom);
    assert.equal(r.error?.code, c.expect.code);
    assert.equal(r.requested, c.expect.requested === undefined ? undefined : sub(c.expect.requested));
  });
}

test("resolver: the package root and the Pi install root are protected too", { skip }, () => {
  const o = { home: path.join(tmp, "home"), agentDir: path.join(tmp, "home", ".pi", "agent"), tmpRoot: path.join(tmp, "tmpdir"), pkgRoot: path.join(tmp, "roots", "pkg"), installRoot: path.join(tmp, "roots", "pi"), superproject: null };
  const main = path.join(tmp, "work", "proj");
  assert.equal(resolveWorktreeRoot(main, path.join(tmp, "roots", "<repo>"), o).error?.code, "root_blocks_protected");
  assert.equal(resolveWorktreeRoot(main, path.join(tmp, "roots2", "<repo>"), o).error, undefined);
});

test("resolver: a custom root closes to children through template globs, the default does not", { skip }, () => {
  const o = { home: path.join(tmp, "home"), agentDir: path.join(tmp, "home", ".pi", "agent"), tmpRoot: path.join(tmp, "tmpdir"), superproject: null };
  const main = path.join(tmp, "work", "proj");
  assert.deepEqual(rootTemplateGlobs(resolveWorktreeRoot(main, "../<repo>.worktrees", o)), []);
  assert.deepEqual(rootTemplateGlobs(resolveWorktreeRoot(main, path.join(tmp, "roots", "<repo>"), o)), [`${tmp}/roots/*/*`]);
});

test("resolver: a symlinked root keeps the spelled path and resolves the real one", { skip }, () => {
  const realRoots = path.join(tmp, "real-roots");
  const link = path.join(tmp, "link-roots");
  fs.mkdirSync(realRoots);
  fs.symlinkSync(realRoots, link);
  const r = resolveWorktreeRoot(path.join(tmp, "work", "proj"), path.join(link, "<repo>"), { home: path.join(tmp, "home"), agentDir: path.join(tmp, "home", ".pi", "agent"), tmpRoot: path.join(tmp, "tmpdir"), superproject: null });
  assert.equal(r.spelled, path.join(link, "proj"));
  assert.equal(r.real, path.join(realRoots, "proj"));
  assert.equal(r.custom, true);
  assert.deepEqual(rootTemplateGlobs(r).sort(), [`${link}/*/*`, `${realRoots}/*/*`].sort());
});

test("resolver: repo and root live in separate temp trees (a real repo)", { skip }, () => {
  const repo = path.join(tmp, "sep", "repo-one");
  fs.mkdirSync(repo, { recursive: true });
  gitIn(repo, "init", "-q", "-b", "main");
  const elsewhere = fs.realpathSync(mkTestTmp("pf-wtroot-out-"));
  try {
    const r = resolveWorktreeRoot(repo, path.join(elsewhere, "<repo>"));
    assert.equal(r.error, undefined);
    assert.equal(r.spelled, path.join(elsewhere, "repo-one"));
  } finally {
    rmTestTmp(elsewhere);
  }
});

// ---------------------------------------------------------------- root collision and main checkout

test("root collision: a worktree of another repo sitting in the root is found, the own one is not", { skip }, () => {
  const root = path.join(tmp, "shared");
  const a = path.join(tmp, "col", "a", "proj");
  const b = path.join(tmp, "col", "b", "proj");
  for (const r of [a, b]) {
    fs.mkdirSync(r, { recursive: true });
    gitIn(r, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(r, "f"), "x\n");
    gitIn(r, "add", "f");
    gitIn(r, "commit", "-q", "-m", "i");
  }
  fs.mkdirSync(path.join(root, "proj"), { recursive: true });
  gitIn(a, "worktree", "add", "-q", "-b", "r1", path.join(root, "proj", "r1"));
  assert.equal(rootCollision(a, path.join(root, "proj")), null);
  const hit = rootCollision(b, path.join(root, "proj"));
  assert.ok(hit);
  assert.equal(hit.other, a);
  assert.equal(rootCollision(b, path.join(tmp, "missing")), null);
});

test("main checkout: a linked worktree, a submodule and its linked worktree all name their own main checkout", { skip }, () => {
  const rig = buildSubmoduleRig(fs.realpathSync(mkTestTmp("pf-wtroot-sm-")));
  try {
    assert.equal(mainCheckoutOf(rig.tree), rig.superproject);
    assert.equal(mainCheckoutOf(path.join(rig.superproject, "libs", "a")), path.join(rig.superproject, "libs", "a"));
    assert.equal(mainCheckoutOf(rig.linkedSub), path.join(rig.superproject, "libs", "a"));
    assert.equal(mainCheckoutOf(rig.plainSub), rig.plainSub);
    assert.equal(mainCheckoutOf(tmp), null);
  } finally {
    rmTestTmp(path.dirname(rig.superproject));
  }
});

// ---------------------------------------------------------------- nested checkouts

test("nested checkout: submodule worktrees and plain submodule checkouts count, nothing else does", { skip }, () => {
  const rig = buildSubmoduleRig(fs.realpathSync(mkTestTmp("pf-wtroot-nest-")));
  try {
    assert.equal(nestedCheckout(rig.tree, rig.linkedSub), true, "(a) linked submodule worktree");
    assert.equal(nestedCheckout(rig.tree, rig.plainSub), true, "(b) plain submodule checkout");
    assert.equal(nestedCheckout(rig.tree, rig.tree), false, "the root itself");
    assert.equal(nestedCheckout(rig.tree, rig.foreign), false, "a foreign clone below an accepted checkout");
    assert.equal(nestedCheckout(rig.tree, rig.forged), false, "a gitfile the admin dir does not name back");
    assert.equal(nestedCheckout(rig.tree, rig.strayInner), false, "transitive: the intermediate clone is not accepted");
    assert.equal(nestedCheckout(rig.tree, rig.superproject), false, "outside the tree");
    assert.equal(nestedCheckout(rig.tree, path.join(rig.tree, "libs")), false, "not a checkout");
    assert.equal(nestedCheckout(path.join(rig.superproject, "libs", "a"), rig.linkedSub), false, "a different root");
  } finally {
    rmTestTmp(path.dirname(rig.superproject));
  }
});

test("nested checkout: the main superproject checkout accepts its own absorbed submodules", { skip }, () => {
  const rig = buildSubmoduleRig(fs.realpathSync(mkTestTmp("pf-wtroot-main-")));
  try {
    assert.equal(nestedCheckout(rig.superproject, path.join(rig.superproject, "b")), true);
    assert.equal(nestedCheckout(rig.superproject, path.join(rig.superproject, "libs", "a")), true);
  } finally {
    rmTestTmp(path.dirname(rig.superproject));
  }
});

test("nested checkout: a symlinked path to the tree gives the same answer", { skip }, () => {
  const rig = buildSubmoduleRig(fs.realpathSync(mkTestTmp("pf-wtroot-lnk-")));
  try {
    const link = path.join(path.dirname(rig.superproject), "tree-link");
    fs.symlinkSync(rig.tree, link);
    assert.equal(nestedCheckout(link, path.join(link, "libs", "a")), true);
    assert.equal(nestedCheckout(link, path.join(link, "forged")), false);
  } finally {
    rmTestTmp(path.dirname(rig.superproject));
  }
});
