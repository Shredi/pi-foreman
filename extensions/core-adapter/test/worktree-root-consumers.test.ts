// worktreeroot.ts consumers: owned roots, overlay block globs, round detection, tree lift, push guard, session inputs, doctor.
// A custom absolute root lives in a separate temp tree; one variant reaches it through a symlink. The default layout keeps its own tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ownedRoots } from "../owned.ts";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import { mainWorkflowReadable, roundRoots } from "../roundsurface.ts";
import { ownWorktreeCheck } from "../ownworktree.ts";
import { sessionRootInputs, treeCeilingOf, treeRootOf, worktreeRootDoctor, inNestedCheckout, rootTemplateGlobs, resolveWorktreeRoot } from "../worktreeroot.ts";
import { buildSubmoduleRig } from "./_submodules.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const skip = process.platform === "win32" ? "POSIX path and symlink fixtures" : false;
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const real = (p: string): string => fs.realpathSync(p);
const tmp = real(mkTestTmp("pf-wtroot-cons-"));
process.on("exit", () => rmTestTmp(tmp));

const repoDir = path.join(tmp, "work", "repo");
const trees = path.join(tmp, "elsewhere", "trees");
const customRoot = path.join(trees, "repo");
const linkTrees = path.join(tmp, "link-to-trees");
const linkRoot = path.join(linkTrees, "repo");
fs.mkdirSync(path.join(customRoot, "round"), { recursive: true });
fs.mkdirSync(path.join(trees, "other", "round"), { recursive: true });
fs.mkdirSync(repoDir, { recursive: true });
fs.symlinkSync(trees, linkTrees);
const setting = (spelled: string): string => path.join(path.dirname(spelled), "<repo>");

for (const [name, spelled] of [["absolute", customRoot], ["symlinked", linkRoot]] as const) {
  test(`owned: custom ${name} root is the owned worktree root, not <ws>.worktrees`, { skip }, () => {
    const o = ownedRoots({ agentDir: path.join(tmp, "agent"), workspaceRoot: repoDir, tmpRoot: path.join(tmp, "t"), worktreeRoot: [spelled, real(spelled)] });
    assert.ok(o.readWrite.includes(path.resolve(spelled)));
    assert.ok(o.readWrite.includes(customRoot));
    assert.ok(!o.readWrite.some((r) => r.endsWith("repo.worktrees")));
  });

  test(`overlay (${name} root): a child blocks sibling rounds under the root, keeps its own`, { skip }, () => {
    const globs = rootTemplateGlobs(resolveWorktreeRoot(repoDir, setting(spelled), { home: tmp, agentDir: path.join(tmp, "agent"), tmpRoot: path.join(tmp, "t"), pkgRoot, superproject: null }));
    assert.ok(globs.length > 0);
    const owned = ownedRoots({ agentDir: path.join(tmp, "agent"), workspaceRoot: repoDir, tmpRoot: path.join(tmp, "t"), worktreeRoot: [spelled, real(spelled)], worktreeGlobs: globs });
    const rules = buildOverlayRules(readBaseline(pkgRoot)!, {}, {}, path.join(tmp, "agent"), pkgRoot, undefined, false, owned);
    const own = path.join(customRoot, "round");
    const run = (file: string): string => checkToolCall(rules, "write", { path: file }, { cwd: own, home: tmp, platform: process.platform, role: "child", roundRoots: [own], roundReadRoots: [own] })?.kind ?? "pass";
    assert.equal(run(path.join(own, "x.ts")), "pass");
    assert.equal(run(path.join(path.dirname(spelled), "other", "round", "x.ts")), "deny");
  });
}

test("sessionRootInputs: refused value falls back with a notice; custom root gives spelled and real; linked trees only block", { skip }, () => {
  const rig = buildSubmoduleRig(real(mkTestTmp("pf-wtroot-si-")));
  try {
    const opts = { home: tmp, agentDir: path.join(tmp, "agent"), tmpRoot: path.join(tmp, "t"), pkgRoot };
    const bad = sessionRootInputs(rig.superproject, "~", opts);
    assert.equal(bad.worktreeRoot, undefined);
    assert.match(bad.notice ?? "", /default worktree layout/);
    assert.deepEqual(sessionRootInputs(rig.superproject, null, opts), {});
    const ok = sessionRootInputs(rig.superproject, setting(linkRoot), opts);
    assert.ok(ok.worktreeRoot?.includes(path.join(trees, "super")) && ok.worktreeRoot.includes(path.join(linkTrees, "super")), String(ok.worktreeRoot));
    assert.ok((ok.worktreeGlobs ?? []).length > 0);
    const linked = sessionRootInputs(rig.tree, setting(linkRoot), opts);
    assert.equal(linked.worktreeRoot, undefined);
    assert.ok((linked.worktreeGlobs ?? []).length > 0);
  } finally {
    rmTestTmp(path.dirname(rig.superproject));
  }
});

