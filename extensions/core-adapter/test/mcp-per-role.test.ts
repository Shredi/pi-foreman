// Probe for per-role MCP (round r15 item 4): a role whose generate_subagents tools carry `mcp:<server>` gets that
// server's tools through pi-subagents' built-in MCP path, and a role without it loads no MCP extension and starts no
// server. The whole chain is pi-subagents' own, no model call is made:
//   scripts/foreman_config.py generate-subagents (user-layer roles.<id>.mcp)  -> the role's `tools` list
//   -> an agent file with that list -> discoverAgents (its splitToolList turns `mcp:` entries into mcpDirectTools)
//   -> resolvePiLaunchToolPlan (the grant, against a parent host that really loaded mcp.json)
//   -> the detached-launch shape (ambientExtensions true) of the child session factory.
// Answer recorded here: `enabled: false` in mcp.json keeps the server off in the child too, so a server cannot be
// kept child-only that way (third test). pi-mcp-adapter is not installed and the built-in MCP path is the chosen one.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { createDefaultChildSessionFactory } from "../../../node_modules/pi-subagents/src/runs/shared/child-session.js";
import { resolvePiLaunchToolPlan } from "../../../node_modules/pi-subagents/src/runs/shared/child-tool-plan.js";
import { discoverAgents } from "../../../node_modules/pi-subagents/src/agents/agents.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const fixture = path.join(here, "fixtures", "mcp-fixture-server.mjs");
const CHILD_ROLES = ["planner", "explorer", "builder", "reviewer", "senior-reviewer", "finalizer"];

type Api = { getAllTools(): Array<{ name: string; exposure: string }>; getCommands(): Array<{ name: string }> };

interface Server {
  startMarker: string;
  exitMarker: string;
}

function writeMcpJson(agentDir: string, name: string, enabled: boolean | undefined): Server {
  fs.mkdirSync(agentDir, { recursive: true });
  const startMarker = path.join(agentDir, `${name}-started`);
  const exitMarker = path.join(agentDir, `${name}-exited`);
  const server: Record<string, unknown> = { command: process.execPath, args: [fixture, startMarker, exitMarker] };
  if (enabled !== undefined) server.enabled = enabled;
  fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fx: server } }));
  return { startMarker, exitMarker };
}

/** The role's tools exactly as `generate-subagents` writes them, with `mcp` set in the user-layer foreman config. */
function generatedTools(root: string, role: string, mcp: string[] | undefined): string[] {
  const dir = path.join(root, "foreman-agent");
  fs.mkdirSync(dir, { recursive: true });
  const roles = Object.fromEntries(["foreman", ...CHILD_ROLES].map((r) => [r, { model: `p1/m-${r}`, thinking: "low" }]));
  const config: Record<string, unknown> = { providers: { p1: { roles } } };
  if (mcp) config.roles = { [role]: { mcp } };
  fs.writeFileSync(path.join(dir, "foreman.json"), JSON.stringify(config));
  const run = spawnSync("python3", [path.join(repoRoot, "scripts", "foreman_config.py"), "generate-subagents",
    "--agent-dir", dir, "--project-dir", path.join(root, "no-project")], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: dir } });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const out = JSON.parse(run.stdout) as { subagents: { agentOverrides: Record<string, { tools: string[] }> } };
  return out.subagents.agentOverrides[role].tools;
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

/**
 * pi-subagents' parent-side grant host: a session that really loaded the parent's mcp.json (the parent's
 * built-in MCP, here via the factory's own built-in MCP extension). Its commands and tools are what
 * resolvePiLaunchToolPlan reads, so nothing about the grant is hand-built.
 */
async function withParentHost<T>(root: string, use: (host: Api) => Promise<T>): Promise<T> {
  const parentDir = path.join(root, "parent-agent");
  const server = writeMcpJson(parentDir, "parent", undefined);
  const factory = createDefaultChildSessionFactory({ builtinMcpToolWaitMs: 10_000 });
  const hook: { api?: Api } = {};
  const parent = await factory.create(launch(root, parentDir, {
    tools: ["mcp__fx__echo"],
    builtinMcpTools: [{ name: "mcp__fx__echo", selector: "fx" }],
  }, hook));
  try {
    assert.equal(await waitForFile(server.startMarker), true, "parent host did not start the server");
    return await use(hook.api!);
  } finally {
    await parent.dispose();
    await factory.dispose();
  }
}

/** Discover the role as an agent file carrying the generated tools, then plan its launch like pi-subagents does. */
function planFor(root: string, agentDir: string, tools: string[], host: Api) {
  const agentsDir = path.join(agentDir, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "probe-role.md"), `---\nname: probe-role\ndescription: probe\ntools: ${tools.join(", ")}\n---\nprobe\n`);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const agent = discoverAgents(root, "user", undefined, { projectTrusted: false }).agents.find(({ name }: { name: string }) => name === "probe-role");
    assert.ok(agent, "agent file not discovered");
    const plan = resolvePiLaunchToolPlan({
      tools: agent.tools,
      mcpDirectTools: agent.mcpDirectTools,
      requiredExtensions: [],
      cwd: root,
      agentName: "probe-role",
      runtimeSnapshotHost: host as never,
    });
    return { agent, plan };
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

