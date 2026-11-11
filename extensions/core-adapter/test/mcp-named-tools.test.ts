// Tools named as `server/tool` in a launch are declared up front on every provider; a server named whole next to them
// keeps the rest findable and never declares it in bulk; named tools over mcp.directMaxTools are refused at launch.
// McpChild with a stub api (copy of the harness of mcp-default-none.test.ts), planMcpLaunch, and the launch hook through the rig.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { LOADER_PATH, McpChild, cappedNote, namedCapNote } from "../mcpchild.ts";
import { namedCapText, planMcpLaunch, wholeOnlyServers } from "../mcplaunch.ts";
import { allowedMcp, allowedMcpNamed, filterMcpConfig, mcpCallAllowed, namedEntries } from "../mcpscope.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

type T = { after(fn: () => void | Promise<void>): void };
type Reg = { name: string; label: string; exposure?: string };

const ROLES = { builder: { mcp: ["alpha", "beta"], searchable: [] }, narrow: { mcp: ["alpha/echo"] }, denied: { mcp: ["alpha"], denyTools: ["mcp__alpha__shout"] } };
const TOOLS: Reg[] = [
  { name: "mcp__alpha__echo", label: "alpha/echo" },
  { name: "mcp__alpha__shout", label: "alpha/shout" },
  { name: "mcp__alpha__whisper", label: "alpha/whisper" },
  { name: "mcp__beta__probe", label: "beta/probe" },
  { name: "mcp__beta__ping", label: "beta/ping" },
];
/** `n` deferred tools of the server `alpha`. */
const many = (n: number): Reg[] => Array.from({ length: n }, (_, i) => ({ name: `mcp__alpha__t${i}`, label: `alpha/t${i}` }));

interface ChildOpts {
  role?: string;
  launch?: string[];
  tools?: Reg[];
  provider?: string;
  max?: unknown;
  /** The first turn runs with no model provider (it may be unset at session start). */
  noProvider?: boolean;
  /** The server list of Pi's loader (default alpha and beta, both deferred). */
  servers?: { name: string; config: { exposure?: string; toolExposure?: Record<string, string> } }[];
  /** Tools already active before the first prompt (a resumed session). */
  already?: string[];
  /** The api has `getMcpServers` (none registered) and, as in Pi, every config read is followed by it, once more after the first turn. */
  piOrder?: boolean;
  /** Servers whose tools register only when the test calls `register(server)` (after the first turn). */
  late?: string[];
  /** Counts the readiness polls of `preload` (each pause really waits 50 ms). */
  polls?: { count: number };
}

async function child(t: T, o: ChildOpts = {}) {
  const root = mkTestTmp("mcp-named-");
  t.after(() => rmTestTmp(root));
  const loaderFile = path.join(root, ...LOADER_PATH);
  fs.mkdirSync(path.dirname(loaderFile), { recursive: true });
  fs.writeFileSync(loaderFile, "");
  const tools = o.tools ?? TOOLS;
  const state: { servers: ChildOpts["servers"]; ext: NonNullable<ChildOpts["servers"]> } = { servers: o.servers, ext: [] };
  const isLate = (x: Reg): boolean => (o.late ?? []).includes(x.label.split("/", 1)[0]!);
  const active = ["read", "tool_search", ...(o.already ?? [])];
  const hooks: ((e: unknown, ctx: unknown) => Promise<void>)[] = [];
  const api = {
    on: (event: string, handler: (e: unknown, ctx: unknown) => Promise<void>) => {
      if (event === "before_agent_start") hooks.push(handler);
    },
    registerTool: () => {},
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => void active.splice(0, active.length, ...names),
    getAllTools: () => tools.map((x) => ({ name: x.name, exposure: x.exposure ?? "deferred" })),
    ...(o.piOrder ? { getMcpServers: () => state.ext } : {}),
  };
  let proxied: { getMcpServers?: () => unknown; registerTool(def: unknown): void } | undefined;
  let loadConfig: ((ctx: unknown) => { servers: { name: string; config: { exposure?: string; toolExposure?: Record<string, string> } }[] }) | undefined;
  const createMcp = (options: { loadConfig: typeof loadConfig }) => (pi: { registerTool(def: unknown): void }) => {
    proxied = pi as never;
    loadConfig = options.loadConfig;
    for (const x of tools) if (!isLate(x)) pi.registerTool({ name: x.name, label: x.label });
  };
  const importFile = async () => ({ loadMcpConfig: () => ({ servers: state.servers ?? [{ name: "alpha", config: { exposure: "deferred" } }, { name: "beta", config: { exposure: "deferred" } }], errors: [] }) });
  const mcp = new McpChild(api as never, { binding: { role: o.role ?? "builder", ...(o.launch ? { mcp: o.launch } : {}) }, createMcp, resolveRoot: () => root, importFile, preloadWaitMs: 100, preloadPause: () => { if (o.polls) o.polls.count++; return new Promise<void>((resolve) => setTimeout(resolve, 50)); } });
  const trace: Record<string, unknown>[] = [];
  mcp.install();
  await mcp.start(ROLES, (r) => trace.push(r), ["p1"], o.max);
  if (o.piOrder) loadConfig!({ cwd: root, isProjectTrusted: () => false });
  if (o.piOrder) proxied!.getMcpServers!();
  const turn = async () => {
    for (const hook of hooks) await hook({}, { model: o.noProvider ? undefined : { provider: o.provider ?? "p1" } });
  };
  await turn();
  if (o.piOrder) proxied!.getMcpServers!();
  const config = loadConfig!({ cwd: root, isProjectTrusted: () => false }).servers;
  const mcpActive = () => active.filter((n) => n.startsWith("mcp__"));
  const read = () => {
    loadConfig!({ cwd: root, isProjectTrusted: () => false });
    proxied!.getMcpServers?.();
  };
  const register = (server: string) => {
    for (const x of tools) if (x.label.startsWith(`${server}/`)) proxied!.registerTool({ name: x.name, label: x.label });
  };
  return { mcp, active, trace, config, turn, mcpActive, state, read, register };
}

