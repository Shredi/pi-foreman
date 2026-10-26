// r72: a child on a provider that fixes its tool list per turn (mcp.directProviders) gets its allowed deferred MCP
// tools declared before the first prompt; other providers keep them deferred. McpChild.preload with a stub api.
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpChild } from "../mcpchild.ts";
import { directProviders } from "../mcpscope.ts";

type Tool = { name: string; exposure: string };

const ROLES = { builder: { mcp: ["fx"] } };

/** A child whose MCP extension registers `tools` (name, label, exposure) on install, plus the calls made on the api. */
async function child(roles: unknown, tools: { name: string; label: string; exposure?: string }[], provider: string | undefined, configured: unknown, launch?: string[]) {
  const active = ["read", "tool_search"];
  const calls: string[][] = [];
  const api = {
    on: () => {},
    registerTool: () => {},
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      calls.push(names);
      active.splice(0, active.length, ...names);
    },
    getAllTools: (): Tool[] => tools.map((t) => ({ name: t.name, exposure: t.exposure ?? "deferred" })),
  };
  const createMcp = () => (pi: { registerTool(def: unknown): void }) => {
    for (const t of tools) pi.registerTool({ name: t.name, label: t.label });
  };
  const mcp = new McpChild(api as never, { binding: { role: "builder", ...(launch ? { mcp: launch } : {}) }, createMcp, preloadWaitMs: 100 });
  const trace: Record<string, unknown>[] = [];
  mcp.install();
  await mcp.start(roles, (r) => trace.push(r), provider, configured);
  await mcp.preload();
  return { calls, active, trace };
}

const TOOLS = [
  { name: "mcp__fx__echo", label: "fx/echo" },
  { name: "mcp__fx__shout", label: "fx/shout" },
  { name: "mcp__gx__echo", label: "gx/echo" },
];

test("directProviders: unset means claude-bridge, an array is taken as is, [] turns it off", () => {
  assert.deepEqual(directProviders(undefined), ["claude-bridge"]);
  assert.deepEqual(directProviders(["a", 1, "b"]), ["a", "b"]);
  assert.deepEqual(directProviders([]), []);
});

test("a listed provider gets the allowed deferred tools declared; tools of servers outside the ceiling are not", async () => {
  const c = await child(ROLES, TOOLS, "p1", ["p1"]);
  assert.deepEqual(c.active, ["read", "tool_search", "mcp__fx__echo", "mcp__fx__shout"]);
  assert.deepEqual(c.trace, [{ event: "mcp_child_direct", provider: "p1", servers: "fx", count: 2 }]);
});

test("the default list names claude-bridge", async () => {
  assert.equal((await child(ROLES, TOOLS, "claude-bridge", undefined)).calls.length, 1);
  assert.equal((await child(ROLES, TOOLS, "p1", undefined)).calls.length, 0);
});

test("an unlisted provider keeps the tools deferred and traces nothing", async () => {
  const c = await child(ROLES, TOOLS, "p2", ["p1"]);
  assert.deepEqual(c.calls, []);
  assert.deepEqual(c.trace, []);
});

test("an empty list disables it, even for claude-bridge", async () => {
  const c = await child(ROLES, TOOLS, "claude-bridge", []);
  assert.deepEqual(c.calls, []);
  assert.deepEqual(c.trace, []);
});

test("a server/tool ceiling declares only that tool", async () => {
  const c = await child({ builder: { mcp: ["fx/echo"] } }, TOOLS, "p1", ["p1"]);
  assert.deepEqual(c.active, ["read", "tool_search", "mcp__fx__echo"]);
  assert.equal(c.trace[0]?.count, 1);
});

test("a launch mcp list narrows what is declared", async () => {
  const c = await child(ROLES, TOOLS, "p1", ["p1"], ["fx/shout"]);
  assert.deepEqual(c.active, ["read", "tool_search", "mcp__fx__shout"]);
});

test("only deferred tools are declared: codemode and already direct tools stay as they are", async () => {
  const tools = [{ name: "mcp__fx__echo", label: "fx/echo", exposure: "codemode" }, { name: "mcp__fx__shout", label: "fx/shout", exposure: "direct" }];
  const c = await child(ROLES, tools, "p1", ["p1"]);
  assert.deepEqual(c.calls, []);
  assert.deepEqual(c.trace, []);
});

test("a child without a ceiling declares nothing", async () => {
  const c = await child({}, TOOLS, "p1", ["p1"]);
  assert.deepEqual(c.active, ["read"]); // start drops tool_search; no mcp__ tool is added
  assert.deepEqual(c.trace, []);
});
