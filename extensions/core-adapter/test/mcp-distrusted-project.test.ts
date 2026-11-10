// Pi 1.5 returns false from ctx.isProjectTrusted() for a project with a saved "Do not trust", even one with no
// trust-requiring resources. The MCP paths pass that answer straight to Pi's loader, so a distrusted project's
// .pi/mcp.json must add no server.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { McpChild, configuredServers } from "../mcpchild.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

function world() {
  const root = mkTestTmp("mcp-distrust-");
  const agentDir = path.join(root, "agent");
  const project = path.join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { globalfx: { command: "node" } } }));
  fs.writeFileSync(path.join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { projfx: { command: "node" } } }));
  return { root, agentDir, project, env: { PI_CODING_AGENT_DIR: agentDir } };
}

test("configuredServers: a distrusted project adds no project server, a trusted one does", async () => {
  const w = world();
  try {
    assert.deepEqual(await configuredServers(w.project, false, w.env), ["globalfx"]);
    assert.deepEqual((await configuredServers(w.project, true, w.env))?.sort(), ["globalfx", "projfx"]);
  } finally {
    rmTestTmp(w.root);
  }
});

test("McpChild.loadConfig follows ctx.isProjectTrusted(): false hides the project server", async () => {
  const w = world();
  try {
    let loadConfig: ((ctx: unknown) => { servers: { name: string }[] }) | undefined;
    const createMcp = (o: { loadConfig: typeof loadConfig }) => (_pi: unknown) => {
      loadConfig = o.loadConfig;
    };
    const api = { on: () => {}, registerTool: () => {}, getActiveTools: () => ["tool_search"], setActiveTools: () => {}, getAllTools: () => [] };
    const mcp = new McpChild(api as never, { binding: { role: "builder", mcp: ["globalfx", "projfx"] }, env: w.env, createMcp });
    mcp.install();
    await mcp.start({ builder: { mcp: ["globalfx", "projfx"] } }, () => {});
    const names = (trusted: () => boolean) => loadConfig!({ cwd: w.project, isProjectTrusted: trusted }).servers.map((s) => s.name).sort();
    assert.deepEqual(names(() => true), ["globalfx", "projfx"]);
    assert.deepEqual(names(() => false), ["globalfx"]);
  } finally {
    rmTestTmp(w.root);
  }
});
