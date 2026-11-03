// A6 (second ruling): `unlink node_modules` / `rm node_modules` of a node_modules symlink to a directory outside the worktree, as foreman (floor-delete-outside) and as child (write-in).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { lineFloors } from "../floors.ts";
import { writesOutside } from "../defaults.ts";
import type { GateRoots } from "../pathrules.ts";
import { parseShell } from "../shellast.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-rmnm-"));
const wt = path.join(base, "wt");
const outside = path.join(base, "outside-modules");
after(() => fs.rmSync(base, { recursive: true, force: true }));
fs.mkdirSync(path.join(wt, ".git"), { recursive: true });
fs.mkdirSync(outside, { recursive: true });
if (posix) fs.symlinkSync(outside, path.join(wt, "node_modules"));

const segs = (line: string) => parseShell(line, { cwd: wt });
const floor = (line: string) => lineFloors(line, segs(line), { cwd: wt, writeRoots: [wt] });
const roots: GateRoots = { worktree: wt, scratch: [], tmp: [], scratchBase: path.join(base, "s"), owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", tmpAccess: false };
const childOut = (line: string): boolean => writesOutside({ tool: "bash", input: { command: line }, segments: segs(line), text: line }, { roots, platform: process.platform, cwd: wt });

test("foreman: removing the node_modules link itself hits no floor; -r and a trailing slash keep today's judgement", { skip: !posix }, () => {
  for (const l of ["unlink node_modules", "rm node_modules", "rm -f node_modules"]) assert.equal(floor(l), null, l);
  // today's judgement of the other shapes is unchanged: the same answer as for any path lexically inside the worktree
  assert.equal(floor("rm -r node_modules")?.rule ?? null, floor("rm -r sub")?.rule ?? null);
  assert.equal(floor("rm node_modules/")?.rule ?? null, floor("rm sub/")?.rule ?? null);
});

test("child: the node_modules link is a write in; -r and a trailing slash keep today's judgement (outside)", { skip: !posix }, () => {
  for (const l of ["unlink node_modules", "rm node_modules", "rm -f node_modules"]) assert.equal(childOut(l), false, l);
  for (const l of ["rm -r node_modules", "rm -rf node_modules", "rm node_modules/"]) assert.equal(childOut(l), true, l);
});
