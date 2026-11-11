// End to end with the real close scripts and real git: tool caches do not keep a merged worktree, an unlisted ignored file does and is named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SafeOpOutcome } from "../safeops.ts";
import { selfFinish } from "../selffinish.ts";
import type { SelfFinishDeps } from "../selffinish.ts";

const SCRIPT = path.resolve(import.meta.dirname, "..", "..", "..", "scripts", "foreman_close.py");
const PY = process.env.PI_FOREMAN_PYTHON || (process.platform === "win32" ? "python" : "python3");

const cleanEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_CONFIG_")));
const EMPTY_GITCONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pf-gitcfg-")), "gitconfig");
fs.writeFileSync(EMPTY_GITCONFIG, "");
const env = (): NodeJS.ProcessEnv => ({ ...cleanEnv(), GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG, GIT_CONFIG_NOSYSTEM: "1" });
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8", env: env() }).trim();
const py = (args: string[]): string => {
  try {
    return execFileSync(PY, ["-E", "-s", SCRIPT, ...args], { encoding: "utf8", env: env(), stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? "");
  }
};
const ran = (result: Record<string, unknown>): SafeOpOutcome => ({ kind: "ran", result });

/** a merged linked worktree `feat`; every untracked path is ignored; the cleanup runs synchronously (the waited-for pid is dead). */
function world() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-selffinish-cache-")));
  const state = path.join(root, "agent", "pi-foreman", "state");
  fs.mkdirSync(state, { recursive: true });
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "README"), "x\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "*\n!README\n!.gitignore\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const wt = path.join(root, "repo.worktrees", "feat");
  git(repo, "worktree", "add", "-q", "-b", "feat", wt);
  const tip = git(wt, "rev-parse", "HEAD");
  const handoff = path.join(root, "handoffs", "20261102-120000-demo");
  fs.mkdirSync(handoff, { recursive: true });
  const deps = (): SelfFinishDeps => ({
    cwd: repo, handoff, sessionId: "child-1", stateDir: state, pid: 99999999, trusted: false, sinceMs: Date.now() - 60_000,
    status: async () => ran({ state: "merged", headRefName: "feat", baseRef: "main", headSha: tip }),
    git: async (a, dir) => git(dir ?? repo, ...a),
    closeScript: async (a) => py(a),
    spawnCleanup: (a) => { py(a); },
  });
  const put = (rel: string): void => {
    fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
    fs.writeFileSync(path.join(wt, rel), "x\n");
  };
  const litter = (): void => ["node_modules/p/index.js", ".pytest_cache/v/cache/lastfailed", ".pi/tasks/t1/x.output"].forEach(put);
  return { root, repo, wt, deps, put, litter, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("caches plus an unlisted ignored file: the close line names the file and the worktree stays", async () => {
  const w = world();
  try {
    w.litter();
    w.put(".env.local");
    const r = await selfFinish(w.deps(), 7);
    assert.equal(r.spawn, undefined);
    const line = r.lines.find((l) => l.startsWith("cleanup: not started"))!;
    console.log(line);
    assert.ok(line.includes("(ignored_files: .env.local)"), line);
    assert.ok(!line.includes(".pytest_cache") && !line.includes("node_modules"), line);
    assert.ok(fs.existsSync(w.wt));
  } finally {
    w.cleanup();
  }
});

test("caches only: the worktree and its branch are removed", async () => {
  const w = world();
  try {
    w.litter();
    const r = await selfFinish(w.deps(), 7);
    assert.ok(r.spawn, r.lines.join("\n"));
    r.spawn();
    console.log(r.lines.join("\n"));
    assert.ok(!fs.existsSync(w.wt));
    assert.equal(git(w.repo, "branch", "--list", "feat"), "");
  } finally {
    w.cleanup();
  }
});