test("nested submodule checkouts: one tree for round detection, tree lift, ceiling and push guard", { skip }, () => {
  const rig = buildSubmoduleRig(real(mkTestTmp("pf-wtroot-nt-")));
  try {
    const inner = path.join(rig.linkedSub, "f");
    // round detection: a cwd inside the nested checkout stays the round tree
    assert.deepEqual(roundRoots([rig.tree], rig.linkedSub), [rig.tree]);
    assert.deepEqual(roundRoots([rig.tree], rig.plainSub), [rig.tree]);
    // lift is bounded by the ceiling and refuses non-accepted checkouts
    assert.equal(treeRootOf(rig.linkedSub, rig.tree), rig.tree);
    assert.equal(treeRootOf(rig.plainSub, rig.tree), rig.tree);
    assert.equal(treeRootOf(rig.linkedSub, rig.linkedSub), rig.linkedSub);
    assert.equal(treeRootOf(rig.linkedSub, ""), rig.linkedSub);
    assert.equal(treeRootOf(rig.foreign, rig.tree), rig.foreign);
    assert.equal(treeRootOf(rig.superproject, rig.tree), rig.superproject);
    assert.equal(inNestedCheckout(rig.linkedSub), true);
    assert.equal(inNestedCheckout(rig.tree), false);
    // ceiling without a foreman session: the workspace of the cwd
    assert.equal(treeCeilingOf({ cwd: rig.linkedSub, agentDir: path.join(tmp, "agent") }), rig.linkedSub);
    assert.equal(treeCeilingOf({ cwd: rig.linkedSub, agentDir: path.join(tmp, "agent"), binding: { workspace: rig.tree } }), rig.tree);
    assert.equal(treeCeilingOf({ cwd: path.join(tmp, "nowhere"), agentDir: path.join(tmp, "agent") }), "");
    // push guard: a nested checkout of an own tree is own, a stray clone is not
    const own = ownWorktreeCheck([rig.tree]);
    assert.equal(own(rig.linkedSub), true);
    assert.equal(own(rig.plainSub), true);
    assert.equal(own(rig.foreign), false);
    assert.equal(own(rig.superproject), false);
    assert.doesNotThrow(() => mainWorkflowReadable([path.join(tmp, "missing", "round")]));
    assert.ok(fs.existsSync(inner));
  } finally {
    rmTestTmp(path.dirname(rig.superproject));
  }
});

test("roundsurface: mainWorkflowReadable resolves a custom-root round to its own main checkout", { skip }, () => {
  const rig = buildSubmoduleRig(real(mkTestTmp("pf-wtroot-rs-")));
  try {
    const out = mainWorkflowReadable([rig.tree]);
    assert.ok(out.includes(path.join(rig.superproject, ".workflow")));
    assert.deepEqual(mainWorkflowReadable([rig.tree]), out, "memoised result is stable");
  } finally {
    rmTestTmp(path.dirname(rig.superproject));
  }
});

test("doctor: effective root, writable, refused value", { skip }, () => {
  const rig = buildSubmoduleRig(real(mkTestTmp("pf-wtroot-dr-")));
  try {
    assert.deepEqual(worktreeRootDoctor({}, path.join(tmp, "nowhere"), process.platform), []);
    const ok = worktreeRootDoctor({ close: { worktreeDir: setting(customRoot) } }, rig.superproject, process.platform).join("\n");
    assert.match(ok, /worktree root: /);
    assert.match(ok, /writable/);
    assert.ok(!/FAIL/.test(ok), ok);
    const bad = worktreeRootDoctor({ close: { worktreeDir: "~" } }, rig.superproject, process.platform).join("\n");
    assert.match(bad, /FAIL close\.worktreeDir refused/);
  } finally {
    rmTestTmp(path.dirname(rig.superproject));
  }
});