// ---------------------------------------------------------------- a-e: what is declared, searchable, callable

test("a: [alpha, alpha/echo] on a direct provider, server over the cap: echo is up front, the rest stays deferred and callable", async (t) => {
  const c = await child(t, { launch: ["alpha", "alpha/echo"], tools: [{ name: "mcp__alpha__echo", label: "alpha/echo" }, ...many(41)] });
  assert.deepEqual(c.mcpActive(), ["mcp__alpha__echo"]);
  assert.deepEqual(c.trace, [{ event: "mcp_child_direct", provider: "p1", servers: "alpha", count: 1 }], "the remainder of a server with a named tool is never declared in bulk");
  assert.equal(c.config.find((s) => s.name === "alpha")?.config.exposure, "deferred", "the server stays loaded whole, so its other tools are searchable");
  assert.equal(c.mcp.callBlock("mcp__alpha__t3"), undefined);
  assert.equal(c.mcp.callBlock("mcp__alpha__echo"), undefined);
  assert.match(c.mcp.callBlock("mcp__beta__probe") ?? "", /outside the MCP scope/);
});

test("b: the same with a small server: still only echo is up front", async (t) => {
  const c = await child(t, { launch: ["alpha", "alpha/echo"] });
  assert.deepEqual(c.mcpActive(), ["mcp__alpha__echo"]);
  assert.deepEqual(c.trace, [{ event: "mcp_child_direct", provider: "p1", servers: "alpha", count: 1 }]);
  assert.equal(c.mcp.callBlock("mcp__alpha__shout"), undefined);
  assert.equal(c.config.find((s) => s.name === "alpha")?.config.exposure, "deferred");
});

test("c: [alpha/echo] alone keeps its meaning: only echo, the rest of the server hidden and refused", async (t) => {
  const c = await child(t, { launch: ["alpha/echo"] });
  assert.deepEqual(c.mcpActive(), ["mcp__alpha__echo"]);
  assert.match(c.mcp.callBlock("mcp__alpha__shout") ?? "", /roles\.builder\.mcp, launch mcp/);
  const alpha = c.config.find((s) => s.name === "alpha")!;
  assert.equal(alpha.config.exposure, "hidden");
  assert.deepEqual(alpha.config.toolExposure, { echo: "deferred" });
  assert.match(c.mcp.note() ?? "", /No other MCP tool is reachable/);
});

test("d: [alpha/echo] on a provider outside directProviders: echo is up front there too, nothing else", async (t) => {
  const c = await child(t, { launch: ["alpha/echo"], provider: "p2" });
  assert.deepEqual(c.mcpActive(), ["mcp__alpha__echo"]);
  assert.deepEqual(c.trace, [{ event: "mcp_child_direct", provider: "p2", servers: "alpha", count: 1 }]);
  const both = await child(t, { launch: ["alpha", "alpha/echo"], provider: "p2", tools: many(3).concat([{ name: "mcp__alpha__echo", label: "alpha/echo" }]) });
  assert.deepEqual(both.mcpActive(), ["mcp__alpha__echo"]);
  const bare = await child(t, { launch: ["alpha"], provider: "p2" });
  assert.deepEqual(bare.mcpActive(), [], "a bare server on an unlisted provider is still all by search");
  assert.match(bare.mcp.note() ?? "", /declared in your tool list: none\. The tools of the MCP server alpha are not declared/);
});

test("e: [alpha, beta/probe] direct: probe is up front; alpha in bulk when named plus bulk fit, none of it over the cap", async (t) => {
  const fits = await child(t, { launch: ["alpha", "beta/probe"], max: 4 });
  assert.deepEqual(fits.mcpActive(), ["mcp__alpha__echo", "mcp__alpha__shout", "mcp__alpha__whisper", "mcp__beta__probe"]);
  assert.match(fits.mcp.note() ?? "", /declared in your tool list: .*mcp__beta__probe/);
  assert.doesNotMatch(fits.mcp.note() ?? "", /not declared/);
  const over = await child(t, { launch: ["alpha", "beta/probe"], max: 3 });
  assert.deepEqual(over.mcpActive(), ["mcp__beta__probe"]);
  assert.deepEqual(over.trace, [{ event: "mcp_child_direct", provider: "p1", servers: "beta", count: 1 }, { event: "mcp_child_direct_capped", provider: "p1", count: 4, cap: 3 }]);
  assert.match(over.mcp.note() ?? "", /other tools of the MCP server alpha are not declared: find them with tool_search/);
  assert.match(over.mcp.note() ?? "", /With the 1 named tool, the 3 MCP tools of the servers named whole are over the cap of 3 \(mcp\.directMaxTools\), so they are not declared and found with tool_search; name that under Friction/);
  assert.equal(over.mcp.callBlock("mcp__alpha__shout"), undefined);
});

