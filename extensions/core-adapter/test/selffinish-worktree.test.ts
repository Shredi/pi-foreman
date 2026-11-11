// Self-finish of a round that worked in a second worktree: the session's cwd is the main checkout, the PR head branch lives in another worktree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SafeOpOutcome } from "../safeops.ts";
import { parseWorktrees, samePath, selfFinish } from "../selffinish.ts";
import type { SelfFinishDeps } from "../selffinish.ts";

const SCRIPT = path.resolve(import.meta.dirname, "..", "..", "..", "scripts", "foreman_close.py");
const PY = process.env.PI_FOREMAN_PYTHON || (process.platform === "win32" ? "python" : "python3");

// the harness env injects git config (GIT_CONFIG_*) that makes every push fail; the temp repos push to a local bare repo
const cleanEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_CONFIG_")));
// os.devNull is \\.\nul on Windows, which git cannot open as a config file
const EMPTY_GITCONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pf-gitcfg-")), "gitconfig");
fs.writeFileSync(EMPTY_GITCONFIG, "");
const run = (cmd: string, args: string[], cwd: string): string => execFileSync(cmd, args, { cwd, encoding: "utf8", env: { ...cleanEnv(), GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
const git = (cwd: string, ...args: string[]): string => run("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], cwd);
const py = (args: string[]): Promise<{ code: number; out: string }> => new Promise((resolve) => execFile(PY, ["-E", "-s", SCRIPT, ...args], { encoding: "utf8", env: { ...cleanEnv(), GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG } }, (err, stdout) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: String(stdout) })));
const ran = (result: Record<string, unknown>): SafeOpOutcome => ({ kind: "ran", result });
const fwd = (s: string): string => s.replace(/\\/g, "/").toLowerCase();

/** main checkout `repo` on `main`, a second worktree `feat` whose branch was squash-merged into main. */
function world() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-selffinish-wt-")));
  const state = path.join(root, "agent", "pi-foreman", "state");
  fs.mkdirSync(state, { recursive: true });
  const origin = path.join(root, "origin.git");
  run("git", ["init", "-q", "--bare", "-b", "main", origin], root);
  const repo = path.join(root, "repo");
  run("git", ["clone", "-q", origin, repo], root);
  git(repo, "checkout", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "README"), "x\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".workflow/\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "-u", "origin", "main");
  const wt = path.join(root, "repo.worktrees", "feat");
  git(repo, "worktree", "add", "-q", "-b", "feat", wt);
  fs.writeFileSync(path.join(wt, "f.txt"), "feature\n");
  git(wt, "add", "f.txt");
  git(wt, "commit", "-q", "-m", "feature");
  const tip = git(wt, "rev-parse", "HEAD");
  git(repo, "merge", "--squash", "feat");
  git(repo, "commit", "-q", "-m", "feature (squash)");
  git(repo, "push", "-q", "origin", "main");
  fs.mkdirSync(path.join(wt, ".workflow"), { recursive: true });
  fs.writeFileSync(path.join(wt, ".workflow", "LEDGER-x.md"), "# ledger\n");
  const handoff = path.join(root, "handoffs", "20261102-120000-demo");
  fs.mkdirSync(handoff, { recursive: true });
  const spawned: string[][] = [];
  let scriptCalls = 0;
  const deps = (over: Partial<SelfFinishDeps> = {}): SelfFinishDeps => ({
    cwd: repo, handoff, sessionId: "child-1", stateDir: state, pid: 99999999, trusted: false, sinceMs: Date.now() - 60_000,
    status: async () => ran({ state: "merged", headRefName: "feat", baseRef: "main", headSha: tip }),
    git: async (a, dir) => git(dir ?? repo, ...a),
    closeScript: async (a) => (scriptCalls++, (await py(a)).out),
    spawnCleanup: (a) => void spawned.push(a),
    ...over,
  });
  return { root, state, repo, wt, tip, handoff, spawned, deps, calls: () => scriptCalls, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("a round in a second worktree is verified and cleaned; the main checkout stays intact", async () => {
  const w = world();
  try {
    const r = await selfFinish(w.deps(), 7);
    assert.ok(r.spawn, r.lines.join("\n"));
    assert.ok(r.lines.some((l) => l.startsWith("workflow archive: ")), r.lines.join("\n"));
    assert.ok(r.lines.some((l) => l.startsWith("cleanup: worktree ") && fwd(l).includes(fwd(w.wt)) && l.includes("branch feat")), r.lines.join("\n"));
    assert.ok(!r.lines.some((l) => l.startsWith("merged fact: not verified")));
    r.spawn();
    const res = await py(w.spawned[0]);
    assert.equal(res.code, 0);
    assert.ok(!fs.existsSync(w.wt), "worktree gone");
    assert.equal(git(w.repo, "branch", "--list", "feat"), "", "local branch gone");
    assert.equal(git(w.repo, "branch", "--show-current"), "main");
    assert.equal(fs.readFileSync(path.join(w.repo, "README"), "utf8"), "x\n");
    assert.ok(fs.existsSync(path.join(w.handoff, "workflow", "LEDGER-x.md")), "the archive survives");
  } finally {
    w.cleanup();
  }
});

test("a dirty second worktree is left and the message names its path and branch", async () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w.wt, "dirty.txt"), "d\n");
    const r = await selfFinish(w.deps(), 7);
    assert.equal(r.spawn, undefined);
    const line = r.lines.find((l) => l.startsWith("cleanup: not started"))!;
    assert.ok(line.includes("worktree_dirty") && fwd(line).includes(fwd(w.wt)) && line.includes("branch feat"), line);
    assert.ok(fs.existsSync(w.wt));
  } finally {
    w.cleanup();
  }
});

