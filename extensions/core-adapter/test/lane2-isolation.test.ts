// R6 lane 2, items 2-0 and 2-I: directory operands of a probe run (node/python/bash/sh/npx) are scanned file by file inside the round roots and
// denied outside them; a child's own nested isolation worktree is its owned root (innermost git worktree), a sibling's is not. Evil file
// content is built here from the strings of tests/fixtures/split-literal-cases.json, never stored.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import { childSurface } from "../roundsurface.ts";
import { rmTestTmp } from "./_tmpbase.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const CASES = JSON.parse(fs.readFileSync(path.join(pkgRoot, "tests", "fixtures", "split-literal-cases.json"), "utf8")) as { probeDeny: string[] };
const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-lane2-")));
after(() => rmTestTmp(base));

const git = (cwd: string, ...a: string[]): void => void execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { stdio: "ignore" });
const main = path.join(base, "repo");
const rt = path.join(base, "repo.worktrees", "round");
const isoDir = path.join(base, "repo.worktrees", "worktrees", "round");
const isoOwn = path.join(isoDir, "pi-worktree-r1-s0-0");
const isoSibling = path.join(isoDir, "pi-worktree-r1-s0-1");
const scratch = path.join(base, "scratch");
const testDir = "extensions/core-adapter/test";
if (posix) {
  fs.mkdirSync(main, { recursive: true });
  fs.mkdirSync(scratch, { recursive: true });
  git(main, "init", "-q", "-b", "main");
  fs.mkdirSync(path.join(main, testDir), { recursive: true });
  fs.writeFileSync(path.join(main, testDir, "a.test.ts"), "// a\n");
  fs.writeFileSync(path.join(main, "f.txt"), "f\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  git(main, "worktree", "add", "-q", "-b", "round", rt);
  git(rt, "worktree", "add", "-q", "-b", "iso-own", isoOwn);
  git(rt, "worktree", "add", "-q", "-b", "iso-sibling", isoSibling);
}
const r = buildOverlayRules(baseline, {}, {}, path.join(base, "agent"), pkgRoot, undefined, false);
const run = (command: string, role: string, cwd: string): string => {
  const s = childSurface([rt], cwd, role, process.platform);
  return checkToolCall(r, "bash", { command }, { cwd, home: base, platform: process.platform, role: "child", scratch, roundRoots: s.write, roundReadRoots: s.read })?.kind ?? "pass";
};

test("2-0: a directory operand is scanned file by file inside the round roots, denied outside them", { skip: !posix }, () => {
  const file = path.join(rt, testDir, "a.test.ts");
  const cmd = `node --test ${testDir}/`;
  try {
    assert.equal(run(cmd, "builder", rt), "pass", "clean");
    fs.writeFileSync(file, "// edited\nconst ok = 1;\n");
    assert.equal(run(cmd, "builder", rt), "pass", "modified, clean content");
    fs.writeFileSync(file, CASES.probeDeny[0] + "\n");
    assert.equal(run(cmd, "builder", rt), "deny", "modified file reassembles a token");
    assert.equal(run(`node --test ${testDir}`, "reviewer", rt), "deny", "no trailing slash, any role");
    fs.writeFileSync(file, "// a\n");
    assert.equal(run(cmd, "builder", rt), "pass", "restored");
    fs.writeFileSync(path.join(rt, testDir, "new.test.ts"), CASES.probeDeny[0] + "\n");
    assert.equal(run(cmd, "builder", rt), "deny", "untracked file reassembles a token");
  } finally {
    fs.rmSync(path.join(rt, testDir, "new.test.ts"), { force: true });
    fs.writeFileSync(file, "// a\n");
  }
  fs.mkdirSync(path.join(scratch, "pkg"), { recursive: true });
  fs.writeFileSync(path.join(scratch, "pkg", "index.js"), "console.log(1);\n");
  for (const role of ["builder", "reviewer"]) {
    assert.equal(run(`node --test ${scratch}/pkg`, role, rt), "deny", `${role} scratch dir`);
    assert.equal(run("node --test $FOREMAN_SCRATCH", role, rt), "deny", `${role} $FOREMAN_SCRATCH`);
  }
});

test("2-0: the own isolation worktree counts as the child's own worktree for the directory scan", { skip: !posix }, () => {
  const file = path.join(isoOwn, testDir, "a.test.ts");
  try {
    assert.equal(run(`node --test ${testDir}/`, "builder", isoOwn), "pass");
    fs.writeFileSync(file, CASES.probeDeny[0] + "\n");
    assert.equal(run(`node --test ${testDir}/`, "builder", isoOwn), "deny");
  } finally {
    fs.writeFileSync(file, "// a\n");
  }
});

test("2-I: a builder's git add / commit inside its own nested isolation worktree is allowed", { skip: !posix }, () => {
  for (const cmd of ["git add f.txt", "git commit -m x", "git add f.txt && git commit -m x", `git -C ${isoOwn} commit -m x`, "git status", `touch ${isoOwn}/new.txt`, "echo x > new.txt"]) {
    assert.equal(run(cmd, "builder", isoOwn), "pass", cmd);
  }
});

test("2-I: a sibling's isolation worktree and the round worktree stay denied", { skip: !posix }, () => {
  for (const cmd of [`git -C ${isoSibling} commit -m x`, `touch ${isoSibling}/x.txt`, `git -C ${rt} commit -m x`, `touch ${rt}/x.txt`]) {
    assert.equal(run(cmd, "builder", isoOwn), "deny", cmd);
  }
  // a child that is not the round worktree's builder: read-only there
  for (const cmd of ["git add f.txt", "git commit -m x", "touch x.txt"]) assert.equal(run(cmd, "reviewer", rt), "deny", cmd);
  assert.equal(run("git add f.txt", "builder", rt), "pass", "the builder of the round worktree writes it");
});

// an isolation worktree nested below the round worktree path: ownership is the innermost git worktree, not a prefix match on the round worktree
test("2-I: a nested isolation worktree below the round worktree is its child's own root, whatever the role", { skip: !posix }, () => {
  const nested = path.join(rt, ".iso", "pi-worktree-r2-s0-0");
  const nestedSibling = path.join(rt, ".iso", "pi-worktree-r2-s0-1");
  git(rt, "worktree", "add", "-q", "-b", "iso-nested", nested);
  git(rt, "worktree", "add", "-q", "-b", "iso-nested2", nestedSibling);
  for (const role of ["builder", "worker", "reviewer"]) {
    for (const cmd of ["git add f.txt", "git commit -m x", "touch new.txt", `git -C ${nested} commit -m x`]) assert.equal(run(cmd, role, nested), "pass", `${role}: ${cmd}`);
    for (const cmd of [`git -C ${nestedSibling} commit -m x`, `touch ${nestedSibling}/x.txt`, `touch ${rt}/x.txt`, `git -C ${rt} commit -m x`]) assert.equal(run(cmd, role, nested), "deny", `${role}: ${cmd}`);
  }
  assert.equal(run("touch x.txt", "reviewer", rt), "deny", "a non-builder in the round worktree stays read-only");
});
