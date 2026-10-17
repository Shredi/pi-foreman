// Ledger r8 item 5 (reviewer SECURITY 1/2): Git Bash on Windows runs the posix-unescaped word. An unquoted `C:\\a\\b` is
// `C:\a\b` (win32-absolute: resolves to the native path); an unquoted `C:\a\b` is the drive-relative `C:ab` (stays unresolved).
// On win32 a child's write target that is drive-relative after unescaping, or still holds a `\` without being win32-absolute,
// is denied; a reader given such a word asks; a read through a `$H` whose value was a drive-relative or backslash-bearing
// literal asks. Simulated win32 (injected platform, path.win32 world, no file system); each test is named by its literal shell line.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, parseShell, readBaseline } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";
import { resolveVars } from "../shellvars.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;

const wHome = "C:\\Profiles\\u";
const wAg = path.win32.join(wHome, ".pi", "agent");
const wCwd = "C:\\w\\proj";
const wScratch = "C:\\t\\pfs\\s1";
const wRules = buildOverlayRules(baseline, {}, {}, wAg, "C:\\pkg", undefined, false);
const wctx = (role: "main" | "child", extra: Partial<MatchCtx> = {}): MatchCtx => ({ cwd: wCwd, home: wHome, platform: "win32", role, scratch: wScratch, exists: () => false, isDir: () => false, realpath: () => null, list: () => [], ...extra });
const wsh = (role: "main" | "child", command: string, extra: Partial<MatchCtx> = {}): string => checkToolCall(wRules, "bash", { command }, wctx(role, extra))?.kind ?? "pass";
// a child with a read-only round worktree (reviewer / explorer)
const ro = { roundReadRoots: [wCwd] };

const pHome = "/home/u";
const pCwd = "/w/proj";
const pRules = buildOverlayRules(baseline, {}, {}, path.posix.join(pHome, ".pi", "agent"), "/pkg", undefined, false);
const pctx = (role: "main" | "child", extra: Partial<MatchCtx> = {}): MatchCtx => ({ cwd: pCwd, home: pHome, platform: "linux", role, scratch: "/t/pfs/s1", exists: () => false, isDir: () => false, realpath: () => null, list: () => [], ...extra });
const psh = (role: "main" | "child", command: string, extra: Partial<MatchCtx> = {}): string => checkToolCall(pRules, "bash", { command }, pctx(role, extra))?.kind ?? "pass";

const wEnv = { FOREMAN_SCRATCH: wScratch, PWD: wCwd };
const resolved = (line: string, platform: string): string[] | null => {
  const p = parseShell(line);
  const r = [...resolveVars(p.pipelines, p.seps, wEnv, () => false, line, platform).values()];
  return r.length ? r[r.length - 1] : null;
};

// ---------------------------------------------------------------- SECURITY 1: an escaped unquoted native value resolves

test("win32: H=C:\\\\Profiles\\\\u\\\\.pi\\\\agent\\\\pi-foreman; cat $H/handoffs/s1/ruling.md", () => {
  const line = "H=C:\\\\Profiles\\\\u\\\\.pi\\\\agent\\\\pi-foreman; cat $H/handoffs/s1/ruling.md";
  assert.deepEqual(resolved(line, "win32"), ["cat", "C:\\Profiles\\u\\.pi\\agent\\pi-foreman/handoffs/s1/ruling.md"]);
  assert.equal(wsh("child", line), "deny");
  assert.equal(wsh("child", "cat C:/Profiles/u/.pi/agent/pi-foreman/handoffs/s1/ruling.md"), "deny", "the forward-slash form");
  assert.equal(wsh("child", 'cat "C:\\Profiles\\u\\.pi\\agent\\pi-foreman\\handoffs\\s1\\ruling.md"'), "deny", "the literal native form");
});

test("win32: H=C:\\\\Profiles\\\\u\\\\.ssh; cat $H/id_rsa", () => {
  const line = "H=C:\\\\Profiles\\\\u\\\\.ssh; cat $H/id_rsa";
  assert.deepEqual(resolved(line, "win32"), ["cat", "C:\\Profiles\\u\\.ssh/id_rsa"]);
  for (const role of ["main", "child"] as const) assert.equal(wsh(role, line), "deny", role);
});