test("an older file in the linked worktree's .workflow belongs to its round: kept, and the worktree is still removed", async () => {
  const w = world();
  try {
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(path.join(w.wt, ".workflow", "LEDGER-x.md"), old, old);
    const r = await selfFinish(w.deps(), 7);
    assert.ok(r.spawn, r.lines.join("\n"));
    assert.ok(!r.lines.some((l) => l.startsWith("workflow archive left out: ")), r.lines.join("\n"));
    assert.ok(fs.existsSync(path.join(w.handoff, "workflow", "LEDGER-x.md")));
  } finally {
    w.cleanup();
  }
});

test("Closed/ and ARCHIVE/ stay out of the snapshot whatever their case", async () => {
  const w = world();
  try {
    fs.mkdirSync(path.join(w.wt, ".workflow", "Closed", "r1"), { recursive: true });
    fs.writeFileSync(path.join(w.wt, ".workflow", "Closed", "r1", "old.md"), "old\n");
    fs.mkdirSync(path.join(w.wt, ".workflow", "ARCHIVE"), { recursive: true });
    fs.writeFileSync(path.join(w.wt, ".workflow", "ARCHIVE", "old.md"), "old\n");
    const r = await selfFinish(w.deps(), 7);
    assert.ok(fs.existsSync(path.join(w.handoff, "workflow", "LEDGER-x.md")));
    assert.ok(!fs.existsSync(path.join(w.handoff, "workflow", "Closed")) && !fs.existsSync(path.join(w.handoff, "workflow", "ARCHIVE")));
    assert.ok(r.lines.some((l) => l.startsWith("workflow archive left out: ") && l.includes("closed/") && l.includes("archive/")), r.lines.join("\n"));
  } finally {
    w.cleanup();
  }
});

test("something left out of the linked worktree's .workflow keeps it: the message names its path and branch", async () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w.wt, ".workflow", "big.bin"), Buffer.alloc(17 * 1024 * 1024));
    const r = await selfFinish(w.deps(), 7);
    assert.equal(r.spawn, undefined);
    assert.ok(r.lines.some((l) => l.startsWith("workflow archive left out: ") && l.includes("big.bin")), r.lines.join("\n"));
    const line = r.lines.find((l) => l.startsWith("cleanup: not started"))!;
    assert.ok(line.includes("ignored_files") && fwd(line).includes(fwd(w.wt)) && line.includes("branch feat"), line);
    assert.ok(fs.existsSync(w.wt));
  } finally {
    w.cleanup();
  }
});

