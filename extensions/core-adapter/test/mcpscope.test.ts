import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedMcp, filterMcpConfig, mcpCallAllowed, mcpEmpty, toolExposureOf } from "../mcpscope.ts";
import type { McpEntryLike } from "../mcpscope.ts";

const roles = {
  builder: { mcp: ["fx", "docs/search", "my-srv/ping"] },
  finalizer: { mcp: ["fx/echo", "fx/shout", "fx"] },
  reviewer: { mcp: ["fx"], denyTools: ["mcp__*"] },
  senior: { mcp: ["fx", "other"], denyTools: ["mcp__other__*"] },
  none: {},
};

test("the allowed set is the role list; a bare server entry wins over its server/tool entries", () => {
  assert.deepEqual(allowedMcp(roles, "builder"), { servers: ["fx"], tools: { docs: ["search"], "my-srv": ["ping"] } });
  assert.deepEqual(allowedMcp(roles, "finalizer"), { servers: ["fx"], tools: {} });
  assert.deepEqual(allowedMcp({ builder: { mcp: ["fx/echo", "fx/shout", "fx/echo"] } }, "builder"), { servers: [], tools: { fx: ["echo", "shout"] } });
});

test("a role without mcp, an unknown role and an unreadable role allow nothing", () => {
  for (const role of ["none", "ghost", null, undefined]) assert.ok(mcpEmpty(allowedMcp(roles, role)));
  assert.ok(mcpEmpty(allowedMcp(undefined, "builder")));
});

test("denyTools wins: a deny pattern on a server empties it, other servers stay", () => {
  assert.ok(mcpEmpty(allowedMcp(roles, "reviewer")));
  assert.deepEqual(allowedMcp(roles, "senior"), { servers: ["fx"], tools: {} });
  assert.ok(mcpEmpty(allowedMcp({ r: { mcp: ["a/b"], denyTools: ["mcp__a__b"] } }, "r")));
});

test("launch narrowing keeps entries inside the ceiling, [] allows nothing, undefined no narrowing", () => {
  assert.deepEqual(allowedMcp(roles, "builder", ["fx"]), { servers: ["fx"], tools: {} });
  assert.deepEqual(allowedMcp(roles, "builder", ["fx/echo"]), { servers: [], tools: { fx: ["echo"] } });
  assert.deepEqual(allowedMcp(roles, "builder", ["docs/search", "my_srv/ping"]), { servers: [], tools: { docs: ["search"], my_srv: ["ping"] } });
  assert.ok(mcpEmpty(allowedMcp(roles, "builder", [])));
  assert.deepEqual(allowedMcp(roles, "builder", undefined), allowedMcp(roles, "builder"));
  assert.deepEqual(allowedMcp(roles, "builder", null), allowedMcp(roles, "builder"));
});

test("launch entries outside the ceiling are dropped", () => {
  assert.ok(mcpEmpty(allowedMcp(roles, "builder", ["other"])));
  assert.ok(mcpEmpty(allowedMcp(roles, "builder", ["docs"]))); // the role lists only docs/search
  assert.ok(mcpEmpty(allowedMcp(roles, "builder", ["docs/other"])));
  assert.ok(mcpEmpty(allowedMcp(roles, "none", ["fx"])));
});

const loaded = (servers: McpEntryLike[], extra: { autoEnableCodemode?: boolean; projectConfig?: string } = {}) => ({ servers, errors: ["e1"], ...extra });
const entry = (name: string, config: Record<string, unknown>): McpEntryLike => ({ name, source: "/x/mcp.json", scope: "global", config: { command: "node", ...config } });

test("filterMcpConfig drops foreign servers and passes errors, autoEnableCodemode and enabled through", () => {
  const input = loaded([entry("fx", { enabled: false }), entry("zz", {})], { autoEnableCodemode: false, projectConfig: "/p/.pi/mcp.json" });
  const out = filterMcpConfig(input, { servers: ["fx"], tools: {} });
  assert.deepEqual(out.servers.map((s) => s.name), ["fx"]);
  assert.equal(out.servers[0].config.enabled, false);
  assert.equal(out.autoEnableCodemode, false);
  assert.deepEqual(out.errors, ["e1"]);
  assert.equal(out.projectConfig, "/p/.pi/mcp.json");
  assert.deepEqual(filterMcpConfig(input, { servers: [], tools: {} }).servers, []);
});

