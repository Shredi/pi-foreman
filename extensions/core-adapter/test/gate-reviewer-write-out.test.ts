// A reviewer's `write` into $FOREMAN_OUT goes through the same checks as one into scratch: a plain file is allowed, a `.git` path is refused (`child-reviewer-write`).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf-rwo-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const out = path.join(base, "out", "mine");
for (const d of [wt, scr, out]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

// out is one of scratch, as the launch binds it
const roots = (): GateRoots => ({ worktree: wt, scratch: [scr, out], out, tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "reviewer", tmpAccess: false });
type Verdict = { block?: boolean; rule?: string } | undefined;
const verdict = (p: string): Verdict =>
  gateEvaluate("write", { path: p, content: "x" }, wt, { env: (c) => baseFloorEnv(c, { child: true }), roots }).result as Verdict;

test("reviewer write into $FOREMAN_OUT: a normal file is allowed", () => {
  const v = verdict(path.join(out, "x"));
  assert.notEqual(v?.block, true, JSON.stringify(v));
});

test("reviewer write into $FOREMAN_OUT: a .git path of a clone is refused", () => {
  const v = verdict(path.join(out, "clone", ".git", "hooks", "x"));
  assert.equal(v?.block, true, JSON.stringify(v));
});
