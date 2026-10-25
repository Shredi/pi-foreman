// R41 phase A (A5, ledger item 21): egrep/fgrep recursion in the own-read chain, whole-filesystem scan denies, and the write floors
// (policy files of every layer, safety.permissions*/safety.policy*/gate.* config keys, harness state files).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, ownStateRead, readBaseline, type Decision, type MatchCtx } from "../permoverlay.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const agentDir = "/pf41/agent";
const pkg = "/pf41/pkg";
const home = "/Users/pf41home";
const cwd = `${home}/code/proj`;
const custom = "/pf41/custom-policy.md";
const rules = buildOverlayRules(readBaseline(PKG)!, {}, {}, agentDir, pkg, undefined, false, undefined, [custom]);
const plain = { ...rules, floors: undefined };
const ctx = (role: "main" | "child" = "main"): MatchCtx => ({ cwd, home, platform: process.platform, role });
const bash = (command: string, role: "main" | "child" = "main", r = rules): Decision | null => checkToolCall(r, "bash", { command }, ctx(role));
const tool = (name: string, input: Record<string, unknown>, role: "main" | "child" = "main", r = rules): Decision | null => checkToolCall(r, name, input, ctx(role));

test("r41: egrep/fgrep/grep -E recursion never joins an own-read chain", () => {
  const own = `${agentDir}/pi-foreman/state/usage/s1.jsonl`;
  const c: MatchCtx = { ...ctx(), ownReads: [own] };
  assert.equal(ownStateRead(`cat ${own}; grep x ${own}`, c), true);
  assert.equal(ownStateRead(`cat ${own}; egrep x /pf41/other.txt`, c), true);
  for (const unit of ["grep -r x /pf41", "egrep -r x /pf41", "fgrep -R x /pf41", "egrep -rn x /pf41", "grep -Er x /pf41", "grep -E -r x /pf41", "fgrep --recursive x /pf41", "egrep -d recurse x /pf41", "grep -P -R x /pf41", "grep -G --directories=recurse x /pf41"]) {
    assert.equal(ownStateRead(`cat ${own}; ${unit}`, c), false, unit);
  }
});

const SCANS: [string, (root: string) => string][] = [
  ["find", (r) => `find ${r} -name x`],
  ["grep -r", (r) => `grep -r foo ${r}`],
  ["grep -R", (r) => `grep -Rn foo ${r}`],
  ["egrep -r", (r) => `egrep -r foo ${r}`],
  ["rg", (r) => `rg foo ${r}`],
  ["fd", (r) => `fd . ${r}`],
  ["du", (r) => `du -sh ${r}`],
  ["ls -R", (r) => `ls -R ${r}`],
  ["tree", (r) => `tree -L 2 ${r}`],
];

test("r41: a scan of /, the home directory or a parent of the workspace is denied, naming the allowed roots", () => {
  for (const role of ["main", "child"] as const) {
    for (const [name, mk] of SCANS) {
      for (const root of ["/", home, "$HOME", "~", `${home}/code`, "/Users"]) {
        const d = bash(mk(root), role);
        assert.equal(d?.kind, "deny", `${name} ${root} ${role}`);
        assert.equal(d!.rule, "fs-scan", `${name} ${root}`);
        assert.match(d!.reason, /whole-filesystem scan/);
        assert.match(d!.reason, new RegExp(`the worktree ${cwd}`));
        assert.match(d!.reason, /\/tmp.*Pi install root.*global npm root.*bundled package roots/);
      }
    }
  }
  assert.equal(bash("bash -c 'find / -name x'")?.rule, "fs-scan");
  assert.equal(bash("cd /tmp && find /")?.rule, "fs-scan");
  assert.equal(tool("find", { path: "/", pattern: "*.ts" })?.rule, "fs-scan");
  assert.equal(tool("grep", { path: home, pattern: "x" })?.rule, "fs-scan");
  assert.equal(tool("grep", { pattern: "x" })?.rule, undefined);
});

test("r41: a scan of an allowed root is not a scan deny", () => {
  for (const [name, mk] of SCANS) {
    for (const root of [cwd, `${cwd}/src`, "/tmp", "/tmp/x", pkg, "."]) {
      const d = bash(mk(root));
      assert.notEqual(d?.rule, "fs-scan", `${name} ${root}`);
    }
  }
  assert.notEqual(bash("grep foo /")?.rule, "fs-scan");
  assert.notEqual(bash("ls /")?.rule, "fs-scan");
  assert.notEqual(tool("find", { path: cwd, pattern: "*.ts" })?.rule, "fs-scan");
});

