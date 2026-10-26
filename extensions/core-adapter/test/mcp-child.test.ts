// MCP tools on demand in a child (round 68): the real child session factory of pi-subagents loads core-adapter with a
// launch binding in the env, a role config in the agent dir and the fixture MCP server in mcp.json. No model call.
// core-adapter registers Pi's tool_search, hands Pi's MCP extension a config filtered to the role's scope and drops
// tool_search from the active set when nothing is allowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { createDefaultChildSessionFactory } from "../../../node_modules/pi-subagents/src/runs/shared/child-session.js";
import { createToolSearchToolDefinition } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/tool-search/tool.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const adapter = path.resolve(here, "..", "index.ts");
const fixture = path.join(here, "fixtures", "mcp-fixture-server.mjs");

type Tool = { name: string; exposure: string };
type Api = { getAllTools(): Tool[]; getActiveTools(): string[]; setActiveTools(names: string[]): void };

interface Setup {
  /** `roles.builder.mcp` and friends in the user's foreman.json. */
  roles?: Record<string, unknown>;
  /** The launch binding's `mcp` (absent = no narrowing). */
  launchMcp?: string[];
  /** Replaces the fixture server entry of mcp.json. */
  server?: Record<string, unknown>;
  /** No launch binding at all. */
  noBinding?: boolean;
  role?: string;
}

