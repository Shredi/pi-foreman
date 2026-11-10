// A launch without `mcp` gives the child no MCP tools on every provider; `mcp: [...]` gives the named part of the
// role's ceiling. The mcp.directProviders preload declares nothing above mcp.directMaxTools. A launch whose task names
// a ceiling server while `mcp` is absent gets a hint line. McpChild with a stub api, and the launch hook through the rig.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { cappedNote, LOADER_PATH, McpChild } from "../mcpchild.ts";
import { mcpHintLine, namedCeilingServers, planMcpLaunch } from "../mcplaunch.ts";
import { allowedMcp, DIRECT_MAX_TOOLS, directMaxTools, mcpEmpty } from "../mcpscope.ts";
import { MCP_LAUNCH_NOTE, subagentDescription } from "../sizing.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

type T = { after(fn: () => void | Promise<void>): void };
type Reg = { name: string; label: string; exposure?: string };

const ROLES = { builder: { mcp: ["alpha", "beta/probe"], searchable: [] } };
const TOOLS: Reg[] = [
  { name: "mcp__alpha__echo", label: "alpha/echo" },
  { name: "mcp__alpha__shout", label: "alpha/shout" },
  { name: "mcp__beta__probe", label: "beta/probe" },
];

interface ChildOpts {
  launch?: string[];
  tools?: Reg[];
  provider?: string;
  direct?: unknown;
  max?: unknown;
}

/** A child on a stub api whose loader knows the servers `alpha` and `beta` and whose MCP extension registers `tools`. */
async function child(t: T, o: ChildOpts = {}) {
  const root = mkTestTmp("mcp-default-");
  t.after(() => rmTestTmp(root));
  const loaderFile = path.join(root, ...LOADER_PATH);
  fs.mkdirSync(path.dirname(loaderFile), { recursive: true });
  fs.writeFileSync(loaderFile, "");
  const tools = o.tools ?? TOOLS;
  const active = ["read", "tool_search"];
  const hooks: ((e: unknown, ctx: unknown) => Promise<void>)[] = [];
  let loadConfig: ((ctx: unknown) => { servers: { name: string }[] }) | undefined;
  const api = {
    on: (event: string, handler: (e: unknown, ctx: unknown) => Promise<void>) => {
      if (event === "before_agent_start") hooks.push(handler);
    },
    registerTool: () => {},
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => void active.splice(0, active.length, ...names),
    getAllTools: () => tools.map((x) => ({ name: x.name, exposure: x.exposure ?? "deferred" })),
  };
  const createMcp = (options: { loadConfig: typeof loadConfig }) => (pi: { registerTool(def: unknown): void }) => {
    loadConfig = options.loadConfig;
    for (const x of tools) pi.registerTool({ name: x.name, label: x.label });
  };
  const importFile = async () => ({ loadMcpConfig: () => ({ servers: [{ name: "alpha", config: { exposure: "deferred" } }, { name: "beta", config: { exposure: "deferred" } }], errors: [] }) });
  const mcp = new McpChild(api as never, { binding: { role: "builder", ...(o.launch ? { mcp: o.launch } : {}) }, createMcp, resolveRoot: () => root, importFile, preloadWaitMs: 100 });
  const trace: Record<string, unknown>[] = [];
  mcp.install();
  await mcp.start(ROLES, (r) => trace.push(r), o.direct ?? ["p1"], o.max);
  for (const hook of hooks) await hook({}, { model: { provider: o.provider ?? "p1" } });
  const servers = loadConfig!({ cwd: root, isProjectTrusted: () => false }).servers.map((s) => s.name);
  return { mcp, active, trace, servers };
}

/** `n` deferred tools of the server `alpha`. */
const many = (n: number): Reg[] => Array.from({ length: n }, (_, i) => ({ name: `mcp__alpha__t${i}`, label: `alpha/t${i}` }));

// ---------------------------------------------------------------- the default

test("a launch without mcp loads no server, preloads nothing on a directProviders provider and has tool_search inactive", async (t) => {
  const c = await child(t);
  assert.deepEqual(c.servers, []);
  assert.deepEqual(c.active, ["read"]);
  assert.deepEqual(c.trace, []);
  assert.equal(c.mcp.note(), null);
  assert.ok(mcpEmpty(c.mcp.allowed));
});

test("a launch without mcp: an mcp__ call of a ceiling server is refused by the scope", async (t) => {
  const c = await child(t);
  assert.equal(c.mcp.callBlock("mcp__alpha__echo"), "`mcp__alpha__echo` is outside the MCP scope of role builder (roles.builder.mcp)");
  assert.equal(c.mcp.callBlock("read"), undefined);
});