// ---------------------------------------------------------------- f: named tools over the cap

test("f: named tools over the cap are refused at launch with the count, the cap and the key", () => {
  const roles = { builder: { mcp: ["alpha"] } };
  const plan = planMcpLaunch({ agent: "builder", task: "x", mcp: ["alpha", "alpha/a", "alpha/b", "alpha/a"] }, roles, { maxTools: 1 });
  assert.equal(plan.refusal?.reason, "mcp_named_cap");
  assert.equal(plan.refusal?.text, namedCapText(2, 1));
  assert.match(plan.refusal?.text ?? "", /names 2 tools as server\/tool, over the cap of 1 \(mcp\.directMaxTools\)/);
  assert.match(plan.refusal?.text ?? "", /Name fewer tools/);
  assert.match(plan.refusal?.text ?? "", /found with tool_search/);
  const ok = planMcpLaunch({ agent: "builder", task: "x", mcp: ["alpha", "alpha/a", "alpha/a"] }, roles, { maxTools: 1 });
  assert.equal(ok.refusal, undefined, "a duplicate counts once");
  const dash = planMcpLaunch({ agent: "builder", task: "x", mcp: ["alpha/a", "alpha/b"] }, roles, {});
  assert.equal(dash.refusal, undefined, "the default cap is 40");
  const many40 = Array.from({ length: 41 }, (_, i) => `alpha/t${i}`);
  assert.equal(planMcpLaunch({ agent: "builder", task: "x", mcp: many40 }, roles, {}).refusal?.reason, "mcp_named_cap");
});

test("f: the child guard declares none of the named tools over the cap, traces and says so", async (t) => {
  const c = await child(t, { launch: ["alpha/echo", "alpha/shout"], max: 1 });
  assert.deepEqual(c.mcpActive(), []);
  assert.deepEqual(c.trace, [{ event: "mcp_child_named_capped", provider: "p1", count: 2, cap: 1 }]);
  assert.equal(c.mcp.note(), namedCapNote(2, 1));
  assert.match(c.mcp.note() ?? "", /over the cap of 1 \(mcp\.directMaxTools\)/);
});

// ---------------------------------------------------------------- g: ceiling

test("g: a launch entry outside the ceiling or denied is not named, not declared and refused by callBlock", async (t) => {
  const outside = await child(t, { role: "narrow", launch: ["alpha/echo", "alpha/shout", "beta/probe"] });
  assert.deepEqual(namedEntries(outside.mcp.allowed), [{ server: "alpha", tool: "echo" }]);
  assert.deepEqual(outside.mcpActive(), ["mcp__alpha__echo"]);
  assert.match(outside.mcp.callBlock("mcp__alpha__shout") ?? "", /outside the MCP scope/);
  assert.match(outside.mcp.callBlock("mcp__beta__probe") ?? "", /outside the MCP scope/);
  const denied = await child(t, { role: "denied", launch: ["alpha", "alpha/shout", "alpha/echo"] });
  assert.deepEqual(denied.mcp.allowed.named, { alpha: ["echo"] });
  assert.deepEqual(denied.mcpActive(), ["mcp__alpha__echo"]);
  assert.equal(denied.mcp.callBlock("mcp__alpha__whisper"), undefined);
});

// ---------------------------------------------------------------- h: the prompt line

test("h: form C: the line lists the up-front tools and the search sentence; identical on every turn", async (t) => {
  const c = await child(t, { launch: ["alpha", "alpha/echo"] });
  const first = c.mcp.note();
  assert.equal(first, "pi-foreman: MCP tools declared in your tool list: mcp__alpha__echo. The other tools of the MCP server alpha are not declared: find them with tool_search (a tool it loads is callable from the next turn on a provider that fixes its tool list per turn).");
  await c.turn();
  await c.turn();
  assert.equal(c.mcp.note(), first);
});

test("h: form B says nothing else is reachable; no mcp means no line; a named tool the server lacks is listed", async (t) => {
  const b = await child(t, { launch: ["alpha/echo", "beta/probe"] });
  assert.equal(b.mcp.note(), "pi-foreman: MCP tools declared in your tool list: mcp__alpha__echo, mcp__beta__probe. No other MCP tool is reachable in this launch.");
  const none = await child(t);
  assert.equal(none.mcp.note(), null);
  const empty = await child(t, { launch: [] });
  assert.equal(empty.mcp.note(), null);
  const lacking = await child(t, { launch: ["alpha", "alpha/echo", "alpha/missing"] });
  assert.match(lacking.mcp.note() ?? "", /Named but not found on the server: alpha\/missing/);
  assert.doesNotMatch(lacking.mcp.note() ?? "", /alpha\/echo;/);
});

test("h: the over-the-cap line for a server named alone is reworded: nothing up front, tool_search, how to name tools", async (t) => {
  const c = await child(t, { launch: ["alpha"], tools: many(41) });
  const note = c.mcp.note() ?? "";
  assert.match(note, /so nothing is declared up front/);
  assert.match(note, /you find them with tool_search/);
  assert.ok(note.includes('mcp: ["server", "server/tool"]'));
});