async function waitFor(pred: () => boolean, ms = 10_000): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 50) {
    if (pred()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return pred();
}

async function withChild(setup: Setup, use: (c: { api: Api; startMarker: string; exitMarker: string; agentDir: string }) => Promise<void>): Promise<{ exited: boolean }> {
  const root = mkTestTmp("mcp-child-");
  const agentDir = path.join(root, "agent");
  const project = path.join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const startMarker = path.join(root, "fx-started");
  const exitMarker = path.join(root, "fx-exited");
  const server = setup.server ?? { command: process.execPath, args: [fixture, startMarker, exitMarker] };
  fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fx: server } }));
  const roleIds = ["planner", "explorer", "builder", "reviewer", "senior-reviewer", "finalizer"];
  const providers = { p1: { roles: Object.fromEntries(["foreman", ...roleIds].map((r) => [r, { model: `p1/m-${r}`, thinking: "low" }])) } };
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ providers, roles: setup.roles ?? {}, trace: { enabled: true } }));
  const role = setup.role ?? "builder";
  const binding = { foremanSession: "fs-1", workspace: project, role, launchId: "L1", kind: "first", model: null, ...(setup.launchMcp ? { mcp: setup.launchMcp } : {}) };
  const saved = { dir: process.env.PI_CODING_AGENT_DIR, child: process.env.PI_SUBAGENT_CHILD, bindings: process.env.PI_SUBAGENT_EXTENSION_BINDINGS };
  const factory = createDefaultChildSessionFactory({ builtinMcpToolWaitMs: 10_000 });
  const hook: { api?: Api } = {};
  let session: { dispose(): Promise<void> } | undefined;
  try {
    session = (await factory.create({
      cwd: project,
      storage: { kind: "memory" },
      extensionPaths: [adapter],
      hooks: [{ name: "probe", factory: (api: unknown) => { hook.api = api as Api; } }],
      ambientExtensions: false,
      noSkills: true,
      noContextFiles: true,
      runtime: {},
      tools: ["read", "tool_search"],
      processEnv: {
        PI_CODING_AGENT_DIR: agentDir,
        PI_SUBAGENT_CHILD: "1",
        ...(setup.noBinding ? { PI_SUBAGENT_EXTENSION_BINDINGS: "" } : { PI_SUBAGENT_EXTENSION_BINDINGS: JSON.stringify({ "pi-foreman/1": binding }) }),
      },
      projectTrusted: false,
    } as never)) as never;
    await use({ api: hook.api!, startMarker, exitMarker, agentDir });
  } finally {
    await session?.dispose();
    await factory.dispose();
    for (const [key, value] of [["PI_CODING_AGENT_DIR", saved.dir], ["PI_SUBAGENT_CHILD", saved.child], ["PI_SUBAGENT_EXTENSION_BINDINGS", saved.bindings]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const exited = await waitFor(() => fs.existsSync(exitMarker), 3000).catch(() => false);
  rmTestTmp(root);
  return { exited };
}

const mcpTools = (api: Api): string[] => api.getAllTools().filter(({ name }) => name.startsWith("mcp__")).map(({ name }) => name);
const quiet = (ms = 1500): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("a builder allowed fx starts the server, has tool_search active and mcp__fx__echo registered but not active; tool_search loads it", async () => {
  await withChild({ roles: { builder: { mcp: ["fx"] } } }, async ({ api, startMarker }) => {
    assert.equal(await waitFor(() => fs.existsSync(startMarker)), true, "the server did not start");
    assert.equal(await waitFor(() => mcpTools(api).includes("mcp__fx__echo")), true, `registered: ${mcpTools(api).join(", ")}`);
    assert.ok(api.getActiveTools().includes("tool_search"), `active: ${api.getActiveTools().join(", ")}`);
    assert.equal(api.getActiveTools().includes("mcp__fx__echo"), false);
    // the same definition createToolSearchExtension registers, run against the child's own api
    const search = createToolSearchToolDefinition({ tools: api as never }) as unknown as { execute(id: string, params: { query: string }): Promise<unknown> };
    const found = await search.execute("t1", { query: "echo" });
    assert.match(JSON.stringify(found), /mcp__fx__echo/);
    assert.ok(api.getActiveTools().includes("mcp__fx__echo"), `active after search: ${api.getActiveTools().join(", ")}`);
  });
});

test("the server is shut down when the child ends", async () => {
  const { exited } = await withChild({ roles: { builder: { mcp: ["fx"] } } }, async ({ api, startMarker }) => {
    assert.equal(await waitFor(() => fs.existsSync(startMarker)), true);
    assert.equal(await waitFor(() => mcpTools(api).length > 0), true);
  });
  assert.equal(exited, true);
});

test("an fx/echo entry leaves mcp__fx__shout hidden", async () => {
  await withChild({ roles: { builder: { mcp: ["fx/echo"] } } }, async ({ api }) => {
    assert.equal(await waitFor(() => mcpTools(api).includes("mcp__fx__echo")), true);
    const shout = api.getAllTools().find(({ name }) => name === "mcp__fx__shout");
    assert.ok(!shout || shout.exposure === "hidden", `shout: ${JSON.stringify(shout)}`);
    assert.equal(api.getAllTools().find(({ name }) => name === "mcp__fx__echo")?.exposure, "deferred");
  });
});

test("a launch mcp list narrows the ceiling: [] starts no server and leaves tool_search inactive", async () => {
  await withChild({ roles: { builder: { mcp: ["fx"] } }, launchMcp: [] }, async ({ api, startMarker }) => {
    await quiet();
    assert.equal(fs.existsSync(startMarker), false, "the server started");
    assert.deepEqual(mcpTools(api), []);
    assert.equal(api.getActiveTools().includes("tool_search"), false);
  });
});

test("a role without mcp starts no server and has tool_search registered but inactive", async () => {
  await withChild({}, async ({ api, startMarker }) => {
    await quiet();
    assert.equal(fs.existsSync(startMarker), false, "the server started");
    assert.deepEqual(mcpTools(api), []);
    assert.ok(api.getAllTools().some(({ name }) => name === "tool_search"), "tool_search is not registered");
    assert.equal(api.getActiveTools().includes("tool_search"), false);
  });
});

test("a child without a launch binding fails closed even when its role would be allowed", async () => {
  await withChild({ roles: { builder: { mcp: ["fx"] } }, noBinding: true }, async ({ api, startMarker }) => {
    await quiet();
    assert.equal(fs.existsSync(startMarker), false, "the server started");
    assert.deepEqual(mcpTools(api), []);
    assert.equal(api.getActiveTools().includes("tool_search"), false);
  });
});

test("a reviewer (denies mcp__*) with mcp in config starts nothing", async () => {
  await withChild({ role: "reviewer", roles: { reviewer: { mcp: ["fx"], denyTools: ["mcp__*"] } } }, async ({ api, startMarker }) => {
    await quiet();
    assert.equal(fs.existsSync(startMarker), false, "the server started");
    assert.deepEqual(mcpTools(api), []);
    assert.equal(api.getActiveTools().includes("tool_search"), false);
  });
});

test("a direct server in mcp.json is deferred in the child: not active, loaded by tool_search", async () => {
  const tmp = fs.realpathSync(os.tmpdir());
  await withChild({ roles: { builder: { mcp: ["fx"] } }, server: { command: process.execPath, args: [fixture, path.join(tmp, `fx-direct-${process.pid}-s`), path.join(tmp, `fx-direct-${process.pid}-e`)], exposure: "direct" } }, async ({ api }) => {
    assert.equal(await waitFor(() => mcpTools(api).includes("mcp__fx__echo")), true);
    assert.equal(api.getAllTools().find(({ name }) => name === "mcp__fx__echo")?.exposure, "deferred");
    assert.equal(api.getActiveTools().includes("mcp__fx__echo"), false);
  });
  for (const suffix of ["s", "e"]) fs.rmSync(path.join(tmp, `fx-direct-${process.pid}-${suffix}`), { force: true });
});
