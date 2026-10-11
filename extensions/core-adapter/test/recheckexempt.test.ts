import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { ownedRoots } from "../owned.ts";
import { recheckExempt } from "../recheckexempt.ts";

const agentDir = path.resolve("/t/agent");
const cwd = path.resolve("/t/work/repo");
const owned = ownedRoots({ agentDir, workspaceRoot: cwd, tmpRoot: path.resolve("/t/tmp") });
const ctx = { cwd, home: path.resolve("/t/home"), platform: process.platform, owned };
const handoff = path.join(agentDir, "pi-foreman", "handoffs", "r1", "result.md");

test("recheckexempt: reads under the handoffs dir are exempt", () => {
  assert.equal(recheckExempt("read", { path: handoff }, ctx), true);
  assert.equal(recheckExempt("ls", { path: path.join(agentDir, "pi-foreman", "handoffs") }, ctx), true);
  assert.equal(recheckExempt("read", { path: path.join(agentDir, "pi-foreman", "handoffs", "r1", "ruling.md") }, ctx), true);
  assert.equal(recheckExempt("bash", { command: `cat ${handoff}` }, ctx), true);
});

test("recheckexempt: worktree reads, a ruling.md elsewhere and other pi-foreman dirs count", () => {
  assert.equal(recheckExempt("read", { path: "ruling.md" }, ctx), false);
  assert.equal(recheckExempt("read", { path: "docs/ruling.md" }, ctx), false);
  assert.equal(recheckExempt("bash", { command: "cat ruling.md" }, ctx), false);
  assert.equal(recheckExempt("read", { path: path.join(agentDir, "pi-foreman", "ruling.md") }, ctx), false);
  assert.equal(recheckExempt("read", { path: path.join(agentDir, "pi-foreman", "state", "sessions.json") }, ctx), false);
  assert.equal(recheckExempt("read", { path: path.resolve("/t/work/repo.worktrees/b1/src/a.ts") }, ctx), false);
  assert.equal(recheckExempt("bash", { command: `ls ${path.resolve("/t/work/repo.worktrees")}` }, ctx), false);
  assert.equal(recheckExempt("bash", { command: `cat ${path.join(agentDir, "pi-foreman", "handoffs", "..", "state", "x")}` }, ctx), false);
});

test("recheckexempt: git worktree add|list|prune are exempt, other git is not", () => {
  for (const c of ["git worktree add ../x -b y", "git worktree list", "git worktree prune", "git -C /t/work/repo worktree list"]) assert.equal(recheckExempt("bash", { command: c }, ctx), true, c);
  assert.equal(recheckExempt("bash", { command: "git worktree remove x" }, ctx), false);
  assert.equal(recheckExempt("bash", { command: "git diff" }, ctx), false);
});

test("recheckexempt: a plain read in the workspace still counts", () => {
  assert.equal(recheckExempt("read", { path: "src/a.ts" }, ctx), false);
  assert.equal(recheckExempt("read", { path: path.join(cwd, "src/a.ts") }, ctx), false);
  assert.equal(recheckExempt("read", {}, ctx), false);
  assert.equal(recheckExempt("bash", { command: "cat src/a.ts" }, ctx), false);
  assert.equal(recheckExempt("bash", { command: `cat ${handoff} src/a.ts` }, ctx), false);
  assert.equal(recheckExempt("bash", { command: "cat $(echo x)/ruling.md" }, ctx), false);
  assert.equal(recheckExempt("edit", { path: handoff }, ctx), false);
});