test("h: a bare server declared in bulk: the line says all N tools of it are up front and does not send the child to search", async (t) => {
  const c = await child(t, { launch: ["alpha"], tools: many(5) });
  const note = c.mcp.note();
  assert.equal(note, "pi-foreman: MCP tools declared in your tool list: all 5 tools of server alpha. No other MCP tool is reachable in this launch.");
  assert.doesNotMatch(note ?? "", /tool_search/);
  await c.turn();
  assert.equal(c.mcp.note(), note);
});

test("h: a bare server on a provider outside directProviders: none up front, found with tool_search; same on every turn", async (t) => {
  const c = await child(t, { launch: ["alpha", "beta"], provider: "p2" });
  const note = c.mcp.note();
  assert.match(note ?? "", /^pi-foreman: MCP tools declared in your tool list: none\. The tools of the MCP servers alpha, beta are not declared: find them with tool_search/);
  await c.turn();
  assert.equal(c.mcp.note(), note);
});

test("h: a bare server over the cap on a direct provider keeps cappedNote", async (t) => {
  const c = await child(t, { launch: ["alpha"], tools: many(4), max: 3 });
  assert.equal(c.mcp.note(), cappedNote(4, 3));
});

test("h: with no provider at the first prompt there is no line yet; once a provider is known the line is fixed and stays", async (t) => {
  const c = await child(t, { launch: ["alpha"], tools: many(2), noProvider: true });
  assert.equal(c.mcp.note(), null);
  assert.deepEqual(c.mcpActive(), []);
  await c.mcp.preload("p1");
  const line = c.mcp.note();
  assert.equal(line, "pi-foreman: MCP tools declared in your tool list: all 2 tools of server alpha. No other MCP tool is reachable in this launch.");
  await c.mcp.preload("p2");
  assert.equal(c.mcp.note(), line);
});

// ---------------------------------------------------------------- h2: the line across a provider switch, the cap, a silent server

test("h2: provider p2 then p1 under the cap: the line is true before and after the switch, same text on two turns of p2", async (t) => {
  const c = await child(t, { launch: ["alpha"], tools: many(2), provider: "p2" });
  const before = c.mcp.note();
  assert.equal(before, "pi-foreman: MCP tools declared in your tool list: none. The tools of the MCP server alpha are not declared: find them with tool_search (a tool it loads is callable from the next turn on a provider that fixes its tool list per turn).");
  await c.turn();
  assert.equal(c.mcp.note(), before, "the same text on every turn on one provider");
  assert.deepEqual(c.mcpActive(), []);
  await c.mcp.preload("p1");
  assert.equal(c.mcp.note(), "pi-foreman: MCP tools declared in your tool list: all 2 tools of server alpha. No other MCP tool is reachable in this launch.");
  assert.equal(c.mcpActive().length, 2);
});

test("h2: provider p2 then p1 with the server over the cap: the stale line gives way to cappedNote", async (t) => {
  const c = await child(t, { launch: ["alpha"], tools: many(4), max: 3, provider: "p2" });
  assert.match(c.mcp.note() ?? "", /none\. The tools of the MCP server alpha/);
  await c.mcp.preload("p1");
  assert.equal(c.mcp.note(), cappedNote(4, 3));
  assert.deepEqual(c.mcpActive(), []);
});

test("h2: [alpha, beta/probe] with alpha over the cap: the line carries the cap sentence", async (t) => {
  const tools: Reg[] = [{ name: "mcp__beta__probe", label: "beta/probe" }, ...many(4)];
  const c = await child(t, { launch: ["alpha", "beta/probe"], tools, max: 3 });
  assert.equal(
    c.mcp.note(),
    "pi-foreman: MCP tools declared in your tool list: mcp__beta__probe. The other tools of the MCP server alpha are not declared: find them with tool_search (a tool it loads is callable from the next turn on a provider that fixes its tool list per turn). With the 1 named tool, the 4 MCP tools of the servers named whole are over the cap of 3 (mcp.directMaxTools), so they are not declared and found with tool_search; name that under Friction in your report.",
  );
});

test("h2: a server that registered nothing in time gets the no-tool sentence; a tool missing on a server that did register keeps the old wording", async (t) => {
  const silent = await child(t, { launch: ["alpha/echo", "beta/probe"], tools: [{ name: "mcp__beta__probe", label: "beta/probe" }] });
  const note = silent.mcp.note() ?? "";
  assert.match(note, /MCP server alpha registered no tool: it did not answer in time or it is hidden in the MCP config, so its named tools \(alpha\/echo\) are not declared; name it under Friction in your report\./);
  assert.doesNotMatch(note, /Named but not found/);
  const lacking = await child(t, { launch: ["alpha/echo", "alpha/missing"] });
  assert.match(lacking.mcp.note() ?? "", /Named but not found on the server: alpha\/missing/);
  assert.doesNotMatch(lacking.mcp.note() ?? "", /registered no tool/);
});

// ---------------------------------------------------------------- h3: codemode exposure (the default of a server in mcp.json)

const codemode = (tools: Reg[]): Reg[] => tools.map((x) => ({ ...x, exposure: "codemode" }));

