// /foreman doctor: linked node_modules in live worktrees; a link into the package root's node_modules is a FAIL (temp dirs only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { linkedNodeModules, worktreeDoctor } from "../registry.ts";
import { rmTestTmp } from "./_tmpbase.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-doctor-lnm-")));
process.on("exit", () => rmTestTmp(tmp));

// git for Windows rejects `\\.\nul` as a config file, so win32 gets an empty file inside this test's tmp dir (as _submodules.ts emptyConfig does)
const emptyConfig = (): string => {
  if (process.platform !== "win32") return os.devNull;
  const f = path.join(tmp, "empty-gitconfig");
  if (!fs.existsSync(f)) fs.writeFileSync(f, "");
  return f;
};
const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig(), GIT_CONFIG_NOSYSTEM: "1" } });
};
const link = (target: string, at: string): void => fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");

// git prints worktree paths with forward slashes (C:/...) on Windows; compare everything in one spelling
const fwd = (s: string): string => s.replace(/\\/g, "/").toLowerCase();
const mentions = (l: string, wt: string): boolean => fwd(l).includes(fwd(wt));
const repo = path.join(tmp, "repo");
const pkgRoot = path.join(tmp, "pkg");
const agent = path.join(tmp, "agent");
fs.mkdirSync(path.join(pkgRoot, "node_modules", "dep"), { recursive: true });
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README"), "x\n");
git(repo, "init", "-q");
git(repo, "add", "README");
git(repo, "commit", "-q", "-m", "init");
const wtree = (name: string): string => {
  const dir = path.join(tmp, "repo.worktrees", name);
  git(repo, "worktree", "add", "-q", "-b", name, dir);
  return dir;
};
// POSIX hook line is irrelevant here; platform win32 skips it
const doctor = (root?: string): string[] => worktreeDoctor(agent, repo, "win32", root);

test("linked: a link into the package root's node_modules is a FAIL with the fix", () => {
  const wt = wtree("intopkg");
  link(path.join(pkgRoot, "node_modules"), path.join(wt, "node_modules"));
  const lines = doctor(pkgRoot).filter((l) => mentions(l, wt));
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /^FAIL node_modules in .* resolves into the package root's node_modules/);
  assert.ok(lines[0].includes(fs.realpathSync(path.join(pkgRoot, "node_modules"))));
  assert.match(lines[0], /empties pi-foreman's own modules/);
  assert.match(lines[0], /fix: remove the link in that worktree \(POSIX: rm node_modules; Windows: rmdir node_modules\), then run npm ci there/);
  assert.deepEqual(linkedNodeModules(repo).filter((e) => fwd(e.worktree) === fwd(wt)).map((e) => ({ ...e, worktree: fwd(e.worktree) })), [{ worktree: fwd(wt), target: fs.realpathSync(path.join(pkgRoot, "node_modules")), link: true }]);
  // no package root given: no FAIL, the symlink WARN stays
  const noRoot = doctor().filter((l) => mentions(l, wt));
  assert.deepEqual(noRoot.map((l) => l.slice(0, 5)), ["WARN "]);
});

test("linked: a link to another worktree's node_modules is a WARN, not a FAIL", () => {
  const a = wtree("owner");
  const b = wtree("borrower");
  fs.mkdirSync(path.join(a, "node_modules"));
  link(path.join(a, "node_modules"), path.join(b, "node_modules"));
  const lines = doctor(pkgRoot);
  assert.ok(lines.some((l) => l.startsWith("WARN node_modules is a symlink in ") && mentions(l, b)), lines.join("\n"));
  assert.equal(lines.some((l) => l.startsWith("FAIL") && mentions(l, b)), false);
  assert.equal(lines.some((l) => mentions(l, a)), false, "a real node_modules inside its worktree is clean");
});

test("linked: a dangling link is a WARN naming it", () => {
  const wt = wtree("dangling");
  link(path.join(tmp, "does-not-exist"), path.join(wt, "node_modules"));
  assert.deepEqual(linkedNodeModules(repo).filter((e) => fwd(e.worktree) === fwd(wt)).map((e) => ({ ...e, worktree: fwd(e.worktree) })), [{ worktree: fwd(wt), target: null, link: true }]);
  const lines = doctor(pkgRoot).filter((l) => mentions(l, wt));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^WARN .*dangling/);
});

test("linked: a relative link target into the package root is a FAIL", { skip: process.platform === "win32" }, () => {
  const wt = wtree("relative");
  fs.symlinkSync(path.relative(wt, path.join(pkgRoot, "node_modules")), path.join(wt, "node_modules"), "dir");
  const lines = doctor(pkgRoot).filter((l) => mentions(l, wt));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^FAIL /);
});

test("linked: outside a git repository nothing is reported", () => {
  assert.deepEqual(linkedNodeModules(agent), []);
  assert.deepEqual(worktreeDoctor(agent, agent, "win32", pkgRoot), []);
});
