// PR B2 revision: the forms behind a multiplexer's shell or xargs, a function inside a `-c`/eval string, a PowerShell delete in a function body, and the redirect end read from node offsets.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf-b2-round-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
for (const d of [wt, scr]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (child: boolean): GateRoots => ({ worktree: wt, scratch: [scr], tmp: [path.join(base, "tmp")], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child, role: child ? "builder" : "foreman", tmpAccess: true });
/** The gate result: "<rule>:block" or "<rule>:ask", "allow" when nothing decided. */
const run = (tool: string, command: string, child = false): string => {
  const o = gateEvaluate(tool, { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { scratch: [scr], home: "/Users/fixture", ...(child ? { child: true, builder: true } : {}) }), roots: () => roots(child) });
  const x = o.result;
  return x && "block" in x ? `${x.rule}:block` : x && "ask" in x ? `${x.rule}:ask` : "allow";
};


const REFUSED: Array<[string, string]> = [
  ["busybox ash -c 'rm -rf ~'", "floor-rm-system"], ["busybox ash -c 'rm -rf $X'", "floor-delete-unknown-target"], ["busybox ash -c 'rm -rf /opt/x'", "floor-delete-outside"],
  ["toybox ash -c 'rm -rf ~'", "floor-rm-system"], ["busybox xargs rm -rf", "floor-delete-unknown-target"], ["toybox xargs rm -rf", "floor-delete-unknown-target"],
  ["bash -c 'f(){ rm -rf ~; }; f'", "floor-rm-system"], ["eval 'f(){ rm -rf ~; }; f'", "floor-rm-system"], ['eval "f(){ rm -rf ~; }; f"', "floor-rm-system"],
  ["eval 'g(){ git clean -fd $X; }; g'", "floor-delete-unknown-target"], ["f(){ Remove-Item -Recurse $x; }; f", "floor-delete-unknown-target"],
  ["echo hi > $F # c", "floor-unknown-write-target"], ["( echo hi > $F )", "floor-unknown-write-target"],
];

for (const [line, rule] of REFUSED) {
  test(`refused in mode allow, foreman and child: ${line}`, () => {
    assert.match(run("bash", line), new RegExp(`^${rule}:`), line);
    assert.match(run("bash", line, true), /^floor-[a-z-]+:(block|ask)$/, line);
  });
}

test("the redirect that is followed by a word runs; a delete inside the worktree in a string runs", () => {
  for (const child of [false, true]) {
    for (const l of ["echo > $F arg", "busybox ash -c 'ls'", "busybox xargs ls", "bash -c 'f(){ rm -rf build; }; f'", "eval 'f(){ echo ok; }; f'"]) assert.equal(run("bash", l, child), "allow", `${child ? "child" : "foreman"}: ${l}`);
  }
});
