// Relative core.hooksPath: one hooks dir id per configured value, hook files compared per worktree top.
// Real git, temp dirs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { GitDriftWatch, deserializeGitSnapshot, diffGitSnapshots, serializeGitSnapshot, sha, takeGitSnapshot } from "../gitdrift.ts";
import { spawnGit, takeReadonlyState } from "../readonlystate.ts";
import { rmTestTmp } from "./_tmpbase.ts";
import { strRaw } from "../strof.ts";

const HOME = os.tmpdir();
const PRINT = { mode: "print", hasUI: false };
const noTrace = () => undefined;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
function g(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${strRaw(r.stderr)}`);
}
const skip = spawnSync("git", ["--version"]).status === 0 ? false : "no git";

function setup(t: { after(fn: () => void): void }): { primary: string; wt: string; state: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-relhooks-")));
  t.after(() => rmTestTmp(root));
  const primary = path.join(root, "primary");
  fs.mkdirSync(primary);
  g(primary, "init", "-q");
  fs.mkdirSync(path.join(primary, "scripts", "git-hooks"), { recursive: true });
  fs.writeFileSync(path.join(primary, "scripts", "git-hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
  fs.writeFileSync(path.join(primary, "a.txt"), "x\n");
  g(primary, "add", ".");
  g(primary, "commit", "-q", "-m", "init");
  g(primary, "config", "core.hooksPath", "scripts/git-hooks");
  const wt = path.join(root, "wt");
  g(primary, "worktree", "add", "-q", "-b", "feat", wt);
  // a different hook file content in the worktree checkout
  fs.writeFileSync(path.join(wt, "scripts", "git-hooks", "pre-commit"), "#!/bin/sh\nexit 0 # wt\n");
  const state = path.join(root, "state");
  fs.mkdirSync(state);
  return { primary, wt, state };
}

const gate = (w: GitDriftWatch, cwd: string) => w.gate(cwd, HOME, "git", PRINT, noTrace);

test("relative hooksPath: bind in primary, gate in worktree, gate in primary: no drift", { skip }, async (t) => {
  const { primary, wt, state } = setup(t);
  const w = new GitDriftWatch();
  assert.deepEqual(w.bind(state, primary, HOME), []);
  assert.equal(await gate(w, wt), undefined);
  w.snapshot(wt, HOME);
  assert.equal(await gate(w, primary), undefined);
  w.snapshot(primary, HOME);
  assert.equal(await gate(w, wt), undefined);
  // a new session binds from the saved file in the other checkout
  const w2 = new GitDriftWatch();
  assert.deepEqual(w2.bind(state, wt, HOME), []);
});

test("relative hooksPath: the id is the same from both checkouts", { skip }, (t) => {
  const { primary, wt } = setup(t);
  assert.equal(takeGitSnapshot(primary, HOME)!.hooksDirId, takeGitSnapshot(wt, HOME)!.hooksDirId);
  assert.equal(takeGitSnapshot(primary, HOME)!.hooksDirId, sha("rel\0scripts/git-hooks"));
});

test("relative hooksPath: a changed core.hooksPath is still named", { skip }, async (t) => {
  const { primary, wt, state } = setup(t);
  const w = new GitDriftWatch();
  w.bind(state, primary, HOME);
  assert.equal(await gate(w, wt), undefined);
  fs.mkdirSync(path.join(primary, "other-hooks"));
  g(primary, "config", "core.hooksPath", "other-hooks");
  const r = await gate(w, primary);
  assert.ok(r && r.block);
  assert.match(r.reason, /hooks directory changed \(core\.hooksPath\)/);
});

test("relative hooksPath: a hook planted in the primary after the last snapshot was taken in the worktree is named", { skip }, async (t) => {
  const { primary, wt, state } = setup(t);
  const w = new GitDriftWatch();
  w.bind(state, primary, HOME);
  w.snapshot(wt, HOME); // last snapshot in the worktree
  fs.writeFileSync(path.join(primary, "scripts", "git-hooks", "post-checkout"), "#!/bin/sh\necho planted\n");
  const r = await gate(w, primary);
  assert.ok(r && r.block);
  assert.match(r.reason, /hooks: .*post-checkout/);
  assert.doesNotMatch(r.reason, /hooks directory changed/);
});

test("relative hooksPath: a changed hook in a seen checkout is named after a restart too", { skip }, async (t) => {
  const { primary, wt, state } = setup(t);
  const w = new GitDriftWatch();
  w.bind(state, primary, HOME);
  w.snapshot(wt, HOME);
  fs.writeFileSync(path.join(primary, "scripts", "git-hooks", "pre-commit"), "#!/bin/sh\necho planted\n");
  const w2 = new GitDriftWatch();
  const lines = w2.bind(state, wt, HOME);
  assert.deepEqual(lines, []); // the worktree is unchanged
  const r = await gate(w2, primary);
  assert.ok(r && r.block);
  assert.match(r.reason, /hooks: .*pre-commit/);
});

test("relative hooksPath: a stored id from the old formula counts as unchanged", { skip }, (t) => {
  const { primary } = setup(t);
  const now = takeGitSnapshot(primary, HOME)!;
  const old = { files: now.files, hooksDirId: sha(path.join(primary, "scripts", "git-hooks")), hooks: now.hooks };
  assert.deepEqual(diffGitSnapshots(old, takeGitSnapshot(primary, HOME)), []);
  // ... but a hook change since the old snapshot is still named
  fs.writeFileSync(path.join(primary, "scripts", "git-hooks", "pre-push"), "#!/bin/sh\n");
  assert.match(diffGitSnapshots(old, takeGitSnapshot(primary, HOME)).join("\n"), /pre-push/);
});

test("relative hooksPath: an old saved snapshot without the per-top map is not drift", { skip }, (t) => {
  const { primary } = setup(t);
  const now = takeGitSnapshot(primary, HOME)!;
  const saved = serializeGitSnapshot({ files: now.files, hooksDirId: sha(path.join(primary, "scripts", "git-hooks")), hooks: now.hooks }) as Record<string, unknown>;
  assert.equal("relTops" in saved, false);
  const loaded = deserializeGitSnapshot(JSON.parse(JSON.stringify(saved)));
  assert.ok(loaded);
  assert.deepEqual(diffGitSnapshots(loaded, takeGitSnapshot(primary, HOME)), []);
});

test("relative hooksPath: tops of removed worktrees are dropped from the saved map", { skip }, async (t) => {
  const { primary, wt, state } = setup(t);
  const w = new GitDriftWatch();
  w.bind(state, primary, HOME);
  w.snapshot(wt, HOME);
  assert.equal(w.snap!.relTops!.size, 2);
  g(primary, "worktree", "remove", "--force", wt);
  w.snapshot(primary, HOME);
  assert.deepEqual([...w.snap!.relTops!.keys()], [primary]);
});

test("readonlystate: a relative hooks path from two worktree roots gives one id", { skip }, async (t) => {
  const { primary, wt } = setup(t);
  const a = await takeReadonlyState(primary, HOME, spawnGit);
  const b = await takeReadonlyState(wt, HOME, spawnGit);
  assert.ok(a !== "unreadable" && b !== "unreadable");
  assert.equal(a.settings.hooksDirId, b.settings.hooksDirId);
  assert.equal(a.settings.hooksDirId, sha("rel\0scripts/git-hooks"));
});
