// r68 item 4: the child's per-call mcp_scope guard in the tool_call hook (after roledeny), and the child wiring around
// it, driven through the real adapter with a fake pi. Pi's MCP extension is replaced by a fake that registers tools
// the way the real one does (name and `server/tool` label), so the Proxy's name-to-label map is what is judged.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

/** An installed Pi package root that has the MCP loader on disk. */
const PI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "node_modules", "@earendil-works", "pi-coding-agent");

type T = { after(fn: () => void | Promise<void>): void };

interface Opts {
  roles?: Record<string, unknown>;
  mcp?: string[];
  role?: string;
  noBinding?: boolean;
  tools?: Array<[string, string]>;
  resolveRoot?: () => string | null;
}

async function childRig(t: T, o: Opts = {}) {
  const saved = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  t.after(() => {
    if (saved === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
    else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = saved;
  });
  const binding = { foremanSession: "fs-1", workspace: "/w", role: o.role ?? "builder", launchId: "L1", kind: "first", model: null, ...(o.mcp ? { mcp: o.mcp } : {}) };
  if (o.noBinding) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({ "pi-foreman/1": binding });
  const active: string[] = ["read", "tool_search"];
  const created: unknown[] = [];
  const tools = o.tools ?? [["mcp__fx__echo", "fx/echo"], ["mcp__fx__shout", "fx/shout"], ["mcp__other__probe", "other/probe"]];
  const rig = await r11Rig(t, {}, {
    child: true,
    // the gate's review allows an in-scope call; scope and denyTools refusals come before the gate
    ctx: reviewAllowOpts().ctx,
    config: { ...reviewAllowOpts().config, roles: o.roles ?? { builder: { mcp: ["fx"] } } },
    piExtra: { getActiveTools: () => [...active], setActiveTools: (names: string[]) => { active.splice(0, active.length, ...names); } },
    deps: {
      mcpChild: {
        resolveRoot: o.resolveRoot ?? (() => PI_ROOT),
        createMcp: (options: unknown) => (api: { registerTool(d: unknown): void }) => {
          created.push(options);
          for (const [name, label] of tools) api.registerTool({ name, label });
        },
      },
    },
  });
  return { rig, active, created };
}

test("a call inside the role's scope passes; a registered foreign tool and an unregistered mcp__ name are blocked with a trace", async (t) => {
  const { rig } = await childRig(t);
  assert.equal(await rig.call("mcp__fx__echo", {}), undefined);
  assert.equal(await rig.call("mcp__fx__shout", {}), undefined);
  const foreign = await rig.call("mcp__other__probe", {});
  assert.equal(foreign?.block, true);
  assert.equal(foreign?.reason, "pi-foreman: `mcp__other__probe` is outside the MCP scope of role builder (roles.builder.mcp).");
  const ghost = await rig.call("mcp__ghost__x", {});
  assert.equal(ghost?.block, true);
  assert.match(ghost?.reason ?? "", /outside the MCP scope of role builder/);
  const blocked = rig.events("guard").filter((r) => r.guard === "mcp_scope");
  assert.deepEqual(blocked.map((r) => [r.toolFamily, r.decision, r.reason]), [["mcp__other__probe", "blocked", "mcp_scope"], ["mcp__ghost__x", "blocked", "mcp_scope"]]);
});

test("non-mcp tools are not judged by the scope guard", async (t) => {
  const { rig } = await childRig(t, { roles: { builder: {} } });
  assert.equal(await rig.call("read", { path: "a" }), undefined);
  assert.equal(await rig.call("tool_search", { query: "x" }), undefined);
  assert.deepEqual(rig.events("guard").filter((r) => r.guard === "mcp_scope"), []);
});

test("a launch mcp list narrows the guard: fx/echo allows echo only, and the reason names the launch", async (t) => {
  const { rig } = await childRig(t, { mcp: ["fx/echo"] });
  assert.equal(await rig.call("mcp__fx__echo", {}), undefined);
  const shout = await rig.call("mcp__fx__shout", {});
  assert.equal(shout?.reason, "pi-foreman: `mcp__fx__shout` is outside the MCP scope of role builder (roles.builder.mcp, launch mcp).");
});

test("a tool_call arriving after a codemode call (how a nested call surfaces) is judged like a direct call", async (t) => {
  const { rig } = await childRig(t);
  assert.equal(await rig.call("codemode", { code: "return 1" }), undefined);
  // the nested call arrives as its own tool_call with the nested tool's name
  const inner = await rig.call("mcp__other__probe", {});
  assert.equal(inner?.block, true);
  assert.match(inner?.reason ?? "", /outside the MCP scope/);
  assert.equal(await rig.call("mcp__fx__echo", {}), undefined);
});

test("hyphen and underscore server names are one server", async (t) => {
  const { rig } = await childRig(t, { roles: { builder: { mcp: ["my-srv"] } }, tools: [["mcp__my_srv__ping", "my-srv/ping"]] });
  assert.equal(await rig.call("mcp__my_srv__ping", {}), undefined);
});

test("a child without a binding allows no mcp__ call", async (t) => {
  const { rig } = await childRig(t, { noBinding: true });
  const res = await rig.call("mcp__fx__echo", {});
  assert.equal(res?.block, true);
});

test("denyTools is judged first: its reason wins over the scope reason", async (t) => {
  const { rig } = await childRig(t, { role: "reviewer", roles: { reviewer: { mcp: ["fx"], denyTools: ["mcp__*"] } } });
  const res = await rig.call("mcp__fx__echo", {});
  assert.match(res?.reason ?? "", /denyTools/);
  assert.deepEqual(rig.events("guard").filter((r) => r.guard === "mcp_scope"), []);
});

test("tool_search leaves the active set when the role allows nothing, and stays when it allows a server", async (t) => {
  const none = await childRig(t, { roles: { builder: {} } });
  assert.deepEqual(none.active, ["read"]);
  const some = await childRig(t);
  assert.deepEqual(some.active, ["read", "tool_search"]);
});

test("the MCP extension is created in every child with a loadConfig", async (t) => {
  const { created } = await childRig(t, { roles: { builder: {} } });
  assert.equal(created.length, 1);
  assert.equal(typeof (created[0] as { loadConfig?: unknown }).loadConfig, "function");
});

test("a missing loader refuses MCP in that child: trace mcp_child_unsupported, tool_search inactive, a prompt line", async (t) => {
  const { rig, active } = await childRig(t, { resolveRoot: () => null });
  const rows = rig.events("mcp_child_unsupported");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, "builder");
  assert.match(String(rows[0].reason), /no Pi package root/);
  assert.deepEqual(active, ["read"]);
  const event = { prompt: "go", systemPromptOptions: { sections: {} as Record<string, string> } };
  await rig.fire("before_agent_start", event);
  assert.match(event.systemPromptOptions.sections["pi-foreman-mcp"] ?? "", /MCP is not available in this child .*Friction/);
});

test("a child whose MCP works gets no MCP prompt line", async (t) => {
  const { rig } = await childRig(t);
  const event = { prompt: "go", systemPromptOptions: { sections: {} as Record<string, string> } };
  await rig.fire("before_agent_start", event);
  assert.equal(event.systemPromptOptions.sections["pi-foreman-mcp"], undefined);
});
