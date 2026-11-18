// The model-only tools line (D44): with codemode active, one fixed section names every registered model-only tool, active or not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

const SECTION = "pi-foreman-model-only";

async function rig(t: Parameters<typeof r11Rig>[0], o: { active: string[]; tools: { name: string; exposure: string }[] }) {
  const r = await r11Rig(t, {}, {
    ctx: { sessionManager: { getSessionId: () => "mo-1", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] }, ui: { notify: () => undefined, confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined } },
    piExtra: {
      registerTool: () => undefined,
      getActiveTools: () => [...o.active],
      getAllTools: () => o.tools.map((x) => ({ ...x, description: `${x.name} tool`, parameters: { type: "object", properties: {} } })),
      setActiveTools: () => undefined,
      appendEntry: () => undefined,
    },
  });
  return async () => {
    const event = { prompt: "go", systemPromptOptions: { sections: {} as Record<string, string> } };
    await r.fire("before_agent_start", event);
    return event.systemPromptOptions.sections[SECTION];
  };
}

const TOOLS = [{ name: "read", exposure: "direct" }, { name: "codemode", exposure: "direct" }, { name: "subagent_supervisor", exposure: "model-only" }, { name: "subagent", exposure: "model-only" }];

test("codemode active and an inactive model-only tool: the section names it", async (t) => {
  const turn = await rig(t, { active: ["read", "codemode"], tools: TOOLS });
  const line = await turn();
  assert.equal(line, "Model-only tools: when declared, call them directly; a codemode script's `tools` does not have them: subagent_supervisor, subagent");
  assert.equal(await turn(), line, "bytes unchanged on the second request");
});

test("the set is fixed at the first request", async (t) => {
  const tools = [...TOOLS];
  const turn = await rig(t, { active: ["read", "codemode"], tools });
  const line = await turn();
  tools.push({ name: "late_tool", exposure: "model-only" });
  assert.equal(await turn(), line);
});

test("no codemode: no section", async (t) => {
  const turn = await rig(t, { active: ["read"], tools: TOOLS });
  assert.equal(await turn(), undefined);
});

test("codemode and no model-only tool: no section", async (t) => {
  const turn = await rig(t, { active: ["read", "codemode"], tools: TOOLS.slice(0, 2) });
  assert.equal(await turn(), undefined);
});
