// Round 2, step 6: assertions on kept code that sat beside overlay assertions in tests deleted with the overlay (literals as at HEAD).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ownedRoots } from "../owned.ts";
import { shortNameFits } from "../pathnorm.ts";
import { rootTemplateGlobs, resolveWorktreeRoot } from "../worktreeroot.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const skip = process.platform === "win32" ? "POSIX path fixtures" : false;
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tmp = fs.realpathSync(mkTestTmp("pf-rescued-"));
process.on("exit", () => rmTestTmp(tmp));

test("shortNameFits: MCP~1.JSO fits .mcp.json, GIT~1 does not fit .github", () => {
  assert.equal(shortNameFits("MCP~1.JSO", ".mcp.json"), true);
  assert.equal(shortNameFits("GIT~1", ".github"), false);
});

test("pending npm root: globs without a worktreeRoot do not make the custom root owned", { skip }, () => {
  const repoDir = path.join(tmp, "work", "repo");
  const trees = path.join(tmp, "elsewhere", "trees");
  const customRoot = path.join(trees, "repo");
  fs.mkdirSync(path.join(customRoot, "round"), { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });
  const agentDir = path.join(tmp, "agent");
  const worktreeGlobs = rootTemplateGlobs(resolveWorktreeRoot(repoDir, path.join(trees, "<repo>"), { home: tmp, agentDir, tmpRoot: path.join(tmp, "t"), pkgRoot, superproject: null }));
  assert.ok(worktreeGlobs.length > 0);
  const owned = ownedRoots({ agentDir, workspaceRoot: repoDir, tmpRoot: path.join(tmp, "t"), worktreeGlobs });
  assert.ok(!owned.readWrite.includes(customRoot));
});
