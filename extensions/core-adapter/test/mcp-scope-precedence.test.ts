// r41: the child's MCP scope block and denyTools only block and come before the gate, so a refusal is never turned into
// the gate's answer (here: the unreachable review, as no review model is configured).
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

async function rigFor(t: Parameters<typeof r11Rig>[0], roles: Record<string, unknown>) {
  const saved = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  t.after(() => {
    if (saved === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
    else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = saved;
  });
  process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({ "pi-foreman/1": { foremanSession: "fs-1", workspace: "/w", role: "builder", launchId: "L1", kind: "first", model: null } });
  return r11Rig(t, {}, {
    child: true,
    config: { roles },
    deps: { mcpChild: { resolveRoot: () => null, createMcp: () => () => undefined } },
  });
}

test("an out-of-scope mcp__ call is refused with the scope reason, not the gate's", async (t) => {
  const rig = await rigFor(t, { builder: { mcp: ["fx"] } });
  const res = await rig.call("mcp__other__probe", {});
  assert.equal(res?.block, true);
  assert.match(res?.reason ?? "", /outside the MCP scope of role builder/);
  assert.equal(rig.events("guard").some((r) => r.guard === "mcp_scope"), true);
});

test("a denyTools match is refused with its own reason, not the gate's", async (t) => {
  const rig = await rigFor(t, { builder: { mcp: ["fx"], denyTools: ["mcp__*"] } });
  const res = await rig.call("mcp__fx__echo", {});
  assert.match(res?.reason ?? "", /denyTools/);
});
