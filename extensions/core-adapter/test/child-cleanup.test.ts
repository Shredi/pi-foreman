// D33 (a): a child may delete a path inside its own worktree (`rm`, `rm -rf`) and overwrite an existing binary file there (the write tool, `cp`).
// These pin the guard-round behaviour: no rule refuses either; a path outside the worktree stays refused.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

const base = fs.realpathSync.native(mkTestTmp("pf-cleanup-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "s", "l");
const outside = path.join(base, "other");
for (const d of [path.join(wt, "gen", "deep"), scr, outside]) fs.mkdirSync(d, { recursive: true });
const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x00, 0xff, 0xfe]);
fs.writeFileSync(path.join(wt, "report.pdf"), pdf);
fs.writeFileSync(path.join(wt, "gen", "deep", "a.bin"), pdf);
fs.writeFileSync(path.join(wt, "new.pdf"), Buffer.concat([pdf, pdf]));
fs.writeFileSync(path.join(outside, "x.pdf"), pdf);
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots: GateRoots = { worktree: wt, scratch: [scr], tmp: [path.join(base, "tmp")], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", tmpAccess: true };
const decide = (tool: string, inp: Record<string, unknown>) => gateEvaluate(tool, inp, wt, { env: (cwd) => baseFloorEnv(cwd, { child: true, scratch: [scr] }), roots: () => roots });
const allowed = (tool: string, inp: Record<string, unknown>): boolean => {
  const o = decide(tool, inp);
  const r = o.result as { allow?: boolean } | undefined;
  return r ? r.allow === true : o.danger === null;
};
const blocked = (tool: string, inp: Record<string, unknown>): boolean => !!(decide(tool, inp).result as { block?: boolean } | undefined)?.block;

test("a child may delete files and directories inside its worktree", { skip: posixOnly }, () => {
  for (const command of ["rm report.pdf", "rm -rf gen", "rm -rf gen/deep", "rm -f gen/deep/a.bin", `rm -rf ${path.join(wt, "gen")}`]) assert.equal(allowed("bash", { command }), true, command);
});

test("a child may overwrite an existing binary file in its worktree: write tool and cp", { skip: posixOnly }, () => {
  assert.equal(allowed("write", { path: path.join(wt, "report.pdf"), content: "%PDF-new" }), true);
  assert.equal(allowed("write", { path: "report.pdf", content: "%PDF-new" }), true);
  assert.equal(allowed("bash", { command: "cp new.pdf report.pdf" }), true);
  assert.equal(allowed("bash", { command: "cp -f new.pdf report.pdf" }), true);
});

test("outside the worktree both stay refused", { skip: posixOnly }, () => {
  assert.equal(blocked("bash", { command: `rm -rf ${outside}` }), true);
  assert.equal(blocked("write", { path: path.join(outside, "x.pdf"), content: "x" }), true);
  assert.equal(blocked("bash", { command: `cp new.pdf ${path.join(outside, "x.pdf")}` }), true);
});
