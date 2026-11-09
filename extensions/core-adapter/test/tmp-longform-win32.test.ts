// Item 6: win32 temp dir spelled 8.3 (`RUNNER~1`) by os.tmpdir() and long (`runneradmin`) by the native realpath. The foreman's tmp roots
// (gate roots, shell-effect bases, redirects) know both spellings when tmpAccess allows; a child's stay unchanged; the other sessions'
// scratch dirs below the temp dir stay out of the path tmp default for both spellings. Simulated win32, no file system.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShell } from "../shellast.ts";
import { writesOutside } from "../defaults.ts";
import { pathDecide, tmpRoots, type GateRoots } from "../pathrules.ts";

const SHORT = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp";
const LONG = "C:\\Users\\runneradmin\\AppData\\Local\\Temp";
const toLong = (p: string): string => p.replace(/RUNNER~1/i, "runneradmin");
const realpath = (p: string): string | null => p;
const wt = "D:\\a\\pf\\pf";
const fw = (s: string): string => s.replace(/\\/g, "/");

const mk = (over: Partial<GateRoots>): GateRoots => ({
  worktree: wt,
  scratch: [],
  tmp: tmpRoots(SHORT, "win32", (p) => p, (p) => toLong(p)),
  owned: [],
  install: [],
  roundFlow: [],
  handoffs: [],
  child: false,
  role: "main",
  tmpAccess: true,
  realpath,
  ...over,
});

const outside = (roots: GateRoots, raw: string): boolean => {
  const line = fw(raw);
  const segments = parseShell(line, { cwd: wt, platform: "win32", env: {} });
  return writesOutside({ tool: "bash", input: { command: line }, segments, text: line }, { roots, platform: "win32", cwd: wt });
};

test("tmpRoots on win32 holds the short and the long spelling; identical spellings give one", () => {
  assert.deepEqual(tmpRoots(SHORT, "win32", (p) => p, toLong), [SHORT, LONG]);
  assert.deepEqual(tmpRoots(LONG, "win32", (p) => p, toLong), [LONG]);
  assert.deepEqual(tmpRoots("/tmp/x", "linux", (p) => p, () => null), ["/tmp/x", "/tmp"]);
});

test("foreman with tmpAccess: shell writes into the temp dir are not outside, either spelling", () => {
  const r = mk({});
  for (const base of [SHORT, LONG]) {
    for (const cmd of [`echo x > ${base}/out.txt`, `mkdir -p ${base}/d`, `cp a.txt ${base}/b.txt`, `echo x | tee ${base}/t.txt`]) assert.equal(outside(r, cmd), false, cmd);
  }
});

test("foreman without tmpAccess: the same writes are outside", () => {
  const r = mk({ tmpAccess: false });
  for (const base of [SHORT, LONG]) for (const cmd of [`echo x > ${base}/out.txt`, `mkdir -p ${base}/d`, `cp a.txt ${base}/b.txt`]) assert.equal(outside(r, cmd), true, cmd);
});

test("child: shell writes into the temp dir stay outside, either spelling", () => {
  const r = mk({ child: true, role: "builder" });
  for (const base of [SHORT, LONG]) for (const cmd of [`echo x > ${base}/out.txt`, `mkdir -p ${base}/d`, `cp a.txt ${base}/b.txt`]) assert.equal(outside(r, cmd), true, cmd);
});

test("foreman: a write elsewhere on the drive is still outside", () => {
  assert.equal(outside(mk({}), "echo x > C:/Users/runneradmin/other/out.txt"), true);
});

test("path tools: the tmp default holds for both spellings (foreman), child gets none", () => {
  const f = mk({});
  const c = mk({ child: true, role: "builder" });
  for (const base of [SHORT, LONG]) {
    assert.ok(pathDecide("write", { path: `${base}\\x.txt`, content: "x" }, wt, f, "win32"), base);
    assert.equal(pathDecide("write", { path: `${base}\\x.txt`, content: "x" }, wt, c, "win32"), undefined, base);
  }
  assert.equal(pathDecide("write", { path: `${LONG}\\x.txt`, content: "x" }, wt, mk({ tmpAccess: false }), "win32"), undefined);
});

test("other sessions' scratch dirs (<tmp>/pi-foreman-scratch) are no tmp default, short or long spelling", () => {
  // the native realpath expands the short spelling (dirs that exist)
  const f = mk({ scratchBase: `${LONG}\\pi-foreman-scratch`, realpath: toLong });
  for (const base of [SHORT, LONG]) {
    assert.equal(pathDecide("write", { path: `${base}\\pi-foreman-scratch\\other\\x.txt`, content: "x" }, wt, f, "win32"), undefined, base);
    assert.ok(pathDecide("write", { path: `${base}\\ok.txt`, content: "x" }, wt, f, "win32"), base);
  }
});
