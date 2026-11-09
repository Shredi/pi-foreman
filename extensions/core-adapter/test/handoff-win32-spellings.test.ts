// The child's own-handoff exemption on win32: root and target in different spellings (separators, 8.3 `RUNNER~1` vs the long form,
// drive-letter case) while the handoff dir does not exist yet, so only its deepest existing ancestor resolves to the long form.
import { test } from "node:test";
import assert from "node:assert/strict";
import { childHandoffWrite } from "../pathrules.ts";

const SHORT = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp";
const LONG = "C:\\Users\\runneradmin\\AppData\\Local\\Temp";
// only the Temp dir exists; realpath.native expands the 8.3 part there
const real = (p: string): string | null => {
  const n = p.replace(/\//g, "\\");
  if (n.toLowerCase() === SHORT.toLowerCase() || n.toLowerCase() === LONG.toLowerCase()) return LONG;
  return null;
};
const root = `${SHORT}\\pf-ho-overlay\\.pi\\agent\\pi-foreman\\handoffs\\h1`;
const rootSlash = root.replace(/\\/g, "/");
const longOf = (p: string): string => p.replace(SHORT, LONG);

test("win32: abs in the 8.3 spelling, real spelling in the long form, root not created yet", () => {
  for (const r of [root, rootSlash]) {
    for (const name of ["ask.md", "plan.md", "ask-2.md", "work\\a.txt"]) {
      const abs = `${root}\\${name}`;
      assert.equal(childHandoffWrite(r, abs, longOf(abs), "win32", real), true, `${r} ${name}`);
    }
  }
});

test("win32: mixed separators and drive-letter case", () => {
  const abs = `${rootSlash}/ask.md`.replace("C:", "c:");
  assert.equal(childHandoffWrite(root, abs, longOf(`${root}\\ask.md`).replace("C:", "c:"), "win32", real), true);
});

test("win32: parent-owned names, the bare work entry and another handoff dir stay refused", () => {
  for (const name of ["ruling.md", "steer.md", "work"]) {
    const abs = `${root}\\${name}`;
    assert.equal(childHandoffWrite(root, abs, longOf(abs), "win32", real), false, name);
  }
  const other = `${SHORT}\\pf-ho-overlay\\.pi\\agent\\pi-foreman\\handoffs\\h2\\ask.md`;
  assert.equal(childHandoffWrite(root, other, longOf(other), "win32", real), false);
});
