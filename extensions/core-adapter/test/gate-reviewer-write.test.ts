// A reviewer's `write` tool (item: reviewer heredoc incident) is limited by the gate to its scratch and output dirs, in every launch (`child-reviewer-write`,
// real paths compared); the rule decides on the structured `path` field only. Other roles and the reviewer's shell lines are judged as before.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf-rw-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const out = path.join(base, "out", "mine");
for (const d of [wt, scr, out]) fs.mkdirSync(d, { recursive: true });
fs.symlinkSync(wt, path.join(scr, "to-wt"));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (role: string, readOnly: boolean): GateRoots => ({ worktree: wt, scratch: [scr, out], out, tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child: true, role, tmpAccess: false, ...(readOnly ? { roundReadOnly: true } : {}) });
type Verdict = { block?: boolean; rule?: string } | undefined;
const verdict = (tool: string, input: Record<string, unknown>, role = "reviewer", readOnly = false): Verdict =>
  gateEvaluate(tool, input, wt, { env: (c) => baseFloorEnv(c, { child: true }), roots: () => roots(role, readOnly) }).result as Verdict;
const RULE = "child-reviewer-write";

for (const readOnly of [false, true]) {
  test(`reviewer write (${readOnly ? "inside a round" : "outside a round"}): scratch and out are allowed`, () => {
    for (const p of [path.join(scr, "probe.json"), path.join(scr, "sub", "x.txt"), path.join(out, "log.txt")]) {
      const v = verdict("write", { path: p, content: "rm -rf x\n" }, "reviewer", readOnly);
      assert.notEqual(v?.rule, RULE, `${p} -> ${JSON.stringify(v)}`);
      assert.notEqual(v?.block, true, `${p} -> ${JSON.stringify(v)}`);
    }
  });

  test(`reviewer write (${readOnly ? "inside a round" : "outside a round"}): the worktree, other dirs and a link out of scratch are refused`, () => {
    for (const p of [path.join(wt, "a.txt"), path.join(wt, "sub", "b.txt"), path.join(base, "elsewhere.txt"), path.join(scr, "to-wt", "c.txt"), path.join(scr, "..", "x.txt")]) {
      const v = verdict("write", { path: p, content: "x" }, "reviewer", readOnly);
      assert.equal(v?.block, true, `${p} -> ${JSON.stringify(v)}`);
      assert.ok(v?.rule === RULE || (readOnly && v?.rule === "child-readonly-write") || v?.rule === "child-write-outside", `${p} -> ${JSON.stringify(v)}`);
    }
  });
}

test("reviewer write outside a round into the worktree is the new rule (the worktree is a sanctioned child target there)", () => {
  assert.equal(verdict("write", { path: path.join(wt, "a.txt"), content: "x" })?.rule, RULE);
});

test("a builder keeps its worktree writes, and the rule never reads the reviewer's shell lines", () => {
  assert.notEqual(verdict("write", { path: path.join(wt, "a.txt"), content: "x" }, "builder")?.rule, RULE);
  assert.notEqual(verdict("bash", { command: `echo x > ${path.join(scr, "f")}` })?.rule, RULE);
  assert.notEqual(verdict("bash", { command: "npm test" })?.rule, RULE);
});