test("h3: a named tool of a codemode server is active on a direct and on another provider, and the line names it", async (t) => {
  for (const provider of ["p1", "p2"]) {
    const c = await child(t, { launch: ["alpha/echo"], provider, tools: codemode(TOOLS) });
    assert.deepEqual(c.mcpActive(), ["mcp__alpha__echo"], provider);
    assert.equal(c.mcp.note(), "pi-foreman: MCP tools declared in your tool list: mcp__alpha__echo. No other MCP tool is reachable in this launch.", provider);
  }
});

test("h3: a whole codemode server plus a named tool of it: the named one is active, the rest is not, the line says so", async (t) => {
  const c = await child(t, { launch: ["alpha", "alpha/echo"], tools: codemode(TOOLS) });
  assert.deepEqual(c.mcpActive(), ["mcp__alpha__echo"]);
  assert.equal(c.mcp.note(), "pi-foreman: MCP tools declared in your tool list: mcp__alpha__echo. The other tools of the MCP server alpha are not declared: find them with tool_search (a tool it loads is callable from the next turn on a provider that fixes its tool list per turn).");
  const bare = await child(t, { launch: ["alpha"], tools: codemode(TOOLS) });
  assert.deepEqual(bare.mcpActive(), [], "codemode tools are not declared in bulk");
});

test("h3: the over-the-cap sentence counts named plus bulk: bulk alone at the cap, named plus bulk over it", async (t) => {
  const tools: Reg[] = [{ name: "mcp__beta__probe", label: "beta/probe" }, ...many(3)];
  const c = await child(t, { launch: ["alpha", "beta/probe"], tools, max: 3 });
  assert.deepEqual(c.mcpActive(), ["mcp__beta__probe"]);
  const note = c.mcp.note() ?? "";
  assert.match(note, / With the 1 named tool, the 3 MCP tools of the servers named whole are over the cap of 3 \(mcp\.directMaxTools\), so they are not declared and found with tool_search;/);
  assert.doesNotMatch(note, /The 3 MCP tools/);
});

// ---------------------------------------------------------------- i: the launch hook

const CONFIG = { roles: { builder: { mcp: ["alpha", "beta"] } }, mcp: { directMaxTools: 3 } };
const rig = (t: T, config: Record<string, unknown> = CONFIG) => r11Rig(t, {}, { ctx: reviewAllowOpts().ctx, config: { ...reviewAllowOpts().config, ...config }, deps: { mcpChild: { resolveRoot: () => null } } });
const receipt = async (r: Awaited<ReturnType<typeof rig>>, input: Record<string, unknown>): Promise<string> => {
  const { id, res } = await r.launch(input);
  assert.equal(res, undefined);
  return JSON.stringify(await r.started(id, input, `run-${id}`));
};

test("i: the session trace carries mcp_launch with the named count and no searchable count; a whole server alone gets the launch note", async (t) => {
  const r = await rig(t);
  const whole = await receipt(r, { agent: "builder", task: "go", mcp: ["alpha"] });
  assert.match(whole, /launch names MCP server alpha \(role builder\) without a tool of it/);
  assert.match(whole, /Over the cap of 3 \(mcp\.directMaxTools\) nothing of it is declared up front and the child finds the tools with tool_search/);
  assert.ok(whole.includes('mcp: [\\"alpha\\", \\"alpha/<tool>\\"]'));
  const named = await receipt(r, { agent: "builder", task: "go", mcp: ["alpha", "alpha/echo", "beta/probe"] });
  assert.equal(named.includes("without a tool of it"), false, "alpha has a named tool, beta has one: no launch note");
  const events = r.events("mcp_launch");
  assert.deepEqual(events.map((e) => [e.role, e.upfront, e.servers]), [["builder", 0, "alpha"], ["builder", 2, "alpha"]]);
  assert.ok(events.every((e) => !("searchable" in e)));
  assert.deepEqual(r.events("mcp_launch_whole").map((e) => [e.role, e.servers, e.cap]), [["builder", "alpha", 3]]);
});

test("i: no mcp or mcp [] leaves no mcp_launch event; mcp over the cap is refused with launch_refused mcp_named_cap", async (t) => {
  const r = await rig(t);
  await receipt(r, { agent: "builder", task: "go" });
  await receipt(r, { agent: "builder", task: "go", mcp: [] });
  assert.deepEqual(r.events("mcp_launch"), []);
  const { res } = await r.launch({ agent: "builder", task: "go", mcp: ["alpha/a", "alpha/b", "alpha/c", "beta/d"] });
  assert.match(JSON.stringify(res), /names 4 tools as server\/tool, over the cap of 3 \(mcp\.directMaxTools\)/);
  assert.deepEqual(r.events("launch_refused").map((e) => e.reason), ["mcp_named_cap"]);
  assert.deepEqual(r.events("mcp_launch"), []);
});

test("i: with mcp.directProviders [] there is no launch note for a whole server (nothing is declared in bulk anywhere)", async (t) => {
  const r = await rig(t, { ...CONFIG, mcp: { directProviders: [] } });
  const text = await receipt(r, { agent: "builder", task: "go", mcp: ["alpha"] });
  assert.equal(text.includes("without a tool of it"), false);
  assert.equal(r.events("mcp_launch").length, 1);
});

// ---------------------------------------------------------------- j: allowedMcp and the named field

