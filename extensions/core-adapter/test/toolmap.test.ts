import { test } from "node:test";
import assert from "node:assert/strict";
import { mapTool } from "../toolmap.ts";

test("shell tools map to Bash with the destructive guard, then the git guard", () => {
  for (const t of ["bash", "powershell"]) {
    assert.deepEqual(mapTool(t), { coreName: "Bash", pre: ["destructive_guard", "git_guard"], post: [] });
  }
});

test("write runs the write gate and binds; edit only binds", () => {
  assert.deepEqual(mapTool("write"), { coreName: "Write", pre: ["ledger_guard_write"], post: ["ledger_bind"] });
  assert.deepEqual(mapTool("edit"), { coreName: "Edit", pre: [], post: ["ledger_bind"] });
});

test("subagent maps to Agent with the spawn gate", () => {
  assert.deepEqual(mapTool("subagent"), { coreName: "Agent", pre: ["ledger_guard_spawn"], post: [] });
});

test("read-only tools, codemode and MCP tools fire nothing", () => {
  assert.equal(mapTool("read").coreName, "Read");
  assert.equal(mapTool("grep").coreName, "Grep");
  assert.equal(mapTool("find").coreName, "Glob");
  assert.equal(mapTool("ls").coreName, "Glob");
  for (const t of ["read", "grep", "find", "ls", "codemode", "mcp__github__search", "toString"]) {
    assert.deepEqual(mapTool(t).pre, []);
    assert.deepEqual(mapTool(t).post, []);
  }
  assert.equal(mapTool("codemode").coreName, null);
});
