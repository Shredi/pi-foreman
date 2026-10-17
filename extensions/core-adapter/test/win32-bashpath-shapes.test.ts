// r9 item 2: the Windows CI fixtures (ids 136, 338, 611, 1168, 1177, 1185, 1373, 1376, 1533) put an unquoted native path into a
// child bash line, which Git Bash runs drive-relative (`C:\w\proj` -> `C:wproj`), so the win32 ambiguity rule asks or denies.
// The fixtures now spell the path with bashPath() (`C:/w/proj`). This file proves both halves on any host: the forward-slash
// line of each shape gets the plain verdict, the unquoted native line still asks (read) or is denied (child write target).
// Simulated win32 (injected platform, path.win32 world, no file system); each test is named by its literal shell line.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";
import { bashPath } from "./_bashpath.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;

const wHome = "C:\\Profiles\\u";
const wAg = path.win32.join(wHome, ".pi", "agent");
const wCwd = "C:\\w\\proj";
const wScratch = "C:\\t\\pfs\\s1";
const wRules = buildOverlayRules(baseline, {}, {}, wAg, "C:\\pkg", undefined, false);
const wctx = (role: "main" | "child"): MatchCtx => ({ cwd: wCwd, home: wHome, platform: "win32", role, scratch: wScratch, exists: () => false, isDir: () => false, realpath: () => null, list: () => [] });
const wsh = (role: "main" | "child", command: string): string => checkToolCall(wRules, "bash", { command }, wctx(role))?.kind ?? "pass";
const fwd = (p: string): string => bashPath(p, "win32");

test("bashPath(\"C:\\\\w\\\\proj\", \"win32\") is C:/w/proj; off win32 the path is unchanged", () => {
  assert.equal(fwd(wCwd), "C:/w/proj");
  assert.equal(bashPath("/w/proj", "linux"), "/w/proj");
  assert.equal(bashPath(wCwd, "darwin"), wCwd, "no rewrite off win32");
});

test("win32 child: ls C:/w/proj/node_modules | wc -l (row 6-11 shape, id 1168)", () => {
  assert.equal(wsh("child", `ls ${fwd(wCwd)}/node_modules | wc -l`), "pass");
  assert.equal(wsh("child", `ls ${wCwd}/node_modules | wc -l`), "ask", "the unquoted native form still asks");
});

test("win32 child: ls -la C:/Profiles/u/.pi (agent dir parent read, id 1533)", () => {
  const dotPi = path.win32.join(wHome, ".pi");
  assert.equal(wsh("child", `ls -la ${fwd(dotPi)}`), "pass");
  assert.equal(wsh("child", `ls -la ${dotPi}`), "ask", "the unquoted native form still asks");
});

test("win32 child: node C:/t/pfs/s1/probe/probe.mjs > C:/t/pfs/s1/out.log 2>&1 (own scratch, ids 136, 1177)", () => {
  assert.equal(wsh("child", `node ${fwd(wScratch)}/probe/probe.mjs > ${fwd(wScratch)}/out.log 2>&1`), "pass");
  assert.equal(wsh("child", `node ${wScratch}/probe/probe.mjs > ${wScratch}/out.log 2>&1`), "deny", "an unquoted native write target stays denied");
});

test("win32 child: echo x > C:/w/proj/sub/f.txt (own worktree write, id 1185)", () => {
  assert.notEqual(wsh("child", `echo x > ${fwd(path.win32.join(wCwd, "sub", "f.txt"))}`), "deny");
  assert.equal(wsh("child", `echo x > ${path.win32.join(wCwd, "sub", "f.txt")}`), "deny", "an unquoted native write target stays denied");
});

test("win32 child: git -C C:/w/proj grep -nE \"x\" -- src (git grep -C operand, id 611)", () => {
  assert.equal(wsh("child", `git -C ${fwd(wCwd)} grep -nE "x" -- src`), "pass");
  assert.equal(wsh("child", `git -C ${wCwd} grep -nE "x" -- src`), "ask", "the unquoted native -C operand still asks");
});

test("win32 child: real ambiguity is unchanged (cat a\\\\b, > C:x, H=C:\\w; cat $H/f)", () => {
  assert.equal(wsh("child", String.raw`cat a\\b`), "ask");
  assert.equal(wsh("child", "echo x > C:x"), "deny");
  assert.equal(wsh("child", "H=C:\\w; cat $H/f"), "ask");
  assert.equal(wsh("main", "H=C:\\w; cat $H/f"), "ask");
});
