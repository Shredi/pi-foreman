// rulecall.ts: the call view (normaliseSegment, ruleCallOf), the path glob of a protected entry (pathGlobMatch) and the built-in allow of a call (builtinAllow).
import { test } from "node:test";
import assert from "node:assert/strict";
import { builtinAllow, normaliseSegment, pathGlobMatch, ruleCallOf } from "../rulecall.ts";
import type { RuleCall } from "../rulecall.ts";
import { parseShell } from "../shellast.ts";

const env = { cwd: "/co/wt", home: "/home/me", platform: "linux", checkout: "/co" };
const sh = (line: string): RuleCall => ruleCallOf("bash", { command: line }, { cwd: "/co/wt", home: "/home/me", platform: "linux", segments: parseShell(line) });

test("pathGlobMatch: ~, //, relative-to-checkout, ** and *", () => {
  assert.equal(pathGlobMatch("~/notes/**", "/home/me/notes/a/b.md", env), true);
  assert.equal(pathGlobMatch("~/notes/*", "/home/me/notes/a/b.md", env), false);
  assert.equal(pathGlobMatch("//etc/hosts", "/etc/hosts", env), true);
  assert.equal(pathGlobMatch("src/**", "/co/src/a.ts", env), true);
  assert.equal(pathGlobMatch("src/**", "/co/wt/src/a.ts", env), false, "relative patterns resolve against the main checkout");
  assert.equal(pathGlobMatch("a?c", "/co/abc", env), true);
});

test("pathGlobMatch folds case like the floors: win32 and darwin fold, linux compares as spelled", () => {
  const win = { cwd: "C:\\Repo", home: "C:\\Users\\Me", platform: "win32", checkout: "C:\\Repo" };
  assert.equal(pathGlobMatch("src/**", "c:\\REPO\\Src\\a.ts", win), true);
  assert.equal(pathGlobMatch("~/notes/*", "C:\\users\\me\\NOTES\\a.md", win), true);
  assert.equal(pathGlobMatch("//c:/data/**", "C:\\Data\\x\\y", win), true);
  assert.equal(pathGlobMatch("src/**", "C:\\Repo2\\src\\a.ts", win), false);
  const posix = { cwd: "/Repo", home: "/Users/me", platform: "darwin", checkout: "/Repo" };
  assert.equal(pathGlobMatch("src/**", "/Repo/src/a.ts", posix), true);
  assert.equal(pathGlobMatch("src/**", "/repo/src/a.ts", posix), true, "darwin folds case");
  assert.equal(pathGlobMatch("src/**", "/repo/src/a.ts", { ...posix, platform: "linux" }), false, "linux is not folded");
  assert.equal(pathGlobMatch("~/Notes/**", "/Users/me/notes2/a.md", posix), false, "no widening to a sibling name");
});

test("normaliseSegment: single spaces, quotes stripped, win32 drops .exe and case", () => {
  const [a] = parseShell("git   commit -m 'a b'");
  assert.equal(normaliseSegment(a, "linux"), "git commit -m a b");
  const [b] = parseShell("GIT.EXE status");
  assert.equal(normaliseSegment(b, "win32"), "git status");
});

test("builtinAllow: every unit must be covered, the names are joined with +, an opaque unit is asked as opaque", () => {
  const names = (m: Record<number, string>) => (i: number) => m[i] ?? null;
  assert.equal(builtinAllow(sh("ls && pwd"), names({ 0: "default-ls", 1: "default-pwd" })), "default-ls+default-pwd");
  assert.equal(builtinAllow(sh("ls && pwd"), names({ 0: "default-ls" })), null);
  assert.equal(builtinAllow(sh("ls && ls -la"), names({ 0: "default-ls", 1: "default-ls" })), "default-ls");
  assert.equal(builtinAllow({ tool: "bash", segments: [{ text: "echo $(x)", opaque: true, writesRedirect: false }] }, (_i, opaque) => (opaque ? "opaque-seen" : null)), "opaque-seen");
  assert.equal(builtinAllow({ tool: "bash", segments: [] }, () => "x"), null);
  assert.equal(builtinAllow({ tool: "read", paths: ["/a", "/b"] }, () => "default-read"), "default-read");
  assert.equal(builtinAllow({ tool: "mcp__srv__a", payload: "{}" }, () => "p"), "p");
});

test("ruleCallOf: a redirecting segment is marked, the null device is not", () => {
  assert.equal(sh("echo x > out.txt").segments?.[0].writesRedirect, true);
  assert.equal(sh("echo x > /dev/null").segments?.[0].writesRedirect, false);
});

test("ruleCallOf: path tools resolve their paths, a configured read tool uses its field", () => {
  const ctx = { cwd: "/co/wt", home: "/home/me", platform: "linux" };
  assert.deepEqual(ruleCallOf("read", { path: "~/a" }, ctx).paths, ["/home/me/a"]);
  assert.deepEqual(ruleCallOf("write", { path: "x" }, ctx).paths, ["/co/wt/x"]);
  assert.deepEqual(ruleCallOf("foreman_move", { src: "a", dst: "b" }, ctx).paths, ["/co/wt/a", "/co/wt/b"]);
  assert.deepEqual(ruleCallOf("ffgrep", { dir: "d" }, { ...ctx, readTools: { ffgrep: "dir" } }).paths, ["/co/wt/d"]);
  assert.equal(ruleCallOf("ffgrep", { dir: "d" }, ctx).paths, undefined);
});
