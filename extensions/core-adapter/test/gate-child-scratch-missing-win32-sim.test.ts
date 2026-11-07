// win32 simulation of gate-child-scratch-missing.test.ts (runs on any host): the temp base is spelled with the 8.3 short name `RUNNER~1` while the native
// realpath returns the long name (`runneradmin`), only for dirs that exist; the child's own scratch dir does not exist yet; commands mix separators.
// A write into the own scratch dir is write-in; a sibling scratch dir, the scratch base, a `..` escape, a link out, the outside dir stay denied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShell } from "../shellast.ts";
import { writesOutside } from "../defaults.ts";
import { pathDecide, type GateRoots } from "../pathrules.ts";

const LONG = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\pf-x";
const SHORT = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\pf-x";
const existing = ["wt", "real", "real\\pi-foreman-scratch", "real\\pi-foreman-scratch\\other", "outside", "outside\\dir"].map((d) => `${LONG}\\${d}`);
const files = [`${LONG}\\outside\\f.txt`, `${LONG}\\wt\\x.txt`];
const table = new Map<string, string>();
for (const d of ["C:\\Users\\runneradmin\\AppData\\Local\\Temp", "C:\\Users\\runneradmin\\AppData\\Local", "C:\\Users\\runneradmin\\AppData", "C:\\Users\\runneradmin", "C:\\Users", "C:\\", LONG, ...existing, ...files]) {
  table.set(d.toLowerCase(), d);
  table.set(d.toLowerCase().replace("runneradmin", "runner~1"), d);
}
// the native realpath: existing paths only, any separator and case, the long spelling back
const realpath = (p: string): string | null => table.get(p.replace(/\//g, "\\").toLowerCase()) ?? null;

const wt = `${SHORT}\\wt`;
const scratchBase = `${SHORT}\\real\\pi-foreman-scratch`;
const scratch = `${scratchBase}\\missing-run`;
const outDir = `${SHORT}\\outside`;
const roots: GateRoots = { worktree: wt, scratch: [scratch], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", tmpAccess: false, realpath };

// an unquoted backslash is an escape to the shell parser: commands spell paths with `/` (the drive and the short name are kept)
const fw = (s: string): string => s.replace(/\\/g, "/");
const outside = (raw: string): boolean => {
  const line = fw(raw);
  const segments = parseShell(line, { cwd: wt, platform: "win32", env: { FOREMAN_SCRATCH: scratch } });
  return writesOutside({ tool: "bash", input: { command: line }, segments, text: line }, { roots, platform: "win32", cwd: wt });
};

test("win32 sim: a write into the missing own scratch dir is write-in, short and long spellings, mixed separators", () => {
  const lits = [scratch, scratch.replace("RUNNER~1", "runneradmin"), scratch.replace(/\\/g, "/"), scratch.toUpperCase()];
  for (const lit of lits) {
    for (const cmd of [`mkdir -p ${lit}/new/a`, `echo x > ${lit}/f.txt`, `cp ${wt}/x.txt ${lit}/h.txt`, `cp ${outDir}/f.txt ${lit}/h.txt`, `cp -r ${outDir}/dir ${lit}/d`, `cp ${outDir}/f.txt ${wt}/h.txt`]) {
      assert.equal(outside(cmd), false, cmd);
    }
    assert.equal(pathDecide("write", { path: `${lit}/q/w.txt` }, wt, roots, "win32")?.allow, true, `write tool ${lit}`);
  }
});

test("win32 sim: sibling scratch, the scratch base, the temp root, `..` escapes, outside dirs and mv sources stay denied", () => {
  for (const lit of [scratch, scratch.replace("RUNNER~1", "runneradmin")]) {
    for (const cmd of [
      `echo x > ${scratchBase}/other/f.txt`,
      `echo x > ${scratchBase}/f.txt`,
      `echo x > ${SHORT}/real/f.txt`,
      `mkdir -p ${outDir}/x`,
      `mv ${outDir}/f.txt ${lit}/h.txt`,
      `cp ${wt}/x.txt ${outDir}/x`,
      `echo x > ${lit}/new/../../other/f`,
    ]) {
      assert.equal(outside(cmd), true, cmd);
    }
    assert.equal(pathDecide("write", { path: `${scratchBase}/other/f.txt` }, wt, roots, "win32"), undefined, "write tool sibling");
  }
});