function assertNoAdapter(host: Api): void {
  assert.equal(fs.existsSync(path.join(repoRoot, "node_modules", "pi-mcp-adapter")), false, "pi-mcp-adapter is installed");
  assert.equal(host.getCommands().some(({ name }) => /^mcp-adapter(?::\d+)?$/.test(name)), false, "host has an mcp-adapter command");
  assert.ok(host.getCommands().some(({ name }) => name === "mcp"), "host has no built-in /mcp command");
}

for (const [label, mcp, selector] of [["server only", ["fx"], "fx"], ["server/tool", ["fx/echo"], "fx/echo"]] as const) {
  test(`a builder with generated mcp:${selector} sees mcp__fx__echo and starts the server (${label}); a role without it does neither`, async () => {
    const root = mkTestTmp("mcp-per-role-");
    const agentDir = path.join(root, "agent");
    const server = writeMcpJson(agentDir, "child", undefined);
    const factory = createDefaultChildSessionFactory({ builtinMcpToolWaitMs: 10_000 });
    try {
      // Role A: the generated tools carry mcp:<selector>, pi-subagents splits and grants it.
      const toolsA = generatedTools(root, "builder", [...mcp]);
      assert.ok(toolsA.includes(`mcp:${selector}`), `generated tools: ${toolsA.join(", ")}`);
      const { agent, plan } = await withParentHost(root, async (host) => {
        assertNoAdapter(host);
        return planFor(root, agentDir, toolsA, host);
      });
      assert.deepEqual(agent.mcpDirectTools, [selector]);
      assert.ok(!agent.tools.some((tool: string) => tool.startsWith("mcp:")));
      // builtinMcpTools is set only when the grant went through Pi's built-in MCP, not an adapter.
      assert.deepEqual(plan.builtinMcpTools, [{ name: "mcp__fx__echo", selector }]);
      assert.deepEqual(plan.effectiveMcpTools, ["mcp__fx__echo"]);

      const roleA: { api?: Api } = {};
      const childA = await factory.create(launch(root, agentDir, {
        tools: plan.effectiveToolAllowlist,
        builtinMcpTools: plan.builtinMcpTools,
      }, roleA));
      try {
        assert.equal(await waitForFile(server.startMarker), true, "server did not start for role A");
        const direct = roleA.api!.getAllTools().filter((tool) => tool.exposure === "direct").map(({ name }) => name);
        assert.ok(direct.includes("mcp__fx__echo"), `role A direct tools: ${direct.join(", ")}`);
      } finally {
        await childA.dispose();
      }
      assert.equal(await waitForFile(server.exitMarker), true, "server was not shut down after role A disposed");
      fs.rmSync(server.exitMarker);
      fs.rmSync(server.startMarker);

      // Role B: the generated tools of a role without mcp carry no mcp: entry, so no builtinMcpTools, no MCP extension.
      const toolsB = generatedTools(root, "builder", undefined);
      assert.equal(toolsB.some((tool) => tool.startsWith("mcp:")), false);
      const planB = await withParentHost(root, async (host) => planFor(root, agentDir, toolsB, host).plan);
      assert.equal(planB.builtinMcpTools, undefined);
      assert.deepEqual(planB.effectiveMcpTools, []);
      const roleB: { api?: Api } = {};
      const childB = await factory.create(launch(root, agentDir, { tools: planB.effectiveToolAllowlist }, roleB));
      try {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        assert.equal(fs.existsSync(server.startMarker), false, "server started for role B");
        const mcpTools = roleB.api!.getAllTools().filter(({ name }) => name.startsWith("mcp__")).map(({ name }) => name);
        assert.deepEqual(mcpTools, []);
        assert.equal(roleB.api!.getCommands().some(({ name }) => name === "mcp"), false, "role B has the /mcp command");
      } finally {
        await childB.dispose();
      }
    } finally {
      await factory.dispose();
      rmTestTmp(root);
    }
  });
}

test("enabled: false keeps the server off in the child, so a server cannot be kept child-only that way", async () => {
  const root = mkTestTmp("mcp-per-role-");
  const agentDir = path.join(root, "agent");
  const server = writeMcpJson(agentDir, "child", false);
  const factory = createDefaultChildSessionFactory({ builtinMcpToolWaitMs: 1500 });
  try {
    const tools = generatedTools(root, "builder", ["fx/echo"]);
    // The parent host (its own, enabled mcp.json) grants the selector; the child reads the disabled one.
    const { plan } = await withParentHost(root, async (host) => planFor(root, agentDir, tools, host));
    assert.deepEqual(plan.builtinMcpTools, [{ name: "mcp__fx__echo", selector: "fx/echo" }]);
    await assert.rejects(
      factory.create(launch(root, agentDir, { tools: plan.effectiveToolAllowlist, builtinMcpTools: plan.builtinMcpTools }, {})),
      /did not register in the child session: mcp__fx__echo/,
    );
    assert.equal(fs.existsSync(server.startMarker), false, "disabled server was started");
  } finally {
    await factory.dispose();
    rmTestTmp(root);
  }
});
