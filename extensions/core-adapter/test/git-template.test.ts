// The git template helper (_git-template.ts): a copy is independent, its git paths name the copy, and a path the copy cannot relink fails the copy.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { BARE_ORIGIN_OFF, gitTemplate } from "./_git-template.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

// the copies and the template share one parent dir, made on first use and removed after the file's tests
let parent: string | undefined;
const parentDir = (): string => (parent ??= mkTestTmp("pf-git-template-"));
after(() => {
  if (parent) rmTestTmp(parent);
});

const git = (cwd: string, ...a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd, encoding: "utf8" }).trim();
const fwd = (p: string): string => p.replace(/\\/g, "/");
/** Whether git in `cwd` has the commit `sha` (a miss is quiet, not an error). */
const hasCommit = (cwd: string, sha: string): boolean => spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd, stdio: "ignore" }).status === 0;

/** A bare origin, a clone `repo` on main with one commit pushed, and a worktree `repo.worktrees/feat`; returns the template root. */
function build(root: string): string {
  const origin = path.join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  for (const [k, v] of BARE_ORIGIN_OFF) git(root, "--git-dir", origin, "config", k, v);
  git(root, "clone", "-q", origin, "repo");
  const repo = path.join(root, "repo");
  git(repo, "checkout", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "README"), "x\n");
  git(repo, "add", "README");
  git(repo, "commit", "-q", "-m", "init");
  // the harness sets url.invalid-push:.pushInsteadOf for every URL; the origin keeps its path
  git(repo, "-c", `url.${origin}.pushInsteadOf=${origin}`, "push", "-q", "-u", "origin", "main");
  git(repo, "worktree", "add", "-q", "-b", "feat", path.join(root, "repo.worktrees", "feat"));
  return root;
}

const t = gitTemplate(parentDir, build);

test("copies are independent: a commit in one copy reaches neither the other copy nor the template", () => {
  const a = t.copy();
  const b = t.copy();
  const ra = path.join(a.root, "repo");
  fs.writeFileSync(path.join(ra, "new.txt"), "a\n");
  git(ra, "add", "new.txt");
  git(ra, "commit", "-q", "-m", "only in a");
  const sha = git(ra, "rev-parse", "HEAD");
  assert.equal(hasCommit(path.join(a.root, "repo"), sha), true);
  assert.equal(hasCommit(path.join(b.root, "repo"), sha), false);
  assert.equal(hasCommit(path.join(a.built, "repo"), sha), false);
});

test("the remote url and the worktree link point into the copy", () => {
  const c = t.copy();
  assert.equal(fwd(git(path.join(c.root, "repo"), "config", "--get", "remote.origin.url")), fwd(path.join(c.root, "origin.git")));
  const link = fs.readFileSync(path.join(c.root, "repo.worktrees", "feat", ".git"), "utf8");
  assert.ok(link.includes(fwd(path.join(c.root, "repo"))), link);
  assert.ok(!link.includes(path.basename(c.built)), link);
});

test("git worktree list in the copy names the copy's paths", () => {
  const c = t.copy();
  const list = git(path.join(c.root, "repo"), "worktree", "list", "--porcelain").split("\n").map(fwd);
  assert.ok(list.includes(`worktree ${fwd(path.join(c.root, "repo"))}`), list.join("\n"));
  assert.ok(list.includes(`worktree ${fwd(path.join(c.root, "repo.worktrees", "feat"))}`), list.join("\n"));
  assert.ok(!list.some((l) => l.includes(path.basename(c.built))), list.join("\n"));
});

test("a copy's files get their own mtimes, not the template's", () => {
  const tplRoot = t.copy().built;
  const old = new Date("2001-01-01T00:00:00Z");
  fs.utimesSync(path.join(tplRoot, "repo", "README"), old, old);
  const c = t.copy();
  const mtime = fs.statSync(path.join(c.root, "repo", "README")).mtimeMs;
  assert.ok(Date.now() - mtime < 60_000, `copy README mtime ${new Date(mtime).toISOString()}`);
});

test("a work-tree file that still names the template makes the copy throw, and leaves no copy behind", () => {
  const bad = gitTemplate(parentDir, (root) => {
    build(root);
    fs.writeFileSync(path.join(root, "repo", "notes.txt"), `see ${root}\n`);
    return root;
  });
  const copiesBefore = fs.readdirSync(parentDir()).filter((n) => n.startsWith("pf-git-copy-")).sort();
  assert.throws(() => bad.copy(), /notes\.txt still names the template/);
  assert.deepEqual(fs.readdirSync(parentDir()).filter((n) => n.startsWith("pf-git-copy-")).sort(), copiesBefore);
});

test("a template built by clone then fetch copies without a throw: its logs and FETCH_HEAD are not checked, and the copy's remote url is rewritten", () => {
  const fetched = gitTemplate(parentDir, (root) => {
    const origin = path.join(root, "origin.git");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    for (const [k, v] of BARE_ORIGIN_OFF) git(root, "--git-dir", origin, "config", k, v);
    git(root, "clone", "-q", origin, "seed");
    const seed = path.join(root, "seed");
    git(seed, "checkout", "-q", "-b", "main");
    fs.writeFileSync(path.join(seed, "README"), "x\n");
    git(seed, "add", "README");
    git(seed, "commit", "-q", "-m", "init");
    git(seed, "-c", `url.${origin}.pushInsteadOf=${origin}`, "push", "-q", "origin", "main");
    git(root, "clone", "-q", origin, "src");
    // a fetch writes the source path into FETCH_HEAD, and the clone and fetch write it into logs/
    git(path.join(root, "src"), "fetch", "-q", "origin");
    return root;
  });
  const c = fetched.copy();
  assert.equal(fwd(git(path.join(c.root, "src"), "config", "--get", "remote.origin.url")), fwd(path.join(c.root, "origin.git")));
});

test("the template and the copies share the caller's parent dir", () => {
  const c = t.copy();
  const dir = fs.realpathSync.native(parentDir());
  assert.equal(path.dirname(c.root), dir);
  assert.equal(path.dirname(c.built), dir);
});

test("dispose removes the template and the copies", () => {
  const d = gitTemplate(parentDir, build);
  const c = d.copy();
  d.dispose();
  assert.equal(fs.existsSync(c.root), false);
  assert.equal(fs.existsSync(c.built), false);
});
