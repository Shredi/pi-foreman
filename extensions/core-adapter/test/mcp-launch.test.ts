// r68 item 5: the launch `mcp` field, validated against the role ceiling, stripped before pi-subagents and carried in the
// binding; group launches that need MCP are refused while pi-subagents forwards no per-entry bindings.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";
import { planMcpLaunch, workflowBindingBlock } from "../mcplaunch.ts";
import { readBinding, stripBinding } from "../usage.ts";

type T = { after(fn: () => void | Promise<void>): void };
const ROLES = { roles: { builder: { mcp: ["fx", "other/probe"] } } };
const GATE = /^pi-foreman: group launches with MCP need pi-subagents with per-entry bindings \(pinned [^)]+\); launch these roles as single subagent\(\{agent, task\}\) calls$/;

const rig = (t: T, config: Record<string, unknown> = ROLES) => r11Rig(t, {}, { ctx: reviewAllowOpts().ctx, config: { ...reviewAllowOpts().config, ...config }, deps: { mcpChild: { resolveRoot: () => null } } });
const bound = (input: Record<string, unknown>) => (input.extensionBindings as Record<string, Record<string, unknown>> | undefined)?.["pi-foreman/1"];

test("a single launch's mcp is validated, stripped and carried in the binding", async (t) => {
  const r = await rig(t);
  const input: Record<string, unknown> = { agent: "builder", task: "go", mcp: ["fx/echo"] };
  const { res } = await r.launch(input);
  assert.equal(res, undefined);
  assert.equal("mcp" in input, false);
  assert.deepEqual(bound(input)?.mcp, ["fx/echo"]);
});

test("mcp: [] is kept as none and an absent field leaves the binding without mcp", async (t) => {
  const r = await rig(t);
  const none: Record<string, unknown> = { agent: "builder", task: "go", mcp: [] };
  await r.launch(none);
  assert.deepEqual(bound(none)?.mcp, []);
  const absent: Record<string, unknown> = { agent: "builder", task: "go" };
  await r.launch(absent);
  assert.equal(bound(absent) !== undefined && "mcp" in bound(absent)!, false);
  assert.deepEqual(readBinding({ PI_SUBAGENT_EXTENSION_BINDINGS: JSON.stringify({ "pi-foreman/1": { ...bound(none), foremanSession: "f", workspace: "/w" } }) })?.mcp, []);
  assert.equal(readBinding({ PI_SUBAGENT_EXTENSION_BINDINGS: JSON.stringify({ "pi-foreman/1": { ...bound(absent), foremanSession: "f", workspace: "/w" } }) })?.mcp, undefined);
});

test("an entry outside the ceiling is refused with the docs text; server/tool is inside a listed server", async (t) => {
  const r = await rig(t);
  const out = await r.launch({ agent: "builder", task: "go", mcp: ["nope"] });
  assert.equal(out.res?.block, true);
  assert.equal(out.res?.reason, "pi-foreman: launch mcp entry nope is outside roles.builder.mcp");
  const tool = await r.launch({ agent: "builder", task: "go", mcp: ["other"] });
  assert.equal(tool.res?.reason, "pi-foreman: launch mcp entry other is outside roles.builder.mcp");
  const ok = await r.launch({ agent: "builder", task: "go", mcp: ["fx/echo", "other/probe"] });
  assert.equal(ok.res, undefined);
  assert.equal(r.events("launch_refused").some((e) => e.reason === "mcp_launch"), true);
});

test("options.mcp is refused", async (t) => {
  const r = await rig(t);
  const { res } = await r.launch({ agent: "builder", task: "go", options: { mcp: ["fx"] } });
  assert.equal(res?.block, true);
  assert.match(res?.reason ?? "", /options\.mcp is not a launch option/);
});

test("a malformed mcp field is refused", async (t) => {
  const r = await rig(t);
  assert.equal((await r.launch({ agent: "builder", task: "go", mcp: "fx" })).res?.block, true);
  assert.equal((await r.launch({ agent: "builder", task: "go", mcp: [1] })).res?.block, true);
});

test("a forged per-entry binding is dropped by stripBinding", () => {
  const input: Record<string, unknown> = {
    extensionBindings: { "pi-foreman/1": { role: "x" }, other: 1 },
    tasks: [{ agent: "builder", task: "a", extensionBindings: { "pi-foreman/1": { role: "y" } } }],
    chain: [{ agent: "builder", task: "b", extensionBindings: { "pi-foreman/1": {} } }, { parallel: [{ agent: "builder", task: "c", extensionBindings: { "pi-foreman/1": {} } }] }, { expand: 1, collect: 1, parallel: { agent: "builder", task: "d", extensionBindings: { "pi-foreman/1": {} } } }],
  };
  stripBinding(input);
  assert.deepEqual(input.extensionBindings, { other: 1 });
  assert.equal(JSON.stringify(input).includes("pi-foreman/1"), false);
});

