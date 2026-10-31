// r79 item 16: pathnorm.ts is the one normaliser (slash and case rules); rules, floors (insideRoot) and effects (contained) call it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { comparable, foldCase, lexUnder, normPath, sameOrUnder, slashForm } from "../pathnorm.ts";
import type { Resolver } from "../pathnorm.ts";
import { insideRoot } from "../floors.ts";
import { matchRules } from "../rules.ts";
import { parseRule } from "../rules.ts";

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

test("rule path patterns use the same spellings: win32 case and slashes meet, drive letters via //c:/", () => {
  const env = { cwd: "C:\\Repo", home: "C:\\Users\\Me", platform: "win32", checkout: "C:\\Repo" };
  const rule = (t: string) => {
    const r = parseRule(t);
    if ("error" in r) throw new Error(r.error);
    return r.rule;
  };
  const read = (p: string) => ({ tool: "read", paths: [p] });
  const sets = (t: string) => ({ deny: [], ask: [], allow: [rule(t)] });
  assert.equal(matchRules(sets("Read(src/**)"), read("c:\\REPO\\Src\\a.ts"), env).verdict, "allow");
  assert.equal(matchRules(sets("Read(~/notes/*)"), read("C:\\users\\me\\NOTES\\a.md"), env).verdict, "allow");
  assert.equal(matchRules(sets("Read(//c:/data/**)"), read("C:\\Data\\x\\y"), env).verdict, "allow");
  assert.equal(matchRules(sets("Read(src/**)"), read("C:\\Repo2\\src\\a.ts"), env).verdict, "none");
  const posix = { cwd: "/Repo", home: "/Users/me", platform: "darwin", checkout: "/Repo" };
  assert.equal(matchRules(sets("Read(src/**)"), read("/Repo/src/a.ts"), posix).verdict, "allow");
  assert.equal(matchRules(sets("Read(src/**)"), read("/repo/src/a.ts"), posix).verdict, "none", "darwin is not folded");
});