test("the default claude-bridge provider preloads nothing either without mcp", async (t) => {
  const c = await child(t, { provider: "claude-bridge", direct: undefined });
  assert.deepEqual(c.active, ["read"]);
  assert.deepEqual(c.trace, []);
});

test("mcp: [] is the same as no mcp", async (t) => {
  const c = await child(t, { launch: [] });
  assert.deepEqual(c.servers, []);
  assert.deepEqual(c.active, ["read"]);
  assert.match(c.mcp.callBlock("mcp__alpha__echo") ?? "", /outside the MCP scope/);
});

test("mcp: [...] gives the named part of the ceiling: its server loads, its tools are preloaded, the rest is refused", async (t) => {
  const c = await child(t, { launch: ["alpha/echo"] });
  assert.deepEqual(c.servers, ["alpha"]);
  assert.deepEqual(c.active, ["read", "tool_search", "mcp__alpha__echo"]);
  assert.equal(c.mcp.callBlock("mcp__alpha__echo"), undefined);
  assert.match(c.mcp.callBlock("mcp__alpha__shout") ?? "", /roles\.builder\.mcp, launch mcp/);
  assert.match(c.mcp.callBlock("mcp__beta__probe") ?? "", /outside the MCP scope/);
  const both = await child(t, { launch: ["alpha", "beta/probe"] });
  assert.deepEqual(both.servers, ["alpha", "beta"]);
  assert.deepEqual(both.active, ["read", "tool_search", "mcp__alpha__echo", "mcp__alpha__shout", "mcp__beta__probe"]);
});

test("allowedMcp: an absent launch list allows nothing, a list still cannot widen the ceiling", () => {
  assert.ok(mcpEmpty(allowedMcp(ROLES, "builder")));
  assert.ok(mcpEmpty(allowedMcp(ROLES, "builder", null)));
  assert.deepEqual(allowedMcp(ROLES, "builder", ["alpha", "beta/probe", "beta/other", "gamma"]), { servers: ["alpha"], tools: { beta: ["probe"] } });
});

// ---------------------------------------------------------------- the cap

test("directMaxTools: unset or not a positive integer means 40", () => {
  assert.equal(DIRECT_MAX_TOOLS, 40);
  for (const v of [undefined, null, 0, -3, 2.5, "7", [7]]) assert.equal(directMaxTools(v), 40);
  assert.equal(directMaxTools(7), 7);
});

test("at the cap the tools are declared", async (t) => {
  const c = await child(t, { launch: ["alpha"], tools: many(40) });
  assert.equal(c.active.filter((n) => n.startsWith("mcp__")).length, 40);
  assert.deepEqual(c.trace, [{ event: "mcp_child_direct", provider: "p1", servers: "alpha", count: 40 }]);
  assert.equal(c.mcp.note(), null);
});

test("over the cap none is declared: trace mcp_child_direct_capped with provider, count and cap, and a prompt line", async (t) => {
  const c = await child(t, { launch: ["alpha"], tools: many(41) });
  assert.deepEqual(c.active, ["read", "tool_search"]);
  assert.deepEqual(c.trace, [{ event: "mcp_child_direct_capped", provider: "p1", count: 41, cap: 40 }]);
  const note = c.mcp.note();
  assert.equal(note, cappedNote(41, 40));
  assert.match(note ?? "", /^pi-foreman: the 41 MCP tools allowed to this child are over the cap of 40 \(mcp\.directMaxTools\)/);
  assert.match(note ?? "", /under Friction/);
  assert.ok(note?.includes('mcp: ["server/tool"]'));
  assert.ok(note?.includes("raise mcp.directMaxTools"));
});

test("a configured cap is used; only the tools that would be declared count", async (t) => {
  const over = await child(t, { launch: ["alpha"], max: 1 });
  assert.deepEqual(over.active, ["read", "tool_search"]);
  assert.deepEqual(over.trace, [{ event: "mcp_child_direct_capped", provider: "p1", count: 2, cap: 1 }]);
  const narrowed = await child(t, { launch: ["alpha/echo"], max: 1 });
  assert.deepEqual(narrowed.active, ["read", "tool_search", "mcp__alpha__echo"]);
  const raised = await child(t, { launch: ["alpha"], tools: many(41), max: 41 });
  assert.equal(raised.active.length, 43);
  // codemode tools are not declared, so they do not count
  const mixed = await child(t, { launch: ["alpha"], max: 1, tools: [{ name: "mcp__alpha__echo", label: "alpha/echo" }, { name: "mcp__alpha__shout", label: "alpha/shout", exposure: "codemode" }] });
  assert.deepEqual(mixed.active, ["read", "tool_search", "mcp__alpha__echo"]);
});

test("an unlisted provider is not capped: nothing is declared there anyway", async (t) => {
  const c = await child(t, { launch: ["alpha"], tools: many(41), provider: "p2" });
  assert.deepEqual(c.trace, []);
  assert.equal(c.mcp.note(), null);
});