test("j: allowedMcpNamed keeps single tools of a whole server in named; allowedMcp keeps its shape", () => {
  const roles = { b: { mcp: ["my-srv", "other/x", "other/y"], denyTools: ["mcp__my_srv__bad"] } };
  assert.deepEqual(allowedMcpNamed(roles, "b", ["my-srv", "my_srv/ping", "my-srv/ping", "my-srv/pong", "my-srv/bad"]), { servers: ["my-srv"], tools: {}, named: { "my-srv": ["ping", "pong"] } });
  assert.deepEqual(allowedMcpNamed(roles, "b", ["my_srv/ping"]), { servers: [], tools: { my_srv: ["ping"] } });
  assert.deepEqual(allowedMcpNamed(roles, "b", ["my-srv", "other/x", "other/z", "gamma/q"]), { servers: ["my-srv"], tools: { other: ["x"] } });
  assert.deepEqual(allowedMcp(roles, "b", ["my-srv", "my-srv/ping"]), { servers: ["my-srv"], tools: {} });
  assert.deepEqual(namedEntries(allowedMcpNamed(roles, "b", ["my-srv", "my-srv/ping", "other/x"])), [{ server: "other", tool: "x" }, { server: "my-srv", tool: "ping" }]);
});

test("j: servers and tools keep their meaning for the call gate and the config filter", () => {
  const allowed = allowedMcpNamed({ b: { mcp: ["alpha"] } }, "b", ["alpha", "alpha/echo"]);
  assert.equal(mcpCallAllowed(allowed, "alpha/shout"), true);
  assert.equal(mcpCallAllowed(allowed, "beta/shout"), false);
  const out = filterMcpConfig({ servers: [{ name: "alpha", config: { exposure: "direct" } }], errors: [] }, allowed);
  assert.equal(out.servers[0]?.config.exposure, "deferred");
  assert.deepEqual(wholeOnlyServers({ b: { mcp: ["alpha", "beta"] } }, "b", ["alpha", "alpha/echo", "beta"]), ["beta"]);
});

// ---------------------------------------------------------------- k: the named part once, the bulk at the first direct turn; hidden and already-active named tools

const SEARCH = "The other tools of the MCP server alpha are not declared: find them with tool_search (a tool it loads is callable from the next turn on a provider that fixes its tool list per turn).";

test("k: [alpha, beta/probe], p2 then p1, alpha under the cap: probe once, alpha's tools at the direct turn, the line true before and after", async (t) => {
  const c = await child(t, { launch: ["alpha", "beta/probe"], provider: "p2" });
  assert.deepEqual(c.mcpActive(), ["mcp__beta__probe"]);
  const before = `pi-foreman: MCP tools declared in your tool list: mcp__beta__probe. ${SEARCH}`;
  assert.equal(c.mcp.note(), before);
  await c.turn();
  assert.equal(c.mcp.note(), before, "the same text on the second turn on p2");
  await c.mcp.preload("p1");
  assert.deepEqual(c.mcpActive().sort(), ["mcp__alpha__echo", "mcp__alpha__shout", "mcp__alpha__whisper", "mcp__beta__probe"]);
  assert.equal(c.mcp.note(), "pi-foreman: MCP tools declared in your tool list: mcp__beta__probe, all 3 tools of server alpha. No other MCP tool is reachable in this launch.");
  assert.deepEqual(c.trace, [{ event: "mcp_child_direct", provider: "p2", servers: "beta", count: 1 }, { event: "mcp_child_direct", provider: "p1", servers: "alpha", count: 3 }]);
  await c.mcp.preload("p1");
  assert.equal(c.trace.length, 2, "decided once");
});

test("k: the same with alpha over the cap: the cap sentence after p1, probe not declared twice", async (t) => {
  const c = await child(t, { launch: ["alpha", "beta/probe"], provider: "p2", max: 3 });
  assert.equal(c.mcp.note(), `pi-foreman: MCP tools declared in your tool list: mcp__beta__probe. ${SEARCH}`);
  await c.mcp.preload("p1");
  assert.deepEqual(c.mcpActive(), ["mcp__beta__probe"]);
  assert.equal(
    c.mcp.note(),
    `pi-foreman: MCP tools declared in your tool list: mcp__beta__probe. ${SEARCH} With the 1 named tool, the 3 MCP tools of the servers named whole are over the cap of 3 (mcp.directMaxTools), so they are not declared and found with tool_search; name that under Friction in your report.`,
  );
  assert.deepEqual(c.trace, [{ event: "mcp_child_direct", provider: "p2", servers: "beta", count: 1 }, { event: "mcp_child_direct_capped", provider: "p1", count: 4, cap: 3 }]);
});

test("k: the same launch with two turns on p2: the same text, nothing more declared", async (t) => {
  const c = await child(t, { launch: ["alpha", "beta/probe"], provider: "p2" });
  const first = c.mcp.note();
  await c.turn();
  await c.turn();
  assert.equal(c.mcp.note(), first);
  assert.deepEqual(c.mcpActive(), ["mcp__beta__probe"]);
  assert.equal(c.trace.length, 1);
});

test("k: a named tool hidden in a server named whole is named in the line as not available", async (t) => {
  const tools = TOOLS.map((x) => (x.name === "mcp__alpha__echo" ? { ...x, exposure: "hidden" } : x));
  const c = await child(t, { launch: ["alpha", "alpha/echo"], tools });
  assert.deepEqual(c.mcpActive(), []);
  assert.equal(
    c.mcp.note(),
    "pi-foreman: MCP tools declared in your tool list: none. The tools of the MCP server alpha are not declared: find them with tool_search (a tool it loads is callable from the next turn on a provider that fixes its tool list per turn). Named but not available in this child (hidden in the MCP config): alpha/echo; name it under Friction in your report.",
  );
});

