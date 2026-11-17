// The `child-write-outside` refusal names the way out for another worktree: the foreman launches a child with `cwd` set to it.
// The verdict is unchanged: the same write is still refused, the worktree's own write is not.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-hcw-way-"));
const wt = path.join(base, "wt");
const out = path.join(base, "elsewhere");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const H = path.join(base, "agent", "handoffs", "h1");
for (const d of [wt, out, scr, H]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (): GateRoots => ({ worktree: wt, scratch: [scr], tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", tmpAccess: false, childHandoff: H });
type Res = { block?: boolean; rule?: string; reason?: string } | undefined;
const call = (tool: string, input: Record<string, unknown>): Res =>
  gateEvaluate(tool, input, wt, { env: (c) => baseFloorEnv(c, { child: true }), roots: () => roots() }).result as Res;

const WAY_OUT = "For another worktree, the foreman launches a child with cwd set to it.";

test("the refusal names the way out for another worktree and keeps the verdict", { skip: !posix }, () => {
  const r = call("bash", { command: `echo x > ${out}/f` });
  assert.equal(r?.block, true);
  assert.equal(r?.rule, "child-write-outside");
  assert.ok((r?.reason ?? "").includes(WAY_OUT), r?.reason);
});

test("the way out is named once per refusal, not in other child refusals", { skip: !posix }, () => {
  const r = call("write", { path: path.join(out, "w.txt"), content: "x" });
  assert.equal(r?.rule, "child-write-outside");
  assert.equal((r?.reason ?? "").split(WAY_OUT).length - 1, 1, r?.reason);
  assert.equal(call("bash", { command: `echo x > ${wt}/f` })?.block, undefined);
});
