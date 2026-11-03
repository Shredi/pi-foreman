// The child's own-scratch fence compares realpaths on both sides: a scratch root given through a symlinked dir (macOS `/var` -> `/private/var`)
// and a literal target through the real path (and the reverse) are write-in, not child-write-outside. Anything else outside stays outside.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-scratchreal-"));
const wt = path.join(base, "wt");
const realTmp = path.join(base, "real");
const linkTmp = path.join(base, "lnk");
const rel = path.join("pi-foreman-scratch", "mine");
for (const d of [wt, path.join(realTmp, rel), path.join(realTmp, "other")]) fs.mkdirSync(d, { recursive: true });
if (posix) fs.symlinkSync(realTmp, linkTmp);
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (scratch: string): GateRoots => ({ worktree: wt, scratch: [scratch], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", tmpAccess: false });
const decide = (scratch: string, command: string) => gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { child: true }), roots: () => roots(scratch) });
const outside = (scratch: string, command: string): boolean => {
  const r = decide(scratch, command).result as { block?: boolean; rule?: string } | undefined;
  return !!r?.block && r.rule === "child-write-outside";
};

test("scratch root through a symlink, literal target through the real path: write-in", { skip: !posix }, () => {
  const root = path.join(linkTmp, rel);
  const real = path.join(realTmp, rel);
  assert.equal(outside(root, `cd ${real}/sub && echo x > f.txt`), false);
  assert.equal(outside(root, `echo x > ${real}/f.txt`), false);
  assert.equal(outside(root, `mkdir -p ${real}/d`), false);
});

test("scratch root through the real path, literal target through the symlink: write-in", { skip: !posix }, () => {
  const root = path.join(realTmp, rel);
  const lit = path.join(linkTmp, rel);
  assert.equal(outside(root, `cd ${lit}/sub && echo x > f.txt`), false);
  assert.equal(outside(root, `echo x > ${lit}/f.txt`), false);
  assert.equal(outside(root, `mkdir -p ${lit}/d`), false);
  assert.equal(outside(root, `touch ${lit}/t`), false);
  assert.equal(outside(root, `cd ${lit} && mkdir q`), false);
});

test("the same symlinked tmp does not widen the fence: a sibling dir stays outside", { skip: !posix }, () => {
  const root = path.join(linkTmp, rel);
  assert.equal(outside(root, `echo x > ${path.join(realTmp, "other")}/f.txt`), true);
  assert.equal(outside(root, `echo x > ${path.join(linkTmp, "other")}/f.txt`), true);
});
