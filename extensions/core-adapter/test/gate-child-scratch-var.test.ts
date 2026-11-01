// A child's `$FOREMAN_SCRATCH` is its own scratch dir: the gate binds it when it parses the child's line, so a write below it is not the
// danger-opaque class (replay child_scratch). The foreman has no such variable, so the same line stays opaque there.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf79-scratchvar-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
for (const d of [wt, scr]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (child: boolean): GateRoots => ({ worktree: wt, scratch: [scr], tmp: [path.join(base, "tmp")], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child, role: child ? "builder" : "foreman", tmpAccess: true });
const run = (child: boolean) => gateEvaluate("bash", { command: "cp notes.txt $FOREMAN_SCRATCH/copy.txt" }, wt, { env: (cwd) => baseFloorEnv(cwd, { ...(child ? { child: true } : {}) }), roots: () => roots(child) });

test("a child's cp into $FOREMAN_SCRATCH is not the opaque danger class", () => {
  const out = run(true);
  assert.notEqual(out.danger?.name, "danger-opaque", JSON.stringify(out.danger));
});

test("the foreman's $FOREMAN_SCRATCH stays unbound: the same line is danger-opaque", () => {
  assert.equal(run(false).danger?.name, "danger-opaque");
});