test("k: a named tool already active before preload is listed as declared, neither activated nor traced again", async (t) => {
  const c = await child(t, { launch: ["alpha", "alpha/echo"], already: ["mcp__alpha__echo"] });
  assert.deepEqual(c.mcpActive(), ["mcp__alpha__echo"]);
  assert.deepEqual(c.trace, []);
  assert.equal(c.mcp.note(), `pi-foreman: MCP tools declared in your tool list: mcp__alpha__echo. ${SEARCH}`);
});

test("k: named tools only: a first turn on a direct provider after another provider does not wait again and traces nothing more", async (t) => {
  const polls = { count: 0 };
  const c = await child(t, { launch: ["alpha/echo", "beta/probe"], tools: [{ name: "mcp__beta__probe", label: "beta/probe" }], provider: "p2", polls });
  const note = c.mcp.note();
  const traced = c.trace.length;
  const first = polls.count;
  assert.ok(first > 0, "the first turn waited for alpha/echo");
  await c.mcp.preload("p1");
  assert.equal(polls.count, first, "no second readiness wait");
  assert.equal(c.trace.length, traced);
  assert.equal(c.mcp.note(), note);
});

// ---------------------------------------------------------------- a server that registered no tool: one sentence for a hidden and a silent server

const NONE_DECLARED = "pi-foreman: MCP tools declared in your tool list: none. No other MCP tool is declared in this launch.";
const NO_TOOL = "it did not answer in time or it is hidden in the MCP config";
const alphaHidden = [{ name: "alpha", config: { exposure: "hidden" } }];

test("m: [alpha/echo] with nothing registered gets the no-tool sentence, with a hidden config and with a silent server (same text)", async (t) => {
  const text = `${NONE_DECLARED} MCP server alpha registered no tool: ${NO_TOOL}, so its named tools (alpha/echo) are not declared; name it under Friction in your report.`;
  const hidden = await child(t, { launch: ["alpha/echo"], tools: [], servers: alphaHidden, piOrder: true });
  const silent = await child(t, { launch: ["alpha/echo"], tools: [], piOrder: true });
  assert.equal(hidden.mcp.note(), text);
  assert.equal(silent.mcp.note(), text);
});

test("m: [alpha] named whole with nothing registered, on a direct provider: the no-tool sentence, no tool_search promise", async (t) => {
  for (const servers of [alphaHidden, undefined]) {
    const c = await child(t, { launch: ["alpha"], tools: [], servers, piOrder: true });
    const note = c.mcp.note() ?? "";
    assert.equal(note, `${NONE_DECLARED} MCP server alpha registered no tool: ${NO_TOOL}; name it under Friction in your report.`);
    assert.doesNotMatch(note, /tool_search|later/);
  }
});

test("m: several silent servers, named and whole, each get the sentence; a server that registered keeps its own wording", async (t) => {
  const c = await child(t, { launch: ["alpha/echo", "beta"], tools: [], servers: [], piOrder: true });
  assert.equal(
    c.mcp.note(),
    `${NONE_DECLARED} MCP server beta registered no tool: ${NO_TOOL}; name it under Friction in your report. MCP server alpha registered no tool: ${NO_TOOL}, so its named tools (alpha/echo) are not declared; name it under Friction in your report.`,
  );
});

test("m: a later getMcpServers or loadConfig call changes nothing in the line", async (t) => {
  for (const launch of [["alpha/echo"], ["alpha"]]) {
    const c = await child(t, { launch, tools: [], servers: alphaHidden, piOrder: true });
    const note = c.mcp.note();
    assert.match(note ?? "", /registered no tool/);
    c.state.servers = [{ name: "alpha", config: { exposure: "deferred" } }];
    c.state.ext = [{ name: "alpha", config: { exposure: "deferred" } }];
    c.read();
    await c.turn();
    assert.equal(c.mcp.note(), note, launch.join(","));
    c.state.servers = [];
    c.state.ext = [];
    c.read();
    assert.equal(c.mcp.note(), note, launch.join(","));
  }
});

// ---------------------------------------------------------------- n: a server registering late, mixed exposure, a one-tool server, no contradictory line

test("n: [alpha, beta/probe], alpha registers after a turn on p2, then a turn on p1 under the cap: alpha's tools are declared, no no-tool sentence for it", async (t) => {
  const c = await child(t, { launch: ["alpha", "beta/probe"], provider: "p2", late: ["alpha"] });
  assert.match(c.mcp.note() ?? "", /MCP server alpha registered no tool/);
  c.register("alpha");
  await c.mcp.preload("p1");
  assert.deepEqual(c.mcpActive().sort(), ["mcp__alpha__echo", "mcp__alpha__shout", "mcp__alpha__whisper", "mcp__beta__probe"]);
  assert.equal(c.mcp.note(), "pi-foreman: MCP tools declared in your tool list: mcp__beta__probe, all 3 tools of server alpha. No other MCP tool is reachable in this launch.");
});