const FLOORED = [
  `${pkg}/config/permissions.policy.md`,
  `${agentDir}/pi-foreman/policy.md`,
  custom,
  `${cwd}/.workflow/policy.md`,
  `${agentDir}/pi-foreman/managed.json`,
  `${agentDir}/pi-foreman/state/round-parents.json`,
  `${agentDir}/pi-foreman/state/bridge-trust.json`,
  `${agentDir}/pi-foreman/state/approvals/a1.json`,
  `${agentDir}/pi-foreman/state/approvals/sub/deep.json`,
  `${agentDir}/pi-foreman/state/gate/g1.json`,
];

test("r41: a tool write to a floored file is denied for every role", () => {
  for (const role of ["main", "child"] as const) {
    for (const f of FLOORED) {
      for (const name of ["write", "edit"]) {
        const d = tool(name, { path: f, content: "x", newText: "x" }, role);
        assert.equal(d?.kind, "deny", `${name} ${f}`);
        assert.equal(d!.rule, "floor", `${name} ${f}`);
        assert.match(d!.reason, /floor/);
      }
      assert.equal(tool("foreman_move", { src: `${cwd}/a`, dst: f }, role)?.rule, "floor", f);
      assert.equal(tool("foreman_copy", { src: `${cwd}/a`, dst: f }, role)?.rule, "floor", f);
    }
  }
});

test("r41: a shell write to a floored file is denied (redirect, tee, sed -i, cp, mv)", () => {
  for (const role of ["main", "child"] as const) {
    for (const f of FLOORED) {
      for (const cmd of [`echo x > ${f}`, `echo x >> ${f}`, `echo x | tee ${f}`, `sed -i s/a/b/ ${f}`, `cp ${cwd}/a ${f}`, `mv ${cwd}/a ${f}`, `bash -c 'echo x > ${f}'`]) {
        const d = bash(cmd, role);
        assert.equal(d?.kind, "deny", cmd);
        assert.equal(d!.rule, "floor", cmd);
      }
    }
  }
});

test("r41: a read of a floored file is no floor deny", () => {
  for (const f of FLOORED) assert.notEqual(bash(`cat ${f}`)?.rule, "floor", f);
  assert.notEqual(tool("read", { path: FLOORED[0] })?.rule, "floor");
});

test("r41: floor is not lifted by an owned root with a policy-relative path", () => {
  const owned = { readWrite: [`${agentDir}/pi-foreman`], readOnly: [], childScratchRoot: "/tmp/pi-foreman-scratch" };
  const r = buildOverlayRules(readBaseline(PKG)!, {}, {}, agentDir, pkg, undefined, false, owned, [custom]);
  assert.equal(checkToolCall(r, "bash", { command: `echo x > ${agentDir}/pi-foreman/managed.json` }, { ...ctx(), owned })?.rule, "floor");
  assert.equal(checkToolCall(r, "write", { path: `${agentDir}/pi-foreman/state/approvals/x`, content: "x" }, { ...ctx(), owned })?.rule, "floor");
});

test("r41: the permissions, policy and gate keys of a foreman config file are floored", () => {
  for (const f of [`${agentDir}/foreman.json`, `${cwd}/.pi/foreman.json`, `${pkg}/config/foreman.defaults.json`]) {
    for (const key of ['"safety":{"permissions":{"deny":[]}}', '{"safety":{"policy":{"files":[]}}}', '{"gate":{"on":false}}', '"policyMode": "off"']) {
      const w = tool("write", { path: f, content: `{${key}}` });
      assert.equal(w?.rule, "floor", `${f} ${key}`);
      assert.match(w!.reason, /safety\.permissions\*, safety\.policy\* or gate\.\*/);
      assert.equal(tool("edit", { path: f, edits: [{ oldText: "a", newText: key }] })?.rule, "floor", f);
      assert.equal(bash(`echo '${key}' > ${f}`)?.rule, "floor", f);
      assert.equal(bash(`echo '${key}' | tee ${f}`)?.rule, "floor", f);
    }
    assert.notEqual(tool("write", { path: f, content: '{"trace":{"dir":"x"}}' })?.rule, "floor", f);
  }
});

test("r41: an allowed write inside the worktree is unchanged", () => {
  for (const [name, input] of [["write", { path: `${cwd}/src/a.ts`, content: "x" }], ["edit", { path: `${cwd}/src/a.ts`, newText: "gate permissions policy" }], ["write", { path: `${cwd}/foreman.json`, content: '{"trace":1}' }]] as const) {
    assert.deepEqual(tool(name, input), tool(name, input, "main", plain as typeof rules), `${name} ${input.path}`);
    assert.notEqual(tool(name, input)?.rule, "floor");
  }
  for (const cmd of [`echo x > ${cwd}/out.txt`, `sed -i s/a/b/ ${cwd}/src/a.ts`, `cp ${cwd}/a ${cwd}/b`, `mv ${cwd}/a ${cwd}/b`, `echo x | tee ${cwd}/t.txt`]) {
    assert.deepEqual(bash(cmd), bash(cmd, "main", plain as typeof rules), cmd);
    assert.notEqual(bash(cmd)?.rule, "floor", cmd);
  }
});
