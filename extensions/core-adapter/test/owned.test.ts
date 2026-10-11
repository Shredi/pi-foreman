import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { ownedRoots, resolveNpmRoot, underOwned } from "../owned.ts";
import type { SpawnResult, Spawner } from "../spawn.ts";

const agentDir = path.resolve("/t/agent");
const ok = (stdout: string): SpawnResult => ({ code: 0, stdout, stderr: "", timedOut: false });

test("owned: roots from agent dir, workspace and tmp", () => {
  const r = ownedRoots({ agentDir, workspaceRoot: path.resolve("/t/work/repo"), tmpRoot: path.resolve("/t/tmp"), npmRoot: path.resolve("/n/lib/node_modules") });
  assert.deepEqual(r.readWrite, [
    path.join(agentDir, "pi-foreman", "handoffs"),
    path.join(agentDir, "sessions", "*", "subagent-artifacts"),
    path.resolve("/t/work/repo.worktrees"),
  ]);
  assert.deepEqual(r.readOnly, [path.join(agentDir, "pi-foreman"), path.join(agentDir, "foreman.json"), path.join(agentDir, "settings.json"), path.resolve("/n/lib/node_modules")]);
  assert.equal(r.childScratchRoot, path.join(path.resolve("/t/tmp"), "pi-foreman-scratch"));
  assert.equal(ownedRoots({ agentDir, workspaceRoot: "/t/w", tmpRoot: "/t/tmp" }).readOnly.length, 3);
});

test("owned: underOwned handles wildcard segments and siblings", () => {
  const sa = path.join(agentDir, "sessions", "*", "subagent-artifacts");
  assert.ok(underOwned(sa, path.join(agentDir, "sessions", "abc", "subagent-artifacts", "x", "y")));
  assert.ok(underOwned(sa, path.join(agentDir, "sessions", "abc", "subagent-artifacts")));
  assert.ok(!underOwned(sa, path.join(agentDir, "sessions", "abc", "other")));
  assert.ok(!underOwned(sa, path.join(agentDir, "sessions", "abc", "subagent-artifacts-evil", "x")));
  assert.ok(!underOwned(path.join(agentDir, "pi-foreman", "handoffs"), path.join(agentDir, "pi-foreman", "handoffs2", "x")));
});

test("owned: npm root from `npm root -g`, once, with the 4 s cap", async () => {
  const calls: string[][] = [];
  const spawn: Spawner = async (cmd, args, o) => {
    calls.push([cmd, ...args, String(o.timeoutMs)]);
    return ok("/opt/npm/lib/node_modules\n");
  };
  assert.equal(await resolveNpmRoot({ spawn, env: { npm_config_prefix: "/ignored" }, platform: "linux", execPath: "/x/bin/node" }), "/opt/npm/lib/node_modules");
  assert.deepEqual(calls, [["npm", "root", "-g", "4000"]]);
});

test("owned: npm root fallbacks when npm fails", async () => {
  const bad: Spawner = async () => ({ code: null, stdout: "", stderr: "", timedOut: true });
  const thrown: Spawner = async () => {
    throw new Error("boom");
  };
  assert.equal(await resolveNpmRoot({ spawn: bad, env: { npm_config_prefix: "/p" }, platform: "linux", execPath: "/x/bin/node" }), "/p/lib/node_modules");
  assert.equal(await resolveNpmRoot({ spawn: thrown, env: {}, platform: "linux", execPath: "/x/bin/node" }), "/x/lib/node_modules");
  assert.equal(await resolveNpmRoot({ spawn: bad, env: { APPDATA: "C:\\U\\AppData\\Roaming" }, platform: "win32", execPath: "C:\\n\\node.exe" }), "C:\\U\\AppData\\Roaming\\npm\\node_modules");
  assert.equal(await resolveNpmRoot({ spawn: bad, env: {}, platform: "win32", execPath: "" }), null);
  const rel: Spawner = async () => ok("relative/dir\n");
  assert.equal(await resolveNpmRoot({ spawn: rel, env: { npm_config_prefix: "/q" }, platform: "linux", execPath: "" }), "/q/lib/node_modules");
});