test("the main checkout is never removed: head ref equal to the default branch is refused in TS and by the Python check", async () => {
  const w = world();
  try {
    const r = await selfFinish(w.deps({ status: async () => ran({ state: "merged", headRefName: "main", baseRef: "main", headSha: git(w.repo, "rev-parse", "HEAD") }) }), 7);
    assert.equal(r.spawn, undefined);
    assert.equal(w.calls(), 1, "only the cwd snapshot runs for the main checkout");
    const line = r.lines.find((l) => l.startsWith("cleanup: not started"))!;
    assert.ok(line.includes("main checkout") && fwd(line).includes(fwd(w.repo)) && line.includes("branch main"), line);
    const head = git(w.repo, "rev-parse", "HEAD");
    const base = ["selfclean", "--ws", w.repo, "--branch", "main", "--state", w.state, "--session", "child-1", "--verified-merged", head];
    const py1 = await py(base);
    assert.equal(py1.code, 3);
    assert.ok(["main_worktree", "default_branch"].includes(JSON.parse(py1.out).reason), py1.out);
    assert.ok(fs.existsSync(path.join(w.repo, "README")));
  } finally {
    w.cleanup();
  }
});

test("a refusal before the check still snapshots the session cwd's .workflow, with the archive and left-out lines", async () => {
  const w = world();
  try {
    const wf = path.join(w.repo, ".workflow");
    fs.mkdirSync(path.join(wf, "closed", "r1"), { recursive: true });
    fs.writeFileSync(path.join(wf, "closed", "r1", "big.md"), "x\n");
    fs.writeFileSync(path.join(wf, "notes.md"), "n\n");
    const r = await selfFinish(w.deps({ status: async () => ran({ state: "merged", headRefName: "main", baseRef: "main", headSha: git(w.repo, "rev-parse", "HEAD") }) }), 7);
    assert.equal(r.spawn, undefined);
    assert.ok(r.lines.some((l) => l.startsWith("workflow archive: ") && l.includes("(1 files)")), r.lines.join("\n"));
    assert.ok(r.lines.some((l) => l.startsWith("workflow archive left out: ") && l.includes("closed/")), r.lines.join("\n"));
    assert.ok(r.lines.some((l) => l.startsWith("cleanup: not started")));
    assert.ok(fs.existsSync(path.join(w.handoff, "workflow", "notes.md")));
    assert.ok(fs.existsSync(w.wt) && fs.existsSync(path.join(w.repo, "README")));
  } finally {
    w.cleanup();
  }
});

test("the PR base branch is never a target even in a second worktree", async () => {
  const w = world();
  try {
    const r = await selfFinish(w.deps({ status: async () => ran({ state: "merged", headRefName: "feat", baseRef: "feat", headSha: w.tip }) }), 7);
    assert.equal(r.spawn, undefined);
    assert.equal(w.calls(), 1);
    assert.ok(r.lines.some((l) => l.includes("base branch") && l.includes("branch feat")), r.lines.join("\n"));
  } finally {
    w.cleanup();
  }
});