test("n: the same with alpha over the cap: the cap sentence, alpha in the search sentence, no unreachability claim and no no-tool sentence", async (t) => {
  const c = await child(t, { launch: ["alpha", "beta/probe"], provider: "p2", late: ["alpha"], max: 3 });
  c.register("alpha");
  await c.mcp.preload("p1");
  assert.deepEqual(c.mcpActive(), ["mcp__beta__probe"]);
  assert.equal(
    c.mcp.note(),
    `pi-foreman: MCP tools declared in your tool list: mcp__beta__probe. ${SEARCH} With the 1 named tool, the 3 MCP tools of the servers named whole are over the cap of 3 (mcp.directMaxTools), so they are not declared and found with tool_search; name that under Friction in your report.`,
  );
});

test("n: a server that registered nothing by the end of the wait: the line does not claim that no other tool is reachable", async (t) => {
  const c = await child(t, { launch: ["alpha", "beta"], late: ["alpha"] });
  assert.equal(
    c.mcp.note(),
    `pi-foreman: MCP tools declared in your tool list: all 2 tools of server beta. No other MCP tool is declared in this launch. MCP server alpha registered no tool: ${NO_TOOL}; name it under Friction in your report.`,
  );
});

test("n: a whole server with mixed exposure: the line gives the declared count, not all, and sends the rest to the search", async (t) => {
  const tools: Reg[] = [{ name: "mcp__alpha__echo", label: "alpha/echo" }, { name: "mcp__alpha__shout", label: "alpha/shout" }, { name: "mcp__alpha__whisper", label: "alpha/whisper", exposure: "codemode" }];
  const c = await child(t, { launch: ["alpha"], tools });
  assert.deepEqual(c.mcpActive(), ["mcp__alpha__echo", "mcp__alpha__shout"]);
  assert.equal(c.mcp.note(), `pi-foreman: MCP tools declared in your tool list: 2 tools of server alpha. ${SEARCH}`);
});

test("n: a whole server with one tool: the count reads singular", async (t) => {
  const c = await child(t, { launch: ["alpha"], tools: [{ name: "mcp__alpha__echo", label: "alpha/echo" }] });
  assert.equal(c.mcp.note(), "pi-foreman: MCP tools declared in your tool list: the only tool of server alpha. No other MCP tool is reachable in this launch.");
});

test("n: no sequence yields a line with two contradictory statements about one server", async (t) => {
  const launches = [["alpha", "beta"], ["alpha/echo", "beta/probe"], ["alpha", "alpha/echo"], ["alpha", "beta/probe"]];
  const states = ["registered", "silent", "late"] as const;
  const sequences = [["p1"], ["p2"], ["p2", "p1"], ["p2", "p2"]];
  const mixed: Reg[] = [...TOOLS.slice(0, 2), { name: "mcp__alpha__whisper", label: "alpha/whisper", exposure: "codemode" }, ...TOOLS.slice(3)];
  for (const launch of launches) for (const state of states) for (const seq of sequences) for (const max of [undefined, 3]) for (const tools of [TOOLS, mixed]) {
    const where = JSON.stringify({ launch, state, seq, max, mixed: tools === mixed });
    const c = await child(t, { launch, provider: seq[0], max, tools: state === "silent" ? tools.filter((x) => !x.label.startsWith("alpha/")) : tools, ...(state === "late" ? { late: ["alpha"] } : {}) });
    const lines = [c.mcp.note()];
    if (state === "late") c.register("alpha");
    for (const p of seq.slice(1)) {
      await c.mcp.preload(p);
      lines.push(c.mcp.note());
    }
    await c.turn();
    lines.push(c.mcp.note());
    for (const line of lines) {
      assert.ok(line, where);
      const search = (/of the MCP servers? (.+?) are not declared/.exec(line)?.[1] ?? "").split(", ");
      const noTool = /MCP server (\S+) registered no tool/g;
      const silent = [...line.matchAll(noTool)].map((m) => m[1]!);
      for (const server of ["alpha", "beta"]) {
        const facts = [new RegExp(`(all \\d+ tools|the only tool) of server ${server}\\b`).test(line), search.includes(server), silent.includes(server)];
        assert.ok(facts.filter(Boolean).length <= 1, `${where}: ${server} ${facts}: ${line}`);
      }
      if (/No other MCP tool is reachable/.test(line)) assert.ok(!/ are not declared/.test(line) && silent.length === 0, `${where}: ${line}`);
    }
  }
});

test("h: a server named whole whose registered tools are hidden is not offered for search on a provider outside directProviders; a deferred one still is", async (t) => {
  const tools: Reg[] = [{ name: "mcp__alpha__echo", label: "alpha/echo", exposure: "hidden" }, { name: "mcp__beta__probe", label: "beta/probe" }];
  const c = await child(t, { launch: ["alpha", "beta"], tools, provider: "p2" });
  const note = c.mcp.note() ?? "";
  assert.match(note, /The tools of the MCP server beta are not declared: find them with tool_search/);
  assert.doesNotMatch(note, /MCP servers? alpha[^.]*find them with tool_search/);
  assert.match(note, /Named but not available in this child \(hidden in the MCP config\): alpha;/);
  await c.turn();
  assert.equal(c.mcp.note(), note);
  const only = await child(t, { launch: ["alpha"], tools, provider: "p2" });
  assert.doesNotMatch(only.mcp.note() ?? "", /tool_search/);
});
