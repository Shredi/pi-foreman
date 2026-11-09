// While the npm root resolves, a child's overlay already blocks sibling worktrees under a custom root; the root itself is not yet owned.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ownedRoots } from "../owned.ts";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import { rootTemplateGlobs, resolveWorktreeRoot } from "../worktreeroot.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const skip = process.platform === "win32" ? "POSIX path fixtures" : false;
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tmp = fs.realpathSync(mkTestTmp("pf-wtroot-pend-"));
process.on("exit", () => rmTestTmp(tmp));

test("pending npm root: custom-root block globs apply, the custom root is not owned", { skip }, () => {
  const repoDir = path.join(tmp, "work", "repo");
  const trees = path.join(tmp, "elsewhere", "trees");
  const customRoot = path.join(trees, "repo");
  fs.mkdirSync(path.join(customRoot, "round"), { recursive: true });
  fs.mkdirSync(path.join(trees, "other", "round"), { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });
  const agentDir = path.join(tmp, "agent");
  const inputs = { worktreeGlobs: rootTemplateGlobs(resolveWorktreeRoot(repoDir, path.join(trees, "<repo>"), { home: tmp, agentDir, tmpRoot: path.join(tmp, "t"), pkgRoot, superproject: null })) };
  assert.ok((inputs.worktreeGlobs ?? []).length > 0);
  // pending: globs passed, worktreeRoot withheld
  const owned = ownedRoots({ agentDir, workspaceRoot: repoDir, tmpRoot: path.join(tmp, "t"), worktreeGlobs: inputs.worktreeGlobs });
  assert.ok(!owned.readWrite.includes(customRoot));
  const rules = buildOverlayRules(readBaseline(pkgRoot)!, {}, {}, agentDir, pkgRoot, undefined, false, owned);
  const own = path.join(customRoot, "round");
  const run = (file: string): string => checkToolCall(rules, "write", { path: file }, { cwd: own, home: tmp, platform: process.platform, role: "child", roundRoots: [own], roundReadRoots: [own] })?.kind ?? "pass";
  assert.equal(run(path.join(trees, "other", "round", "x.ts")), "deny");
});
