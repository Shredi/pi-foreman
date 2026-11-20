// PR B2 forms, re-based on PR C: one row per restored form, with the floor that refuses it or the judge-first label it gets (the parity test checks the whole fixture; these pin the rule names).
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
/** The gate result: "<rule>:block" or "<rule>:ask", "<danger>:judge" when the call goes to the judge first (PR C), "allow" when nothing decided. */
const run = (tool: string, command: string, child = false): string => {
  const o = gateEvaluate(tool, { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { scratch: [scr], home: "/Users/fixture", ...(child ? { child: true, builder: true } : {}) }), roots: () => roots(child) });
  const x = o.result;
  return x && "block" in x ? `${x.rule}:block` : x && "ask" in x ? `${x.rule}:ask` : o.danger ? `${o.danger.name}:judge` : "allow";
};

/** The forms that stay floors (literal system deletes, the rare local forms, a disk format in a body) and what the other restored forms are now: judge-first. */
const HARD: Array<[string, string]> = [
  ["busybox rm -rf ~", "floor-rm-system"], ["toybox rm -rf ~", "floor-rm-system"], ["busybox sh -c 'rm -rf ~'", "floor-rm-system"], ["f(){ rm -rf ~; }; f", "floor-rm-system"],
  ["f(){ mkfs.ext4 /dev/sdb; }; f", "floor-disk"],
];
const JUDGED: Array<[string, string]> = [
  ["function g { rm -rf $1; }; g x", "danger-delete-unknown-target"], ["git clean -fd $X", "danger-delete-unknown-target"], ["git clean -fd -e keep", "danger-git"],
  ["docker exec c rm -rf /data", "danger-remote-command"], ["kubectl exec p -- rm -rf /data", "danger-remote-command"], ["cd $D && rm -rf build", "danger-delete-unknown-target"], ["find . -exec rm -rf {} +", "danger-delete-unknown-target"],
  ["busybox sh -c 'rm -rf /opt/x'", "danger-delete-unknown-target"], ["ls | xargs shred", "danger-delete-unknown-target"], ["git -C sub clean -fd $X", "danger-delete-unknown-target"], ["echo hi > $F", "danger-unknown-write-target"], ["cat <<EOF > $F\nx\nEOF", "danger-unknown-write-target"],
  ["chmod -R 777 $X", "danger-unknown-write-target"], ["truncate -s 0 $X", "danger-unknown-write-target"], ["dd of=$X if=/dev/zero", "danger-unknown-write-target"], ["find $X -delete", "danger-delete-unknown-target"],
  ["ssh h 'ls; truncate -s 0 $X'", "danger-remote-command"],
];
test("the forms that stay floors: refused with their floor for the foreman and a child", () => {
  for (const [l, rule] of HARD) for (const child of [false, true]) assert.equal(run("bash", l, child), `${rule}:block`, `${child ? "child" : "foreman"}: ${l}`);
});

test("the restored forms that moved go to the judge first with their label, for the foreman and a child", () => {
  // a child's unresolved `cd` target is the child write check's floor (child-write-outside) before the judge-first list
  for (const [l, label] of JUDGED) for (const child of [false, true]) {
    const got = run("bash", l, child);
    if (child && got === "child-write-outside:block") continue;
    assert.equal(got, `${label}:judge`, `${child ? "child" : "foreman"}: ${l}`);
  }
});

test("the judge-first PowerShell forms: the owner's question before PR C is the judge's now", () => {
  for (const [tool, l, label] of [["powershell", "iex $s", "danger-delete-unknown-target"], ["powershell", "pwsh -EncodedCommand AAAA", "danger-delete-unknown-target"], ["powershell", "Remove-Item @p", "danger-delete-unknown-target"], ["powershell", "Get-ChildItem | Remove-Item -Recurse", "danger-delete-unknown-target"],
    ["bash", "f(){ rm -rf /opt/x; }; f", "danger-delete-unknown-target"]] as const) for (const child of [false, true]) assert.equal(run(tool, l, child), `${label}:judge`, `${child ? "child" : "foreman"}: ${l}`);
});

test("PowerShell: -LiteralPath:C:\\Windows is a system delete", () => {
  assert.equal(run("powershell", "Remove-Item -Recurse -LiteralPath:C:\\Windows"), "floor-rm-system:block");
});

test("lines the old check let run still run: narrowed redirect, ssh rm, literal iex, bare glob in the worktree, other remote kinds over ssh and in a container", () => {
  for (const l of ["echo > $F arg", "echo hi >| $F", "ssh host 'rm -rf /data'", "ssh host shred /x", "docker exec c shred /x", "rm -rf *"]) assert.equal(run("bash", l), "allow", l);
  assert.equal(run("powershell", "iex 'Get-Date'"), "allow");
});
