// Probe for per-role MCP (round r15 item 4): a role whose tools carry `mcp:<server>` gets that server's tools
// through pi-subagents' built-in MCP path, and a role without it loads no MCP extension and starts no server.
// Uses the detached-launch shape (ambientExtensions true) and a stdio fixture server; no model call is made.
// Answer recorded here: `enabled: false` in mcp.json keeps the server off in the child too (second test).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { createDefaultChildSessionFactory } from "../../../node_modules/pi-subagents/src/runs/shared/child-session.js";
import { resolveMcpDirectToolResolution } from "../../../node_modules/pi-subagents/src/runs/shared/mcp-direct-tool-allowlist.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-fixture-server.mjs");

interface Fixture {
  root: string;
  agentDir: string;
  startMarker: string;
  exitMarker: string;
}

function writeFixture(enabled: boolean | undefined): Fixture {
  const root = mkTestTmp("mcp-per-role-");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const startMarker = path.join(root, "server-started");
  const exitMarker = path.join(root, "server-exited");
  const server: Record<string, unknown> = { command: process.execPath, args: [fixture, startMarker, exitMarker] };
  if (enabled !== undefined) server.enabled = enabled;
  fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fx: server } }));
  return { root, agentDir, startMarker, exitMarker };
}

/** The builtin selection Pi's MCP host would grant for an agent that lists `mcp:fx/echo`. */
function grantFor(root: string, selector: string) {
  const host = {
    getCommands: () => [{ name: "mcp", sourceInfo: { path: "builtin:mcp" } }],
    getAllTools: () => [{
      name: "mcp__fx__echo",
      label: "fx/echo",
      exposure: "codemode",
      namespace: { name: "mcp__fx" },
    }],
  };
  const resolution = resolveMcpDirectToolResolution([selector], root, host as never);
  assert.deepEqual(resolution.unresolvedSelectors, []);
  return resolution.selections;
}

function launch(root: string, agentDir: string, extra: Record<string, unknown>, hook: { api?: unknown }) {
  return {
    cwd: root,
    storage: { kind: "memory" },
    extensionPaths: [],
    hooks: [{ name: "probe", factory: (api: unknown) => { hook.api = api; } }],
    ambientExtensions: true,
    noSkills: true,
    noContextFiles: true,
    runtime: {},
    processEnv: { PI_CODING_AGENT_DIR: agentDir },
    projectTrusted: false,
    ...extra,
  } as never;
}

async function waitForFile(file: string): Promise<boolean> {
  for (let waited = 0; waited < 5000; waited += 50) {
    if (fs.existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("a role with mcp:fx sees mcp__fx__echo and starts the server; a role without it does neither", async () => {
  const fx = writeFixture(undefined);
  const factory = createDefaultChildSessionFactory({ builtinMcpToolWaitMs: 10_000 });
  try {
    // Role A: tools include mcp:fx, so the launch carries the selection the grant produced.
    const roleA = { api: undefined as { getAllTools(): Array<{ name: string; exposure: string }> } | undefined };
    const selections = grantFor(fx.root, "fx/echo");
    const childA = await factory.create(launch(fx.root, fx.agentDir, {
      tools: selections.map(({ name }) => name),
      builtinMcpTools: selections,
    }, roleA));
    try {
      assert.equal(await waitForFile(fx.startMarker), true, "server did not start for role A");
      const direct = roleA.api!.getAllTools().filter((tool) => tool.exposure === "direct").map(({ name }) => name);
      assert.ok(direct.includes("mcp__fx__echo"), `role A direct tools: ${direct.join(", ")}`);
    } finally {
      await childA.dispose();
    }
    assert.equal(await waitForFile(fx.exitMarker), true, "server was not shut down after role A disposed");
    fs.rmSync(fx.exitMarker);
    fs.rmSync(fx.startMarker);

    // Role B: no mcp entry, so no builtinMcpTools and no MCP extension in the child.
    const roleB = { api: undefined as { getAllTools(): Array<{ name: string }>; getCommands(): Array<{ name: string }> } | undefined };
    const childB = await factory.create(launch(fx.root, fx.agentDir, { tools: ["read"] }, roleB));
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal(fs.existsSync(fx.startMarker), false, "server started for role B");
      const mcpTools = roleB.api!.getAllTools().filter(({ name }) => name.startsWith("mcp__")).map(({ name }) => name);
      assert.deepEqual(mcpTools, []);
      assert.equal(roleB.api!.getCommands().some(({ name }) => name === "mcp"), false, "role B has the /mcp command");
    } finally {
      await childB.dispose();
    }
  } finally {
    await factory.dispose();
    rmTestTmp(fx.root);
  }
});

test("enabled: false keeps the server off in the child, so the selected tool never registers", async () => {
  const fx = writeFixture(false);
  const factory = createDefaultChildSessionFactory({ builtinMcpToolWaitMs: 1500 });
  try {
    const selections = grantFor(fx.root, "fx/echo");
    // grantFor reads the fake host, not mcp.json, so the selection is the same; the child's MCP host decides.
    await assert.rejects(
      factory.create(launch(fx.root, fx.agentDir, {
        tools: selections.map(({ name }) => name),
        builtinMcpTools: selections,
      }, {})),
      /did not register in the child session: mcp__fx__echo/,
    );
    assert.equal(fs.existsSync(fx.startMarker), false, "disabled server was started");
  } finally {
    await factory.dispose();
    rmTestTmp(fx.root);
  }
});