test("filterMcpConfig maps every exposure: direct becomes deferred, deferred and codemode stay, hidden drops the server", () => {
  const exposures = ["direct", "deferred", "codemode", "hidden", undefined];
  const out = filterMcpConfig(loaded(exposures.map((e, i) => entry(`s${i}`, e ? { exposure: e } : {}))), { servers: exposures.map((_, i) => `s${i}`), tools: {} });
  assert.deepEqual(out.servers.map((s) => [s.name, s.config.exposure]), [["s0", "deferred"], ["s1", "deferred"], ["s2", "codemode"], ["s4", "codemode"]]);
});

test("filterMcpConfig maps toolExposure values the same way", () => {
  const out = filterMcpConfig(loaded([entry("fx", { exposure: "deferred", toolExposure: { a: "direct", b: "hidden", "c*": "codemode" } })]), { servers: ["fx"], tools: {} });
  assert.deepEqual(out.servers[0].config.toolExposure, { a: "deferred", b: "hidden", "c*": "codemode" });
});

test("filterMcpConfig: server/tool entries make the server hidden with only the allowed tools, wildcards and foreign overrides dropped", () => {
  const input = loaded([entry("fx", { toolExposure: { "*": "direct", shout: "direct" } })]);
  const out = filterMcpConfig(input, { servers: [], tools: { fx: ["echo"] } });
  assert.equal(out.servers[0].config.exposure, "hidden");
  assert.deepEqual(out.servers[0].config.toolExposure, { echo: "deferred" });
  // the input is not changed
  assert.deepEqual(input.servers[0].config.toolExposure, { "*": "direct", shout: "direct" });
});

test("filterMcpConfig: each allowed tool is mapped from its own resolved exposure; a server of only hidden tools is dropped", () => {
  const config = { exposure: "hidden", toolExposure: { a: "codemode", "b*": "direct" } };
  const out = filterMcpConfig(loaded([entry("fx", config)]), { servers: [], tools: { fx: ["a", "bb", "c"] } });
  assert.deepEqual(out.servers[0].config.toolExposure, { a: "codemode", bb: "deferred", c: "hidden" });
  assert.deepEqual(filterMcpConfig(loaded([entry("fx", config)]), { servers: [], tools: { fx: ["c"] } }).servers, []);
});

test("filterMcpConfig compares server names in the - and _ forms", () => {
  const out = filterMcpConfig(loaded([entry("my-srv", {})]), { servers: ["my_srv"], tools: {} });
  assert.deepEqual(out.servers.map((s) => s.name), ["my-srv"]);
  const one = filterMcpConfig(loaded([entry("my_srv", {})]), { servers: [], tools: { "my-srv": ["ping"] } });
  assert.deepEqual(one.servers[0].config.toolExposure, { ping: "codemode" });
});

test("toolExposureOf follows Pi: exact entry, then pattern, then the server exposure (default codemode)", () => {
  assert.equal(toolExposureOf({}, "x"), "codemode");
  assert.equal(toolExposureOf({ exposure: "direct" }, "x"), "direct");
  assert.equal(toolExposureOf({ exposure: "direct", toolExposure: { "x*": "hidden", xy: "deferred" } }, "xy"), "deferred");
  assert.equal(toolExposureOf({ exposure: "direct", toolExposure: { "x*": "hidden" } }, "xz"), "hidden");
});

test("mcpCallAllowed: server and server/tool entries, - and _ server names, hash-suffixed tool names carry the raw label", () => {
  const allowed = { servers: ["fx"], tools: { "my-srv": ["ping"] } };
  assert.equal(mcpCallAllowed(allowed, "fx/echo"), true);
  assert.equal(mcpCallAllowed(allowed, "fx/with/slash"), true);
  assert.equal(mcpCallAllowed(allowed, "my_srv/ping"), true);
  assert.equal(mcpCallAllowed(allowed, "my-srv/pong"), false);
  assert.equal(mcpCallAllowed(allowed, "other/echo"), false);
  // the label is the raw `server/tool`, so a hashed tool name (mcp__my_srv__ping_1a2b3c4d) is judged by its label
  assert.equal(mcpCallAllowed(allowed, "my-srv/ping"), true);
  for (const bad of [undefined, null, "", "fx", "fx/", "/echo"]) assert.equal(mcpCallAllowed(allowed, bad), false);
});
