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
/** The gate result: "<rule>:block" or "<rule>:ask", "<danger>:judge" when the call goes to the judge first (PR C), "allow" when nothing decided. */
const run = (tool: string, command: string, child = false): string => {
  const o = gateEvaluate(tool, { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { scratch: [scr], home: "/Users/fixture", ...(child ? { child: true, builder: true } : {}) }), roots: () => roots(child) });
  const x = o.result;
  return x && "block" in x ? `${x.rule}:block` : x && "ask" in x ? `${x.rule}:ask` : o.danger ? `${o.danger.name}:judge` : "allow";
};


const REFUSED: Array<[string, string]> = [
  ["busybox ash -c 'rm -rf ~'", "floor-rm-system"], ["busybox ash -c 'rm -rf $X'", "danger-delete-unknown-target"], ["busybox ash -c 'rm -rf /opt/x'", "danger-delete-unknown-target"],
  ["toybox ash -c 'rm -rf ~'", "floor-rm-system"], ["busybox xargs rm -rf", "danger-delete-unknown-target"], ["toybox xargs rm -rf", "danger-delete-unknown-target"],
  ["bash -c 'f(){ rm -rf ~; }; f'", "floor-rm-system"], ["eval 'f(){ rm -rf ~; }; f'", "floor-rm-system"], ['eval "f(){ rm -rf ~; }; f"', "floor-rm-system"],
  ["eval 'g(){ git clean -fd $X; }; g'", "danger-delete-unknown-target"], ["f(){ Remove-Item -Recurse $x; }; f", "danger-delete-unknown-target"],
  ["echo hi > $F # c", "danger-unknown-write-target"], ["( echo hi > $F )", "danger-unknown-write-target"],
];

for (const [line, rule] of REFUSED) {
  test(`floor or judge first, foreman and child: ${line}`, () => {
    assert.match(run("bash", line), new RegExp(`^${rule}:`), line);
    assert.match(run("bash", line, true), /^(floor-[a-z-]+:(block|ask)|danger-[a-z-]+:judge)$/, line);
  });
}

test("the redirect that is followed by a word runs; a delete inside the worktree in a string runs", () => {
  for (const child of [false, true]) {
    // a child's write through a variable is the child write check's judge-first hit (D4)
    if (child) assert.equal(run("bash", "echo > $F arg", true), "danger-write-outside:judge");
    for (const l of [...(child ? [] : ["echo > $F arg"]), "busybox ash -c 'ls'", "busybox xargs ls", "bash -c 'f(){ rm -rf build; }; f'", "eval 'f(){ echo ok; }; f'"]) assert.equal(run("bash", l, child), "allow", `${child ? "child" : "foreman"}: ${l}`);
  }
});
