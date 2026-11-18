// Ledger r8 item 5 (reviewer SECURITY 1/2): Git Bash on Windows runs the posix-unescaped word. An unquoted `C:\\a\\b` is
// `C:\a\b` (win32-absolute: resolves to the native path); an unquoted `C:\a\b` is the drive-relative `C:ab` (stays unresolved).
// Simulated win32 (injected platform, path.win32 world, no file system); each test is named by its literal shell line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShell } from "../psunits.ts";
import { resolveVars } from "../shellvars.ts";

const wCwd = "C:\\w\\proj";
const wScratch = "C:\\t\\pfs\\s1";

const wEnv = { FOREMAN_SCRATCH: wScratch, PWD: wCwd };
const resolved = (line: string, platform: string): string[] | null => {
  const p = parseShell(line);
  const r = [...resolveVars(p.pipelines, p.seps, wEnv, () => false, line, platform).values()];
  return r.length ? r[r.length - 1] : null;
};

// ---------------------------------------------------------------- SECURITY 1: an escaped unquoted native value resolves

test("win32: H=C:\\\\Profiles\\\\u\\\\.pi\\\\agent\\\\pi-foreman; cat $H/handoffs/s1/ruling.md resolves to the native path", () => {
  const line = "H=C:\\\\Profiles\\\\u\\\\.pi\\\\agent\\\\pi-foreman; cat $H/handoffs/s1/ruling.md";
  assert.deepEqual(resolved(line, "win32"), ["cat", "C:\\Profiles\\u\\.pi\\agent\\pi-foreman/handoffs/s1/ruling.md"]);
});

test("win32: H=C:\\\\Profiles\\\\u\\\\.ssh; cat $H/id_rsa resolves to the native path", () => {
  const line = "H=C:\\\\Profiles\\\\u\\\\.ssh; cat $H/id_rsa";
  assert.deepEqual(resolved(line, "win32"), ["cat", "C:\\Profiles\\u\\.ssh/id_rsa"]);
});

test("win32: H=\\\\\\\\srv\\\\share; cat $H/f (an escaped unquoted UNC value resolves)", () => {
  assert.deepEqual(resolved("H=\\\\\\\\srv\\\\share; cat $H/f", "win32"), ["cat", "\\\\srv\\share/f"]);
  assert.deepEqual(resolved("H=C:\\\\; cat $H/f", "win32"), ["cat", "C:\\/f"], "C:\\\\ is the drive root C:\\");
});

test("win32: H=C:x; cat $H/f and H=C:\\a\\b; cat $H/f stay unresolved (drive-relative after unescaping)", () => {
  for (const line of ["H=C:x; cat $H/f", "H=C:\\a\\b; cat $H/f", "H=C:\\\\a\\; cat $H/f", "H=a\\\\b; cat $H/f"]) assert.equal(resolved(line, "win32"), null, line);
});
