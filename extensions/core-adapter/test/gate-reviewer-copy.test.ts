// A reviewer's `foreman_copy` (item 4) is limited like its `write`: the destination must lie in its scratch or out dir; the worktree is refused.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf-rc-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const out = path.join(base, "out", "mine");
for (const d of [wt, scr, out]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, "a.txt"), "x");
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (readOnly: boolean): GateRoots => ({ worktree: wt, scratch: [scr, out], out, tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "reviewer", tmpAccess: false, ...(readOnly ? { roundReadOnly: true } : {}) });
type Verdict = { block?: boolean; rule?: string } | undefined;
const copy = (dst: string, readOnly: boolean): Verdict =>
  gateEvaluate("foreman_copy", { src: path.join(wt, "a.txt"), dst }, wt, { env: (c) => baseFloorEnv(c, { child: true }), roots: () => roots(readOnly) }).result as Verdict;

for (const readOnly of [false, true]) {
  test(`reviewer foreman_copy (${readOnly ? "inside a round" : "outside a round"}): into scratch and out is allowed`, () => {
    for (const d of [path.join(scr, "a.txt"), path.join(out, "a.txt")]) assert.notEqual(copy(d, readOnly)?.block, true, d);
  });
  test(`reviewer foreman_copy (${readOnly ? "inside a round" : "outside a round"}): into the worktree is refused`, () => {
    for (const d of [path.join(wt, "b.txt"), path.join(wt, "sub", "b.txt")]) assert.equal(copy(d, readOnly)?.block, true, d);
  });
}