// ---------------------------------------------------------------- the launch hint

const CONFIG = { roles: { builder: { mcp: ["alpha", "my-srv/ping"] }, explorer: { mcp: ["alpha"], denyTools: ["mcp__*"] } } };

test("namedCeilingServers: whole words only, both - and _ forms, any case, ceiling servers only", () => {
  const named = (task: string, role = "builder") => namedCeilingServers(CONFIG.roles, role, task);
  assert.deepEqual(named("ask alpha for the list"), ["alpha"]);
  assert.deepEqual(named("Ask ALPHA."), ["alpha"]);
  assert.deepEqual(named("use `alpha` and my_srv"), ["alpha", "my-srv"]);
  assert.deepEqual(named("call My-Srv/ping"), ["my-srv"]);
  assert.deepEqual(named("the alphabet, alpha2, alpha_x, alpha-x and xalpha"), []);
  assert.deepEqual(named("use gamma"), []);
  assert.deepEqual(named(""), []);
  assert.deepEqual(named("ask alpha", "explorer"), [], "a server the role's denyTools deny is not hinted");
  assert.deepEqual(named("ask alpha", "reviewer"), []);
});

test("mcpHintLine names the server and the field to pass", () => {
  assert.equal(mcpHintLine("builder", ["alpha"]), 'pi-foreman: the task names MCP server alpha (roles.builder.mcp) but the launch has no mcp field, so the child runs without MCP; pass mcp: ["alpha"] to give it that server.');
  assert.ok(mcpHintLine("builder", ["alpha", "my-srv"]).includes('mcp: ["alpha", "my-srv"]'));
});

const rig = (t: T) => r11Rig(t, {}, { ctx: reviewAllowOpts().ctx, config: { ...reviewAllowOpts().config, ...CONFIG }, deps: { mcpChild: { resolveRoot: () => null } } });
const receipt = async (r: Awaited<ReturnType<typeof rig>>, input: Record<string, unknown>): Promise<string> => {
  const { id, res } = await r.launch(input);
  assert.equal(res, undefined, "a hint never refuses the launch");
  return JSON.stringify(await r.started(id, input, `run-${id}`));
};

test("a launch without mcp whose task names a ceiling server gets the hint in its receipt and a trace event", async (t) => {
  const r = await rig(t);
  const text = await receipt(r, { agent: "builder", task: "read the state through alpha" });
  assert.ok(text.includes("the task names MCP server alpha (roles.builder.mcp)"), text);
  assert.ok(text.includes('mcp: [\\"alpha\\"]'), text);
  assert.deepEqual(r.events("mcp_launch_hint").map((e) => [e.role, e.reason]), [["builder", "alpha"]]);
});

test("no hint for a name outside the ceiling, for a substring, or when mcp is given", async (t) => {
  const r = await rig(t);
  for (const input of [
    { agent: "builder", task: "read the state through gamma" },
    { agent: "builder", task: "sort the alphabet" },
    { agent: "builder", task: "read the state through alpha", mcp: ["alpha"] },
    { agent: "builder", task: "do not use alpha here", mcp: [] },
  ] as Record<string, unknown>[]) {
    const text = await receipt(r, input);
    assert.equal(text.includes("the task names MCP server"), false, text);
  }
  assert.deepEqual(r.events("mcp_launch_hint"), []);
});

// ---------------------------------------------------------------- groups and the tool hint

test("a group whose entries carry no mcp runs, also for a role with a ceiling; an entry with mcp is still refused", () => {
  const opts = { perEntryBindings: false, pinned: "0" };
  for (const input of [
    { tasks: [{ agent: "builder", task: "a" }, { agent: "builder", task: "b" }] },
    { chain: [{ agent: "builder", task: "a" }, { parallel: [{ agent: "explorer", task: "e" }, { agent: "builder", task: "b" }] }] },
    { chain: [{ expand: "x", collect: "y", parallel: { agent: "builder", task: "a" } }] },
  ]) {
    const plan = planMcpLaunch(input, CONFIG.roles, opts);
    assert.equal(plan.refusal, undefined, JSON.stringify(input));
    assert.equal(plan.group, true);
  }
  assert.equal(planMcpLaunch({ tasks: [{ agent: "builder", task: "a" }, { agent: "builder", task: "b", mcp: ["alpha"] }] }, CONFIG.roles, opts).refusal?.reason, "mcp_group_gate");
});

test("the subagent tool hint states the default", () => {
  const d = subagentDescription([{ name: "subagent", description: "Delegate." }], true);
  assert.ok(d?.includes(MCP_LAUNCH_NOTE));
  assert.match(MCP_LAUNCH_NOTE, /no MCP tools unless the launch names them/);
});
