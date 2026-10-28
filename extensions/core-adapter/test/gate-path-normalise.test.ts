// R41 gate path normalisation (pathnorm.ts): roots and candidates meet in one long-name form. Runs on every OS: the resolver is a
// stub that expands 8.3 names, the platform is passed explicitly (path.win32 semantics).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normPath, sameOrUnder, type Resolver } from "../pathnorm.ts";
import { pathDecide, type GateRoots } from "../pathrules.ts";
import { pathFloors, type FloorEnv } from "../floors.ts";

const SHORT = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp";
const LONG = "C:\\Users\\runneradmin\\AppData\\Local\\Temp";
const win32: Resolver = (p) => {
  const n = p.replace(/\//g, "\\");
  const real = n.replace(/^C:\\Users\\RUNNER~1/i, "C:\\Users\\runneradmin");
  // only the dirs below exist; anything else is "missing"
  return /^C:\\Users(\\runneradmin(\\AppData(\\Local(\\Temp(\\pf)?)?)?)?)?$/i.test(real) ? real : null;
};
const posix: Resolver = (p) => (p === "/work" || p === "/" ? p : null);

test("win32: 8.3 short form and long form of one root match, both ways", () => {
  assert.ok(sameOrUnder("win32", `${LONG}\\pf`, `${SHORT}\\pf\\a.txt`, LONG, win32));
  assert.ok(sameOrUnder("win32", `${SHORT}\\pf`, `${LONG}\\pf\\a.txt`, LONG, win32));
  assert.ok(sameOrUnder("win32", `${SHORT}\\pf`, `${SHORT}\\pf`, LONG, win32));
  assert.ok(!sameOrUnder("win32", `${SHORT}\\pf`, `${SHORT}\\pfx\\a.txt`, LONG, win32));
});

test("win32: a non-existent child under a short-form root matches through the nearest existing parent", () => {
  assert.equal(normPath("win32", `${SHORT}\\pf\\new\\deep.txt`, LONG, win32), `${LONG}\\pf\\new\\deep.txt`.toLowerCase());
  assert.ok(sameOrUnder("win32", `${LONG}\\pf`, `${SHORT}\\pf\\new\\deep.txt`, LONG, win32));
});

test("win32: case, slash separators and a drive-less root against the base drive", () => {
  assert.ok(sameOrUnder("win32", "c:/users/RUNNERADMIN/appdata/local/temp/PF", `${LONG}\\pf\\A.txt`, LONG, win32));
  assert.ok(sameOrUnder("win32", "/Users/runneradmin", `${SHORT}\\x`, LONG, win32));
  assert.ok(!sameOrUnder("win32", "D:\\Users\\runneradmin", `${SHORT}\\x`, LONG, win32));
});

test("posix: case differences do not match, separators are not rewritten", () => {
  assert.ok(sameOrUnder("posix", "/work/Repo", "/work/Repo/a", "/work", posix));
  assert.ok(!sameOrUnder("posix", "/work/Repo", "/work/repo/a", "/work", posix));
  assert.equal(normPath("posix", "/work/a\\b", "/work", posix), "/work/a\\b");
});

const roots = (o: Partial<GateRoots> = {}): GateRoots => ({
  worktree: `${LONG}\\pf\\wt`, scratch: [], tmp: [`${LONG}\\pf\\tmp`, "/tmp"], owned: [], install: [`${SHORT}\\pf\\pi`], roundFlow: [], handoffs: [],
  child: false, role: "foreman", tmpAccess: true, realpath: win32, ...o,
});

test("win32 path rules: short-form path in a long-form root, long-form path in a short-form root, drive-less /tmp", () => {
  const r = (p: string, tool = "read"): string | undefined => pathDecide(tool, { path: p }, `${LONG}\\pf\\wt`, roots(), "win32")?.rule;
  assert.equal(r(`${SHORT}\\pf\\wt\\a.ts`), "path-read-worktree");
  assert.equal(r(`${SHORT}\\pf\\wt\\new\\a.ts`, "write"), "path-write-worktree");
  assert.equal(r(`${LONG}\\pf\\pi\\x.d.ts`), "path-read-install");
  assert.equal(r(`${LONG.toUpperCase()}\\PF\\TMP\\x`), "path-read-tmp");
  assert.equal(r("/tmp/x"), "path-read-tmp");
  assert.equal(r(`${SHORT}\\other\\x`), undefined);
});

test("win32: a floored path in short form, other case or other separators still hits its floor", () => {
  const env: FloorEnv = { cwd: LONG, home: "C:\\Users\\runneradmin", agentDir: "C:\\Users\\runneradmin\\.pi\\agent", platform: "win32", writeRoots: [LONG], protectedBranches: [], currentBranch: () => "x", remoteHead: () => "main" };
  for (const p of [`${LONG}\\.env`, `${SHORT}\\.env`, `${LONG.toUpperCase()}\\.ENV`, "C:/Users/RUNNER~1/.aws/credentials", "C:\\Users\\runneradmin\\.PI\\Agent\\AUTH.JSON", "C:/users/runneradmin/.pi/agent/auth.json"]) {
    assert.equal(pathFloors({ path: p }, env, "read")?.rule, "floor-secret-path", p);
  }
});
