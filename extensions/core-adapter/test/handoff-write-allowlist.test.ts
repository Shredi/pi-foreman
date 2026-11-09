// Item 3: a child writes only the allow-list names of its own handoff dir (childHandoffWrite); win32 spellings simulated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { childHandoffWrite } from "../pathrules.ts";

const H = "C:\\agent\\pi-foreman\\handoffs\\h1";
const ident = (p: string): string | null => p;
const w = (rel: string, real: (p: string) => string | null = ident): boolean => {
  const abs = `${H}\\${rel}`;
  return childHandoffWrite(H, abs, real(abs) ?? abs, "win32", real);
};

test("win32: allow-list names are writable, parent-owned names are not", () => {
  for (const n of ["plan.md", "result.md", "ask.md", "ask-2.md", ".ask", ".seen", ".steer-last-read.json", "work\\a\\b.txt"]) assert.equal(w(n), true, n);
  for (const n of ["brief.md", "ruling-1.md", "steer.md", "close.json", "parent", "child", "x.txt"]) assert.equal(w(n), false, n);
});

test("win32: case, trailing dot/space, ADS and 8.3 spellings", () => {
  assert.equal(w("RESULT.MD"), true);
  assert.equal(w("BRIEF.md"), false);
  assert.equal(w("brief.md."), false);
  assert.equal(w("brief.md "), false);
  assert.equal(w("result.md:stream"), false);
  assert.equal(w("BRIEF~1.MD"), false);
});

test("win32: .. and symlink escapes are refused", () => {
  assert.equal(w("work\\..\\brief.md"), false);
  const real = (p: string): string | null => (p.toLowerCase().includes("\\work\\lnk") ? p.replace(/work\\lnk/i, "elsewhere") : p);
  assert.equal(w("work\\lnk\\a.txt", real), false);
});

test("a dir outside the handoff root is no handoff write", () => {
  assert.equal(childHandoffWrite(H, "C:\\other\\result.md", "C:\\other\\result.md", "win32", ident), false);
});

test("posix: same list", () => {
  const h = "/a/handoffs/h1";
  assert.equal(childHandoffWrite(h, `${h}/ask.md`, `${h}/ask.md`, "linux", ident), true);
  assert.equal(childHandoffWrite(h, `${h}/ruling.md`, `${h}/ruling.md`, "linux", ident), false);
  assert.equal(childHandoffWrite(h, `${h}/work/x`, `${h}/work/x`, "linux", ident), true);
});