const groups: Array<[string, () => Record<string, unknown>]> = [
  ["tasks entry with mcp", () => ({ tasks: [{ agent: "builder", task: "a", mcp: ["fx"] }] })],
  ["tasks entry whose role has a ceiling", () => ({ tasks: [{ agent: "builder", task: "a" }] })],
  ["chain entry", () => ({ chain: [{ agent: "builder", task: "a" }] })],
  ["chain parallel entry", () => ({ chain: [{ parallel: [{ agent: "explorer", task: "e" }, { agent: "builder", task: "a" }] }] })],
  ["dynamic fan-out step", () => ({ chain: [{ expand: "x", collect: "y", parallel: { agent: "builder", task: "a" } }] })],
];
for (const [name, make] of groups) {
  test(`group gate: ${name} is refused`, async (t) => {
    const r = await rig(t);
    const input = make();
    const copy = JSON.stringify(input);
    const { res } = await r.launch(input);
    assert.equal(res?.block, true);
    assert.match(res?.reason ?? "", GATE);
    assert.equal(JSON.stringify(input), copy, "group entries are not mutated");
    assert.equal(r.events("launch_refused").some((e) => e.reason === "mcp_group_gate"), true);
  });
}

test("a mixed group (one role with a ceiling, one without) is refused while the gate is false", async (t) => {
  const r = await rig(t);
  const { res } = await r.launch({ tasks: [{ agent: "reviewer", task: "a" }, { agent: "builder", task: "b" }] });
  assert.equal(res?.block, true);
  assert.match(res?.reason ?? "", GATE);
});

test("a forged per-entry binding is stripped by the hook; the ceiling-less group runs without any entry binding", async (t) => {
  const r = await rig(t, { roles: { builder: {} } });
  const forged = { "pi-foreman/1": { role: "builder", mcp: ["fx"] } };
  const input: Record<string, unknown> = {
    extensionBindings: forged,
    tasks: [{ agent: "builder", task: "a", extensionBindings: forged }],
  };
  const { res } = await r.launch(input);
  assert.equal(res, undefined);
  assert.equal(JSON.stringify(input).includes("pi-foreman/1"), false);
  const chain: Record<string, unknown> = { chain: [{ agent: "builder", task: "a", extensionBindings: forged }, { parallel: [{ agent: "builder", task: "b", extensionBindings: forged }] }] };
  assert.equal((await r.launch(chain)).res, undefined);
  assert.equal(JSON.stringify(chain).includes("pi-foreman/1"), false);
});

test("a workflowScript naming a binding is refused by the hook", async (t) => {
  const r = await rig(t, { safety: { subagents: { allowWorkflow: true } }, ...ROLES });
  const { res } = await r.launch({ workflowScript: "agent({ extensionBindings: {} })" });
  assert.equal(res?.block, true);
  assert.match(res?.reason ?? "", /workflow_binding/);
});

test("a group of roles without a ceiling runs as before", async (t) => {
  const r = await rig(t, { roles: { builder: {} } });
  const { res } = await r.launch({ tasks: [{ agent: "builder", task: "a" }, { agent: "builder", task: "b" }] });
  assert.equal(res, undefined);
});

test("a server mcp.json does not know is traced as mcp_launch_unknown_server; the launch still runs", async (t) => {
  const piRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "node_modules", "@earendil-works", "pi-coding-agent");
  const r = await r11Rig(t, {}, { ctx: reviewAllowOpts().ctx, config: { ...reviewAllowOpts().config, roles: { builder: { mcp: ["fx", "ghostsrv"] } } }, deps: { mcpChild: { resolveRoot: () => piRoot } } });
  fs.writeFileSync(path.join(r.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fx: { command: "node", args: ["x.mjs"] } } }));
  const { res } = await r.launch({ agent: "builder", task: "go" });
  assert.equal(res, undefined);
  assert.deepEqual(r.events("mcp_launch_unknown_server").map((e) => [e.role, e.reason]), [["builder", "ghostsrv"]]);
});

test("without an MCP loader there is nothing to compare against, so no unknown-server warning", async (t) => {
  const r = await rig(t, { roles: { builder: { mcp: ["ghostsrv"] } } });
  assert.equal((await r.launch({ agent: "builder", task: "go" })).res, undefined);
  assert.deepEqual(r.events("mcp_launch_unknown_server"), []);
});

test("planMcpLaunch: gate off lets a group through, per entry validation, hyphen/underscore are one server", () => {
  const roles = { builder: { mcp: ["my-srv"] }, reviewer: {} };
  const ok = planMcpLaunch({ tasks: [{ agent: "builder", task: "a", mcp: ["my_srv/x"] }, { agent: "reviewer", task: "b" }] }, roles, { perEntryBindings: true });
  assert.equal(ok.refusal, undefined);
  const bad = planMcpLaunch({ tasks: [{ agent: "reviewer", task: "b", mcp: ["my-srv"] }] }, roles, { perEntryBindings: true });
  assert.match(bad.refusal?.text ?? "", /outside roles\.reviewer\.mcp/);
});

