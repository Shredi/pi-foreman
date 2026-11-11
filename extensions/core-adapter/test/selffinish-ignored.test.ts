// The self-finish close line names the ignored files that keep a worktree; task logs under .pi/tasks/ do not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
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
const run = (cmd: string, args: string[], cwd: string): string => execFileSync(cmd, args, { cwd, encoding: "utf8", env: { ...cleanEnv(), GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
const git = (cwd: string, ...args: string[]): string => run("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], cwd);
const py = (args: string[]): Promise<{ code: number; out: string }> => new Promise((resolve) => execFile(PY, ["-E", "-s", SCRIPT, ...args], { encoding: "utf8", env: { ...cleanEnv(), GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG } }, (err, stdout) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: String(stdout) })));
const ran = (result: Record<string, unknown>): SafeOpOutcome => ({ kind: "ran", result });

/** main checkout `repo`, a linked worktree `feat` whose branch is merged (no commit of its own), `.pi/` and `*.env` ignored. */
function world() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-selffinish-ign-")));
  const state = path.join(root, "agent", "pi-foreman", "state");
  fs.mkdirSync(state, { recursive: true });
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "README"), "x\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".workflow/\n.pi/\n*.env\n");
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
    closeScript: async (a) => (await py(a)).out,
    spawnCleanup: () => undefined,
  });
  const put = (rel: string): void => {
    fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
    fs.writeFileSync(path.join(wt, rel), "x\n");
  };
  return { root, wt, deps, put, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const closeLine = (lines: string[]): string => lines.find((l) => l.startsWith("cleanup: not started"))!;

test("task logs under .pi/tasks/ do not keep the worktree", async () => {
  const w = world();
  try {
    w.put(".pi/tasks/t1/x.output");
    const r = await selfFinish(w.deps(), 7);
    assert.ok(r.spawn, r.lines.join("\n"));
  } finally {
    w.cleanup();
  }
});

test("the close line names the ignored file and the hint points at it", async () => {
  const w = world();
  try {
    w.put(".pi/tasks/t1/x.output");
    w.put(".pi/settings.json");
    const r = await selfFinish(w.deps(), 7);
    assert.equal(r.spawn, undefined);
    const line = closeLine(r.lines);
    assert.ok(line.includes("(ignored_files: .pi/settings.json)"), line);
    assert.ok(!line.includes("tasks"), line);
    assert.ok(line.includes("the owner copies or deletes the ignored files named here"), line);
    assert.ok(!line.includes("left out line"), line);
    assert.ok(fs.existsSync(w.wt));
  } finally {
    w.cleanup();
  }
});

test("more than three files give a count", async () => {
  const w = world();
  try {
    for (let i = 0; i < 5; i++) w.put(`${i}.env`);
    const line = closeLine((await selfFinish(w.deps(), 7)).lines);
    assert.ok(line.includes("(ignored_files: 0.env, 1.env, 2.env, +2 more)"), line);
  } finally {
    w.cleanup();
  }
});

test("a lone surrogate in a name is printed as ?", async () => {
  const w = world();
  try {
    const hostile = JSON.stringify({ ok: false, reason: "ignored_files", files: ["a\udcff.env"], filesMore: 0 });
    const r = await selfFinish({ ...w.deps(), closeScript: async () => hostile }, 7);
    const line = closeLine(r.lines);
    assert.ok(line.includes("(ignored_files: a?.env)"), line);
    assert.ok(!/\p{Cs}/u.test(line), line);
  } finally {
    w.cleanup();
  }
});

test("control characters in a name are cleaned again in the line", async () => {
  const w = world();
  try {
    const hostile = JSON.stringify({ ok: false, reason: "ignored_files", files: ["a\u001b[31m‮b\nc.env", 7, "d.env"], filesMore: 2 });
    const r = await selfFinish({ ...w.deps(), closeScript: async () => hostile }, 7);
    const line = closeLine(r.lines);
    assert.ok(line.includes("(ignored_files: a?[31m?b?c.env, d.env, +2 more)"), line);
    assert.ok(!/[\u0000-\u001f‮]/.test(line), line);
  } finally {
    w.cleanup();
  }
});
