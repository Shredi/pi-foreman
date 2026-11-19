// PR B2: one row per restored form, with the floor that refuses it (the parity test checks the whole fixture; these pin the rule names and kinds).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf-restored-"));
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

const HARD: Array<[string, string]> = [
  ["busybox rm -rf ~", "floor-rm-system"], ["toybox rm -rf ~", "floor-rm-system"], ["busybox sh -c 'rm -rf ~'", "floor-rm-system"], ["f(){ rm -rf ~; }; f", "floor-rm-system"],
  ["function g { rm -rf $1; }; g x", "floor-delete-unknown-target"], ["f(){ mkfs.ext4 /dev/sdb; }; f", "floor-disk"], ["git clean -fd $X", "floor-delete-unknown-target"], ["git clean -fd -e keep", "floor-git-clean-exclude"],
  ["docker exec c rm -rf /data", "floor-remote-command"], ["kubectl exec p -- rm -rf /data", "floor-remote-command"], ["cd $D && rm -rf build", "floor-delete-unknown-target"], ["find . -exec rm -rf {} +", "floor-delete-unknown-target"],
  ["busybox sh -c 'rm -rf /opt/x'", "floor-delete-outside"], ["ls | xargs shred", "floor-delete-unknown-target"], ["git -C sub clean -fd $X", "floor-delete-unknown-target"], ["echo hi > $F", "floor-unknown-write-target"], ["cat <<EOF > $F\nx\nEOF", "floor-unknown-write-target"],
];
test("restored hard stops: refused with their floor for the foreman and a child", () => {
  for (const [l, rule] of HARD) for (const child of [false, true]) assert.equal(run("bash", l, child), `${rule}:block`, `${child ? "child" : "foreman"}: ${l}`);
});

test("restored ask-kind floors: a dialog for the foreman, a refusal for a child (the gate result is an ask)", () => {
  for (const [tool, l, rule] of [["powershell", "iex $s", "floor-ps-unreadable"], ["powershell", "pwsh -EncodedCommand AAAA", "floor-ps-unreadable"], ["powershell", "Remove-Item @p", "floor-ps-unreadable"], ["powershell", "Get-ChildItem | Remove-Item -Recurse", "floor-ps-unreadable"],
    ["bash", "f(){ rm -rf /opt/x; }; f", "floor-delete-outside"]] as const) for (const child of [false, true]) assert.equal(run(tool, l, child), `${rule}:ask`, `${child ? "child" : "foreman"}: ${l}`);
});

test("PowerShell: -LiteralPath:C:\\Windows is a system delete", () => {
  assert.equal(run("powershell", "Remove-Item -Recurse -LiteralPath:C:\\Windows"), "floor-rm-system:block");
});

test("lines the old check let run still run: narrowed redirect, ssh rm, literal iex, bare glob in the worktree, other remote kinds over ssh and in a container", () => {
  for (const l of ["echo > $F arg", "echo hi >| $F", "echo hi > $F # c", "( echo hi > $F )", "ssh host 'rm -rf /data'", "ssh host shred /x", "docker exec c shred /x", "rm -rf *"]) assert.equal(run("bash", l), "allow", l);
  assert.equal(run("powershell", "iex 'Get-Date'"), "allow");
});
