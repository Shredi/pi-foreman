// pi-subagents links the main checkout's node_modules into a managed worktree before it runs the setup
// hook. bin/foreman-worktree-setup must turn that link into a real directory when a lockfile exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupWorktrees, createWorktrees } from "../../../node_modules/pi-subagents/src/runs/shared/worktree.js";
import { rmTestTmp } from "./_tmpbase.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HOOK = path.join(ROOT, "bin", "foreman-worktree-setup");
const skip = process.platform === "win32" ? "POSIX only: pi-subagents cannot spawn a script hook without a shell on Windows" : false;

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], { cwd, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" } });
};

function fixture(lockfile: boolean): { tmp: string; repo: string } {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-wthook-")));
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(repo, "package.json"), "{}\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
  if (lockfile) fs.writeFileSync(path.join(repo, "package-lock.json"), "{}\n");
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return { tmp, repo };
}

async function create(repo: string, runId: string): Promise<{ path: string; setup: Parameters<typeof cleanupWorktrees>[0] }> {
  const setup = await createWorktrees(repo, runId, 1, { provider: "native", setupHook: { hookPath: HOOK, timeoutMs: 60_000 } });
  return { path: setup.worktrees[0].path, setup };
}

test("worktree hook: a lockfile turns the linked node_modules into a real copy", { skip }, async () => {
  const { tmp, repo } = fixture(true);
  try {
    const wt = await create(repo, "hooklock");
    const nm = path.join(wt.path, "node_modules");
    assert.equal(fs.lstatSync(nm).isSymbolicLink(), false, "node_modules must not stay a symlink");
    assert.equal(fs.lstatSync(nm).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(nm, "pkg", "index.js"), "utf8"), "module.exports = 1;\n");
    fs.writeFileSync(path.join(nm, "pkg", "index.js"), "changed\n");
    assert.equal(fs.readFileSync(path.join(repo, "node_modules", "pkg", "index.js"), "utf8"), "module.exports = 1;\n", "the main checkout is untouched");
    cleanupWorktrees(wt.setup);
  } finally {
    rmTestTmp(tmp);
  }
});

test("worktree hook: without a lockfile the link stays", { skip }, async () => {
  const { tmp, repo } = fixture(false);
  try {
    const wt = await create(repo, "hooknolock");
    assert.equal(fs.lstatSync(path.join(wt.path, "node_modules")).isSymbolicLink(), true);
    cleanupWorktrees(wt.setup);
  } finally {
    rmTestTmp(tmp);
  }
});