test("workflow scripts naming a binding are refused; plain ones are not", () => {
  const ctx = { cwd: "/nonexistent", replyText: "```js workflow\nawait agent({ extensionBindings: {} })\n```" };
  assert.match(workflowBindingBlock({ workflow: true }, ctx) ?? "", /workflow_binding/);
  assert.equal(workflowBindingBlock({ workflow: true }, { cwd: "/x", replyText: "await agent({task: 'a'})" }), undefined);
  assert.match(workflowBindingBlock({ workflow: "x", args: { s: "pi-foreman/1" } }, ctx) ?? "", /workflow_binding/);
  assert.equal(workflowBindingBlock({ agent: "builder", task: "a" }, ctx), undefined);
});

test("workflow binding check: the string true, backslash paths and named resources", () => {
  const forged = { cwd: os.tmpdir(), replyText: "agent({ extensionBindings: {} })" };
  assert.match(workflowBindingBlock({ workflow: "true" }, forged) ?? "", /workflow_binding/);
  assert.equal(workflowBindingBlock({ workflow: "true" }, { cwd: "/x", replyText: "agent({})" }), undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfb-"));
  try {
    fs.writeFileSync(path.join(dir, "a.js"), "agent({ extensionBindings: {} })");
    fs.writeFileSync(path.join(dir, ".\\a.js"), "agent({ extensionBindings: {} })"); // on POSIX a backslash is a plain file name character
    assert.match(workflowBindingBlock({ workflow: ".\\a.js" }, { cwd: dir, replyText: "" }) ?? "", /workflow_binding/);
    assert.match(workflowBindingBlock({ workflow: "./a.js" }, { cwd: dir, replyText: "" }) ?? "", /workflow_binding/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const withCeiling = { cwd: "/x", replyText: "", roles: { builder: { mcp: ["fx"] }, reviewer: {} } };
  assert.match(workflowBindingBlock({ workflow: "my-flow" }, withCeiling) ?? "", /named workflow resources cannot be checked/);
  assert.equal(workflowBindingBlock({ workflow: "my-flow" }, { cwd: "/x", replyText: "", roles: { builder: {} } }), undefined);
});

test("workflow script path resolves against the launch cwd; unreadable scripts are refused under a ceiling", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-"));
  try {
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "wf.js"), "agent({ extensionBindings: {} })");
    const ctx = { cwd: dir, replyText: "" };
    assert.match(workflowBindingBlock({ workflow: "./wf.js", cwd: "sub" }, ctx) ?? "", /workflow_binding/);
    assert.match(workflowBindingBlock({ workflow: "./wf.js", cwd: path.join(dir, "sub") }, { cwd: "/x", replyText: "" }) ?? "", /workflow_binding/);
    const withCeiling = { ...ctx, roles: { builder: { mcp: ["fx"] } } };
    assert.match(workflowBindingBlock({ workflow: "./missing.js" }, withCeiling) ?? "", /cannot be read/);
    assert.equal(workflowBindingBlock({ workflow: "./missing.js" }, ctx), undefined);
    assert.equal(workflowBindingBlock({ workflow: "./missing.js" }, { ...ctx, roles: { builder: {} } }), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a binding mcp with non-string entries fails closed", () => {
  const env = (mcp: unknown) => ({ PI_SUBAGENT_EXTENSION_BINDINGS: JSON.stringify({ "pi-foreman/1": { foremanSession: "f", workspace: "/w", role: "builder", launchId: "l", mcp } }) });
  assert.deepEqual(readBinding(env(["fx", 1]))?.mcp, []);
  assert.deepEqual(readBinding(env("fx"))?.mcp, []);
  assert.deepEqual(readBinding(env(["fx"]))?.mcp, ["fx"]);
});

test("a tasks entry with mcp but no agent is refused", () => {
  const res = planMcpLaunch({ tasks: [{ task: "a", mcp: ["fx"] }] }, { builder: { mcp: ["fx"] } }, { perEntryBindings: true });
  assert.equal(res.refusal?.reason, "mcp_launch");
  assert.match(res.refusal?.text ?? "", /needs an agent/);
});

test("a workflow script file naming a binding is refused", async (t) => {
  const r = await rig(t, { safety: { subagents: { allowWorkflow: true } }, ...ROLES });
  fs.writeFileSync(path.join(r.project, "wf.js"), "agent({ extensionBindings: { 'pi-foreman/1': {} } })");
  const { res } = await r.launch({ workflow: "./wf.js" });
  assert.equal(res?.block, true);
  assert.match(res?.reason ?? "", /workflow_binding/);
  assert.equal(r.events("launch_refused").some((e) => e.reason === "workflow_binding"), true);
});

test("pinned fact: pi-subagents' buildStepOverrides forwards no extensionBindings (re-check on a pi-subagents bump)", () => {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "node_modules", "pi-subagents", "src", "runs", "background", "async-execution.js");
  const src = fs.readFileSync(file, "utf8");
  const start = src.indexOf("const buildStepOverrides");
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf("const buildSeqStep", start));
  assert.equal(body.includes("extensionBindings"), false);
});