test("a PR head branch in no worktree: the message names the branch and what to do; nothing is removed", async () => {
  const w = world();
  try {
    const r = await selfFinish(w.deps({ status: async () => ran({ state: "merged", headRefName: "ghost", baseRef: "main", headSha: w.tip }) }), 7);
    assert.equal(r.spawn, undefined);
    const text = r.lines.join("\n");
    assert.match(text, /merged fact: not verified \(PR #7 head branch ghost is not checked out in a worktree of this repository\)/);
    assert.match(text, /cleanup: not started; nothing is removed.*git branch -D ghost/);
    assert.ok(fs.existsSync(w.wt));
  } finally {
    w.cleanup();
  }
});

test("a detached second worktree: the not-started line names its path and says what the owner does", async () => {
  const w = world();
  try {
    git(w.wt, "checkout", "-q", "--detach");
    // git exits non-zero for symbolic-ref on a detached HEAD; the adapter's git wrapper turns that into null
    const r = await selfFinish(w.deps({ cwd: w.wt, status: async () => ran({ state: "open", headRefName: null, baseRef: "main", headSha: null }), git: async (a, dir) => { try { return git(dir ?? w.wt, ...a); } catch { return null; } } }), 7);
    assert.equal(r.spawn, undefined);
    assert.equal(w.calls(), 0, "no check runs without a branch");
    const line = r.lines.find((l) => l.startsWith("cleanup: not started"))!;
    assert.ok(line.includes(`the worktree ${w.wt} has no branch checked out`) && line.includes(`git worktree remove ${w.wt}`), line);
    assert.ok(fs.existsSync(w.wt));
  } finally {
    w.cleanup();
  }
});

test("a main checkout on a detached HEAD is named as the main checkout, never offered for removal, with or without a PR head ref", async () => {
  for (const status of [async (): Promise<SafeOpOutcome> => ({ kind: "error", message: "pr_status failed" }), async () => ran({ state: "open", headRefName: null, baseRef: "main", headSha: null })]) {
    const w = world();
    try {
      git(w.repo, "checkout", "-q", "--detach");
      const r = await selfFinish(w.deps({ status, git: async (a, dir) => { try { return git(dir ?? w.repo, ...a); } catch { return null; } } }), 7);
      const text = r.lines.join("\n");
      assert.equal(r.spawn, undefined);
      assert.equal(w.spawned.length, 0);
      assert.ok(!text.includes("git worktree remove"), text);
      assert.ok(!text.includes("null"), text);
      const line = r.lines.find((l) => l.startsWith("cleanup: not started"))!;
      assert.ok(line.includes(`worktree ${w.repo} is the main checkout`) && line.includes("nothing is removed"), line);
      assert.ok(fs.existsSync(w.repo) && fs.existsSync(w.wt));
    } finally {
      w.cleanup();
    }
  }
});

test("an unborn second worktree: the not-started line names its path and branch and what the owner does", async () => {
  const w = world();
  try {
    const orphan = path.join(w.root, "repo.worktrees", "orphan");
    git(w.repo, "worktree", "add", "-q", "--orphan", "-b", "newb", orphan);
    const r = await selfFinish(w.deps({ cwd: orphan, status: async () => ran({ state: "open", headRefName: null, baseRef: "main", headSha: null }), git: async (a, dir) => { try { return git(dir ?? orphan, ...a); } catch { return null; } } }), 7);
    assert.equal(r.spawn, undefined);
    const line = r.lines.find((l) => l.startsWith("cleanup: not started"))!;
    assert.ok(line.includes(`the worktree ${orphan} has no commit checked out`) && line.includes(`worktree ${orphan} and branch newb stay`), line);
    assert.ok(line.includes("git worktree remove " + orphan), line);
    assert.ok(fs.existsSync(orphan));
  } finally {
    w.cleanup();
  }
});

const gitIn = (fallback: string) => async (a: string[], dir?: string): Promise<string | null> => { try { return git(dir ?? fallback, ...a); } catch { return null; } };
const noRemoveOf = (text: string, ...dirs: string[]): void => {
  for (const dir of dirs) assert.ok(!fwd(text).includes(`git worktree remove ${fwd(dir)}`), text);
};

test("cwd in a subfolder of the main checkout on a detached HEAD, pr_status failing: the main checkout is named, no remove command", async () => {
  const w = world();
  try {
    git(w.repo, "checkout", "-q", "--detach");
    const sub = path.join(w.repo, "sub");
    fs.mkdirSync(sub);
    const r = await selfFinish(w.deps({ cwd: sub, status: async () => ({ kind: "error", message: "pr_status failed" }), git: gitIn(sub) }), 7);
    const text = r.lines.join("\n");
    assert.equal(r.spawn, undefined);
    assert.equal(w.spawned.length, 0);
    assert.ok(!text.includes("git worktree remove") && !text.includes("git branch -D"), text);
    const line = r.lines.find((l) => l.startsWith("cleanup: not started"))!;
    assert.ok(line.includes(`worktree ${w.repo} is the main checkout`) && !fwd(line).includes(fwd(sub)), line);
    assert.ok(fs.existsSync(w.repo) && fs.existsSync(w.wt));
  } finally {
    w.cleanup();
  }
});

test("cwd in a subfolder of the main checkout on the round branch: refused as the main checkout, no remove command", async () => {
  const w = world();
  try {
    git(w.repo, "checkout", "-q", "-b", "round");
    const sub = path.join(w.repo, "sub");
    fs.mkdirSync(sub);
    const head = git(w.repo, "rev-parse", "HEAD");
    const r = await selfFinish(w.deps({ cwd: sub, status: async () => ran({ state: "merged", headRefName: "round", baseRef: "main", headSha: head }), git: gitIn(sub) }), 7);
    const text = r.lines.join("\n");
    assert.equal(r.spawn, undefined);
    assert.equal(w.calls(), 1, "only the snapshot runs");
    assert.ok(!text.includes("git worktree remove") && !text.includes("git branch -D"), text);
    const line = r.lines.find((l) => l.startsWith("cleanup: not started"))!;
    assert.ok(line.includes(`worktree ${w.repo} is the main checkout`) && !fwd(line).includes(fwd(sub)), line);
    noRemoveOf(text, w.repo, sub);
    assert.ok(fs.existsSync(w.repo));
  } finally {
    w.cleanup();
  }
});

test("cwd in a subfolder of a linked round worktree: the worktree root is verified, cleaned and named", async () => {
  const w = world();
  try {
    const sub = path.join(w.wt, ".workflow", "sub");
    fs.mkdirSync(sub, { recursive: true });
    const r = await selfFinish(w.deps({ cwd: sub, git: gitIn(sub) }), 7);
    assert.ok(r.spawn, r.lines.join("\n"));
    const line = r.lines.find((l) => l.startsWith("cleanup: worktree "))!;
    assert.ok(fwd(line).includes(fwd(w.wt)) && !fwd(line).includes(fwd(sub)) && line.includes("branch feat"), line);
    r.spawn();
    assert.ok(w.spawned[0].includes(w.wt) || w.spawned[0].some((a) => samePath(a, w.wt)));
    assert.ok(!w.spawned[0].some((a) => a === sub));
    noRemoveOf(r.lines.join("\n"), w.repo);
    const res = await py(w.spawned[0]);
    assert.equal(res.code, 0);
    assert.ok(!fs.existsSync(w.wt) && fs.existsSync(w.repo));
  } finally {
    w.cleanup();
  }
});

test("head ref equal to the base ref in no worktree: no branch delete advice", async () => {
  const w = world();
  try {
    git(w.repo, "checkout", "-q", "--detach");
    const r = await selfFinish(w.deps({ status: async () => ran({ state: "merged", headRefName: "main", baseRef: "main", headSha: w.tip }), git: gitIn(w.repo) }), 7);
    const text = r.lines.join("\n");
    assert.equal(r.spawn, undefined);
    assert.match(text, /not checked out in a worktree/);
    assert.ok(!text.includes("git branch -D") && !text.includes("git worktree remove"), text);
  } finally {
    w.cleanup();
  }
});

test("a cwd in no listed worktree: cleanup refused naming the cwd, no remove command", async () => {
  const w = world();
  try {
    const stray = path.join(w.root, "stray");
    fs.mkdirSync(stray);
    const r = await selfFinish(w.deps({ cwd: stray, git: async (a) => (a[0] === "worktree" ? git(w.repo, ...a) : null) }), 7);
    const text = r.lines.join("\n");
    assert.equal(r.spawn, undefined);
    assert.match(text, /the session cwd .*stray is in no worktree of this repository\); nothing is removed/);
    assert.ok(!text.includes("git worktree remove") && !text.includes("git branch -D"), text);
  } finally {
    w.cleanup();
  }
});

test("parseWorktrees reads the porcelain list (main first) and samePath ignores separators and (Windows) case", () => {
  const list = "worktree /r/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/repo.worktrees/feat\nHEAD def\nbranch refs/heads/feat\n\nworktree /r/det\nHEAD 123\ndetached\n";
  assert.deepEqual(parseWorktrees(list), [{ path: "/r/repo", branch: "main" }, { path: "/r/repo.worktrees/feat", branch: "feat" }, { path: "/r/det", branch: null }]);
  assert.deepEqual(parseWorktrees(null), []);
  const here = fs.realpathSync.native(os.tmpdir());
  assert.ok(samePath(here, here + path.sep));
  if (process.platform === "win32") assert.ok(samePath(here.replace(/\\/g, "/").toUpperCase(), here.toLowerCase()));
});
