// /foreman doctor: worktree node_modules symlinks and the pi-subagents setup hook (registry.ts worktreeDoctor).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promptCacheSnippet, symlinkedNodeModules, worktreeDoctor, worktreePaths } from "../registry.ts";

const skip = process.platform === "win32" ? "symlink fixtures are POSIX only" : false;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-doctor-wt-")));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], { cwd, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" } });
};

const repo = path.join(tmp, "repo");
const linked = path.join(tmp, "repo.worktrees", "linked");
const real = path.join(tmp, "repo.worktrees", "real");
// only the symlink test (skipped on win32) needs the repo; building it there crashed the whole file at load
if (!skip) {
  fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(repo, "README"), "x\n");
  git(repo, "init", "-q");
  git(repo, "add", "README");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "worktree", "add", "-q", "-b", "linked", linked);
  git(repo, "worktree", "add", "-q", "-b", "real", real);
}

test("doctor: worktree list parsing", () => {
  assert.deepEqual(worktreePaths("worktree /a/b\nHEAD abc\nbranch refs/heads/main\n\nworktree /a/c\nHEAD def\ndetached\n"), ["/a/b", "/a/c"]);
});

test("doctor: a symlinked node_modules in a live worktree is reported", { skip }, () => {
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(linked, "node_modules"));
  fs.mkdirSync(path.join(real, "node_modules"));
  assert.deepEqual(symlinkedNodeModules(repo), [linked]);
  const lines = worktreeDoctor(path.join(tmp, "agent"), repo, "linux");
  assert.ok(lines.includes(`WARN node_modules is a symlink in ${linked} \u2014 fix: in that worktree run rm node_modules && npm ci (never npm ci through the link)`), lines.join("\n"));
  assert.equal(lines.some((l) => l.includes(real)), false);
});

test("doctor: outside a git repository nothing is reported", () => {
  assert.deepEqual(symlinkedNodeModules(path.join(tmp, "agent")), []);
});

test("doctor: WARN when the worktree setup hook is not configured, POSIX only", () => {
  const agent = path.join(tmp, "agent2");
  const noHook = worktreeDoctor(agent, path.join(tmp, "nowhere"), "linux");
  assert.equal(noHook.length, 1);
  assert.match(noHook[0], /^WARN worktreeSetupHook is not set in .*extensions.subagent.config\.json/);
  assert.deepEqual(worktreeDoctor(agent, path.join(tmp, "nowhere"), "win32"), []);
  fs.mkdirSync(path.join(agent, "extensions", "subagent"), { recursive: true });
  fs.writeFileSync(path.join(agent, "extensions", "subagent", "config.json"), JSON.stringify({ worktreeSetupHook: "/x/bin/foreman-worktree-setup" }));
  assert.deepEqual(worktreeDoctor(agent, path.join(tmp, "nowhere"), "linux"), []);
});

test("doctor: the promptCache hint is the full models.json snippet", () => {
  assert.deepEqual(JSON.parse(promptCacheSnippet("anthropic", "claude-x", 300)), { providers: { anthropic: { modelOverrides: { "claude-x": { promptCache: { short: 300 } } } } } });
  assert.match(promptCacheSnippet(undefined, undefined, 300), /"<provider>":\{"modelOverrides":\{"<modelId>":\{"promptCache":\{"short":300\}/);
});