test("win32: H=\\\\\\\\srv\\\\share; cat $H/f (an escaped unquoted UNC value resolves)", () => {
  assert.deepEqual(resolved("H=\\\\\\\\srv\\\\share; cat $H/f", "win32"), ["cat", "\\\\srv\\share/f"]);
  assert.deepEqual(resolved("H=C:\\\\; cat $H/f", "win32"), ["cat", "C:\\/f"], "C:\\\\ is the drive root C:\\");
});

test("win32: H=C:x; cat $H/f and H=C:\\a\\b; cat $H/f stay unresolved (drive-relative after unescaping)", () => {
  for (const line of ["H=C:x; cat $H/f", "H=C:\\a\\b; cat $H/f", "H=C:\\\\a\\; cat $H/f", "H=a\\\\b; cat $H/f"]) assert.equal(resolved(line, "win32"), null, line);
});

// ---------------------------------------------------------------- (c): a read through an ambiguous $H asks on win32

for (const line of ["H=C:x; cat $H/f", "H=C:\\w\\proj; cat $H/f", "H=C:\\Profiles\\u\\.ssh; cat $H/id_rsa", "H=a\\\\b; cat $H/f", "H=C:\\w; ls ${H}"]) {
  test(`win32: ${line}`, () => {
    for (const role of ["main", "child"] as const) assert.equal(wsh(role, line), "ask", role);
  });
}

test("win32: cat $H/f (an unknown $H stays as it is)", () => {
  assert.equal(wsh("child", "cat $H/f"), "pass");
  assert.equal(wsh("child", "H=C:/w/proj; cat $H/f"), "pass", "a forward-slash value is resolved, not ambiguous");
});

test("posix: H=C:\\w\\proj; cat $H/f (no win32 rule off win32)", () => {
  for (const role of ["main", "child"] as const) assert.equal(psh(role, "H=C:\\w\\proj; cat $H/f"), psh(role, "cat $H/f"), role);
  assert.equal(psh("child", "H=C:x; cat $H/f"), "pass");
});

// ---------------------------------------------------------------- SECURITY 2: an ambiguous write target denies for a child

for (const line of ["echo x > C:\\w\\proj\\a", "cp f C:\\w\\proj\\a", "touch C:wproja", "echo x >> C:x", "tee C:\\w\\a < f", "mv f a\\\\b", "echo x > a\\\\b"]) {
  test(`win32 child: ${line}`, () => {
    assert.equal(wsh("child", line, ro), "deny", "read-only round root");
    assert.equal(wsh("child", line), "deny", "no round roots");
  });
}

for (const line of ["cat C:\\w\\proj\\f", "cat C:wprojf", "ls C:x", "cat a\\\\b"]) {
  test(`win32 child: ${line}`, () => {
    assert.equal(wsh("child", line, ro), "ask");
    assert.equal(wsh("child", line), "ask");
  });
}

test("win32 child: echo x > C:/t/out/a and echo x > \"C:\\t\\out\\a\" keep their decision (outside the read-only root)", () => {
  assert.equal(wsh("child", "echo x > C:/t/out/a", ro), "pass");
  assert.equal(wsh("child", 'echo x > "C:\\t\\out\\a"', ro), "pass");
  assert.equal(wsh("child", "cp f C:/t/out/a", ro), "pass");
  assert.equal(wsh("child", "cp f 'C:\\t\\out\\a'", ro), "pass");
  assert.equal(wsh("child", "echo x > C:/w/proj/a", ro), "deny", "inside the read-only root, as before");
  assert.equal(wsh("child", "cat C:/w/proj/f", ro), "pass");
  assert.equal(wsh("child", "cat 'C:\\w\\proj\\f'", ro), "pass");
});

test("win32 main: echo x > C:\\w\\proj\\a (the foreman keeps its decision)", () => {
  assert.equal(wsh("main", "echo x > C:\\w\\proj\\a"), "pass");
  assert.equal(wsh("main", "cat C:\\w\\proj\\f"), "pass");
});

test("posix child: echo x > a\\\\b and touch C:wproja (no win32 rule off win32)", () => {
  assert.equal(psh("child", "echo x > a\\\\b"), "pass");
  assert.equal(psh("child", "touch C:wproja"), "pass");
  assert.equal(psh("child", "cat C:x"), "pass");
});
