// PR B2 revision 3: a heredoc fed to a shell, compounds in a remote string, `$( )` nested past the walker's depth cap.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf-b2-rev3-"));
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



const refused = (line: string): void => {
  for (const child of [false, true]) assert.notEqual(run("bash", line, child), "allow", `${child ? "child" : "foreman"}: ${line}`);
};
const runs = (line: string): void => {
  for (const child of [false, true]) assert.equal(run("bash", line, child), "allow", `${child ? "child" : "foreman"}: ${line}`);
};

test("a shell that reads a heredoc or here-string runs its body: the body gets the checks", () => {
  const bodies = ["rm -rf $X", "find $X -delete", "echo hi > $F", "git clean -e x"];
  for (const sh of ["bash", "sh", "busybox sh", "sudo bash", "docker exec -i c sh"]) {
    for (const b of bodies) {
      if (sh === "sudo bash") continue;
      refused(`${sh} <<'E'\n${b}\nE`);
    }
    if (sh !== "sudo bash") runs(`${sh} <<'E'\nls\nE`);
  }
  for (const b of bodies) {
    refused(`bash <<< '${b}'`);
    refused(`sh <<E\n${b}\nE`);
    refused(`sh <<-E\n\t${b}\n\tE`);
  }
  for (const child of [false, true]) assert.notEqual(run("bash", "sudo bash <<'E'\nrm -rf $X\nE", child), "allow");
  runs("bash <<< 'ls'");
  runs("cat <<'E'\nrm -rf $X\nE");
  runs("cat <<< 'rm -rf $X'");
});

test("a compound command in a remote string reads as the same body without the compound", () => {
  for (const l of ["docker exec c sh -c 'if true; then echo hi > $F; fi'", "ssh h '{ echo hi > $F; }'", "docker exec c sh -c 'if true; then rm -rf /data; fi'", "docker exec c sh -c '{ rm -rf $X; }'"]) refused(l);
  for (const l of ["ssh h 'if true; then echo hi; fi'", "docker exec c sh -c 'while :; do echo hi; done'", "ssh h '{ ls; }'", "ssh h 'if true; then rm -rf /data; fi'", "docker exec c sh -c 'for i in 1 2; do echo $i; done'"]) runs(l);
});

test("each compound in a remote string has the verdict of its plain form, for ssh and docker", () => {
  const bodies = ["find /data -delete", "shred /x", "mkfs.ext4 /dev/sdb", "git clean -fd -e x", "echo hi > $F", "chmod -R 777 $D", "truncate -s 0 $F", "rm -rf /data"];
  const wraps: Array<[string, (b: string) => string]> = [["if", (b) => `if true; then ${b}; fi`], ["brace", (b) => `{ ${b}; }`], ["while", (b) => `while :; do ${b}; done`]];
  for (const b of bodies) {
    for (const [pre, plainPre] of [["ssh h", "ssh h"], ["docker exec c sh -c", "docker exec c sh -c"]]) {
      for (const child of [false, true]) {
        const plain = run("bash", `${plainPre} '${b}'`, child);
        for (const [name, w] of wraps) assert.equal(run("bash", `${pre} '${w(b)}'`, child), plain, `${child ? "child" : "foreman"} ${name}: ${pre} '${w(b)}' vs plain ${plain}`);
      }
    }
  }
});

test("a $( ) nested past the depth cap is refused unread; the harmless 5-deep line is reported", () => {
  for (const l of ["$($($($($(rm -rf $X)))))", "x=$(true; $(true; $(true; $(true; $(true; rm -rf ~)))))"]) refused(l);
  // the harmless 5-deep line is refused as well (deny for unreadable depth): the cap cannot tell it from a hidden delete
  const deep = "echo $(echo $(echo $(echo $(echo $(echo hi)))))";
  for (const child of [false, true]) assert.match(run("bash", deep, child), /^floor-delete-unknown-target:block$/);
  runs("echo $(echo $(echo hi))");
});
