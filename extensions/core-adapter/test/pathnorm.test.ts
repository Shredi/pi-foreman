// r79 item 16: pathnorm.ts is the one normaliser (slash and case rules); rules, floors (insideRoot) and effects (contained) call it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { comparable, foldCase, lexUnder, normPath, sameOrUnder, slashForm } from "../pathnorm.ts";
import type { Resolver } from "../pathnorm.ts";
import { insideRoot } from "../floors.ts";
import { pathGlobMatch } from "../rulecall.ts";

test("slashForm: win32 spellings (drive letters, backslashes, mixed, UNC, trailing separators)", () => {
  assert.equal(slashForm("win32", "C:\\Users\\Me\\"), "C:/Users/Me");
  assert.equal(slashForm("win32", "C:/a\\b//c"), "C:/a/b/c");
  assert.equal(slashForm("win32", "C:\\"), "C:/");
  assert.equal(slashForm("win32", "C:/"), "C:/");
  assert.equal(slashForm("win32", "\\\\host\\share\\x"), "//host/share/x");
  assert.equal(slashForm("win32", "\\"), "/");
  assert.equal(slashForm("win32", "/"), "/");
});

test("slashForm: POSIX keeps a backslash as a name character and collapses runs of /", () => {
  assert.equal(slashForm("linux", "/a\\b//c/"), "/a\\b/c");
  assert.equal(slashForm("darwin", "//a///b"), "/a/b");
  assert.equal(slashForm("linux", "/"), "/");
});

test("foldCase: lower case on win32 only (darwin is no longer folded)", () => {
  assert.equal(foldCase("win32", "C:/Users/ME"), "c:/users/me");
  assert.equal(foldCase("darwin", "/Users/ME"), "/Users/ME");
  assert.equal(foldCase("linux", "/Users/ME"), "/Users/ME");
  assert.equal(comparable("win32", "C:\\Users\\ME\\"), "c:/users/me");
  assert.equal(comparable("darwin", "/Users/ME/"), "/Users/ME");
});

test("lexUnder: win32 drive, case and separator spellings meet; sibling prefixes do not", () => {
  assert.ok(lexUnder("win32", "C:\\Repo", "c:/repo/src/a.ts"));
  assert.ok(lexUnder("win32", "c:/REPO/", "C:\\Repo"));
  assert.ok(lexUnder("win32", "C:\\", "C:\\anything\\here"));
  assert.ok(!lexUnder("win32", "C:\\Repo", "C:\\Repo2\\a.ts"));
  assert.ok(!lexUnder("win32", "C:\\Repo", "D:\\Repo\\a.ts"));
  assert.ok(!lexUnder("win32", "C:\\Repo\\src", "C:\\Repo"));
  assert.ok(lexUnder("linux", "/repo", "/repo/a"));
  assert.ok(lexUnder("linux", "/", "/etc"));
  assert.ok(!lexUnder("linux", "/Repo", "/repo/a"), "POSIX is case-sensitive");
  assert.ok(!lexUnder("darwin", "/Repo", "/repo/a"), "darwin is compared as spelled");
  assert.ok(!lexUnder("linux", "/repo", "/repo2/a"));
});

test("normPath and sameOrUnder with a stub resolver: 8.3 names, drive-less roots, case", () => {
  const real: Resolver = (p) => (p.toLowerCase().startsWith("c:\\users\\runner~1") ? p.replace(/runner~1/i, "runneradmin") : /^c:\\(?:work|tmp)?$/i.test(p) || p.toLowerCase().startsWith("c:\\work") ? p : null);
  assert.equal(normPath("win32", "C:\\Users\\RUNNER~1\\x", "C:\\work", real), "c:\\users\\runneradmin\\x");
  assert.equal(normPath("win32", "/tmp", "C:\\work", real), "c:\\tmp");
  assert.ok(sameOrUnder("win32", "C:\\Users\\runneradmin", "c:/users/RUNNER~1/app", "C:\\work", real));
  assert.ok(!sameOrUnder("win32", "C:\\Users\\runneradmin", "c:/users/runneradmin2", "C:\\work", real));
  assert.equal(normPath("linux", "/a/../b", "/x", () => null), "/b");
});

test("floors insideRoot goes through the normaliser", () => {
  assert.ok(insideRoot("C:\\Repo\\src", "c:/repo", "win32"));
  assert.ok(insideRoot("c:/REPO/SRC/a", "C:\\Repo\\", "win32"));
  assert.ok(!insideRoot("C:\\Repo2", "C:\\Repo", "win32"));
  assert.ok(insideRoot("/repo/a", "/repo", "linux"));
  assert.ok(!insideRoot("/Repo/a", "/repo", "darwin"));
});

test("protected path globs use the same spellings: win32 case and slashes meet, drive letters via //c:/", () => {
  const env = { cwd: "C:\\Repo", home: "C:\\Users\\Me", platform: "win32", checkout: "C:\\Repo" };
  assert.equal(pathGlobMatch("src/**", "c:\\REPO\\Src\\a.ts", env), true);
  assert.equal(pathGlobMatch("~/notes/*", "C:\\users\\me\\NOTES\\a.md", env), true);
  assert.equal(pathGlobMatch("//c:/data/**", "C:\\Data\\x\\y", env), true);
  assert.equal(pathGlobMatch("src/**", "C:\\Repo2\\src\\a.ts", env), false);
  const posix = { cwd: "/Repo", home: "/Users/me", platform: "darwin", checkout: "/Repo" };
  assert.equal(pathGlobMatch("src/**", "/repo/src/a.ts", posix), true, "darwin folds case like the floors (r79 revision, finding I)");
  assert.equal(pathGlobMatch("src/**", "/repo/src/a.ts", { ...posix, platform: "linux" }), false, "linux is not folded");
});
