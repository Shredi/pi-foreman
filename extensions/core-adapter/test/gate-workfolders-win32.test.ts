// PR5 work folders on win32 spellings, run on every OS: the fixtures are built with path.win32 and the platform param is "win32", so the
// win32 branch of segmentAlias, rootHolds, folderProtected and workFolderOf is exercised here. The CI temp base is an 8.3 name (`RUNNER~1`):
// it must not read as a `.git` alias, or every path under it would be protected. realpath is injected as null (lexical only).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { folderProtected, rootHolds, workFolderOf } from "../pathrules.ts";
import type { GateRoots } from "../pathrules.ts";

const w = path.win32;
const base = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\pf-wf-AbC123";
const work = w.join(base, "work");
const all = w.join(base, "all");
const noReal = (): null => null;
const roots = (o: Partial<GateRoots> = {}): GateRoots => ({
  worktree: w.join(base, "wt"), scratch: [], tmp: [], owned: [], install: [w.join(all, "pi")], roundFlow: [], handoffs: [],
  child: false, role: "foreman", tmpAccess: true, agentDir: w.join(all, "agent"), pkgRoot: w.join(all, "pkg"),
  workFolders: [{ path: work, mode: "auto" }], realpath: noReal, ...o,
});

test("win32 .git and .pi aliases: case, trailing dot or space and 8.3 short name count; another 8.3 name (the CI temp base `RUNNER~1`) does not", () => {
  const protectedAt = (seg: string): boolean => folderProtected(roots(), "win32", w.join(work, "repo", seg, "x"));
  assert.equal(protectedAt(".GIT"), true);
  assert.equal(protectedAt(".git."), true);
  assert.equal(protectedAt(".git "), true);
  assert.equal(protectedAt("GIT~1"), true);
  assert.equal(protectedAt("GIT~12"), true);
  assert.equal(protectedAt("PI~1"), true);
  assert.equal(protectedAt("RUNNER~1"), false);
  assert.equal(protectedAt("PROGRA~1"), false);
  assert.equal(protectedAt("GITHUB~1"), false);
  assert.equal(protectedAt("src."), false);
});

test("win32 paths: a work folder under an 8.3 temp base is a folder, its sources are writable in auto", () => {
  const r = roots();
  assert.equal(rootHolds(work, w.join(work, "repo", "src", "n.ts"), "win32", noReal), true);
  assert.equal(folderProtected(r, "win32", w.join(work, "repo", "src", "n.ts")), false);
  assert.equal(workFolderOf(r, "win32", w.join(work, "repo", "src", "n.ts"))?.mode, "auto");
  assert.equal(workFolderOf(r, "win32", w.join(work, "x.txt"))?.mode, "auto");
});

test("win32 protected places in a folder stay protected under an 8.3 temp base", () => {
  const r = roots();
  for (const p of [
    w.join(work, "repo", ".git", "config"),
    w.join(work, "repo", ".GIT", "hooks", "x"),
    w.join(work, "repo", "GIT~1", "HEAD"),
    w.join(work, "repo", ".pi", "extensions", "x.ts"),
    w.join(all, "pkg", "extensions", "core-adapter", "gate.ts"),
  ]) {
    assert.equal(folderProtected(r, "win32", p), true, p);
    assert.equal(workFolderOf(r, "win32", p), undefined, p);
  }
});

test("win32 .pi/scratch and .pi/tasks stay writable in a folder; the drive letter and the separators may differ in case", () => {
  const r = roots();
  assert.equal(folderProtected(r, "win32", w.join(work, "repo", ".pi", "scratch", "n")), false);
  assert.equal(folderProtected(r, "win32", w.join(work, "repo", ".pi", "tasks", "n")), false);
  assert.equal(folderProtected(r, "win32", w.join(work, "repo", ".pi", "SCRATCH", "n")), false);
  // the same folder spelled with a lower-case drive and forward slashes
  const lower = "c:" + w.join(work, "repo", "src", "n.ts").slice(2).replace(/\\/g, "/");
  assert.equal(workFolderOf(r, "win32", lower)?.mode, "auto");
  assert.equal(folderProtected(r, "win32", lower), false);
  assert.equal(workFolderOf(roots({ workFolders: [{ path: "c:" + work.slice(2).replace(/\\/g, "/"), mode: "auto" }] }), "win32", w.join(work, "x.txt"))?.mode, "auto");
});
