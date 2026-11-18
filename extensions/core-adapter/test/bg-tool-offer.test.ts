// foreman_bg refuses when the background-tasks add-on (bg_run) is present, so it is not offered then: dropped from the active tools at
// session_start, and neither the tool floor nor before_agent_start brings it back. Without the add-on it stays active.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

type T = { after(fn: () => void | Promise<void>): void };

const BASE = ["read", "bash", "tool_search", "codemode", "foreman_bg", "foreman_wait", "subagent"];

async function rigWith(t: T, names: string[], start: string[] = BASE) {
  let active = [...start];
  const rig = await r11Rig(t, {}, {
    ctx: { sessionManager: { getSessionId: () => "bg-1", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] }, ui: { notify: () => undefined, confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined } },
    piExtra: {
      registerTool: () => undefined,
      registerCommand: () => undefined,
      getActiveTools: () => [...active],
      getAllTools: () => names.map((name) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} }, exposure: "direct" })),
      setActiveTools: (n: string[]) => { active = [...n]; },
      appendEntry: () => undefined,
    },
  });
  return { rig, active: () => active };
}

test("with the add-on present foreman_bg is not active after session_start or before_agent_start", async (t) => {
  const r = await rigWith(t, [...BASE, "bg_run"]);
  assert.ok(!r.active().includes("foreman_bg"), "dropped at session_start");
  assert.ok(r.active().includes("foreman_wait"), "the rest of the floor stays");
  await r.rig.fire("before_agent_start", { prompt: "go", systemPromptOptions: { sections: {} as Record<string, string> } });
  assert.ok(!r.active().includes("foreman_bg"), "the floor does not add it back");
});

test("without the add-on foreman_bg stays active", async (t) => {
  const r = await rigWith(t, BASE);
  assert.ok(r.active().includes("foreman_bg"));
  await r.rig.fire("before_agent_start", { prompt: "go", systemPromptOptions: { sections: {} as Record<string, string> } });
  assert.ok(r.active().includes("foreman_bg"));
});

test("the floor adds foreman_bg back without the add-on when a tool reset left it inactive; with the add-on it does not", async (t) => {
  const without = await rigWith(t, BASE, BASE.filter((n) => n !== "foreman_bg"));
  assert.ok(without.active().includes("foreman_bg"));
  const withAddon = await rigWith(t, [...BASE, "bg_run"], BASE.filter((n) => n !== "foreman_bg"));
  assert.ok(!withAddon.active().includes("foreman_bg"));
});
