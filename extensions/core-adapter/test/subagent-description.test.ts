// The foreman's `subagent` tool description names where size/risk go (prepareLoadout on foreman_triage; foreman only, sizing on).
import { test } from "node:test";
import assert from "node:assert/strict";
import { subagentDescription, TOP_LEVEL_NOTE } from "../sizing.ts";
import { r11Rig } from "./_r11rig.ts";

const declared = [{ name: "bash", description: "b" }, { name: "subagent", description: "Delegate." }];

test("subagentDescription: appends the sentence once, only when sizing is on and the tool is declared", () => {
  const d = subagentDescription(declared, true);
  assert.ok(d?.startsWith("Delegate.\n\n"));
  assert.ok(d?.includes(TOP_LEVEL_NOTE));
  assert.equal(subagentDescription([{ name: "subagent", description: d! }], true), null);
  assert.equal(subagentDescription(declared, false), null);
  assert.equal(subagentDescription([{ name: "bash", description: "b" }], true), null);
});

type Tool = { name: string; prepareLoadout?: (l: unknown) => { descriptions?: Record<string, string> } | undefined };

async function tools(t: Parameters<typeof r11Rig>[0], opts: { child?: boolean; config?: Record<string, unknown> }): Promise<Tool[]> {
  const seen: Tool[] = [];
  await r11Rig(t, {}, { ...opts, piExtra: { registerTool: (tool: Tool) => void seen.push(tool) } });
  return seen;
}

test("adapter: foreman_triage amends the subagent description", async (t) => {
  const triage = (await tools(t, {})).find((x) => x.name === "foreman_triage");
  const out = triage?.prepareLoadout?.({ declared });
  assert.ok(out?.descriptions?.subagent?.includes(TOP_LEVEL_NOTE));
});

test("adapter: a child registers no triage tool, sizing off leaves the description", async (t) => {
  assert.equal((await tools(t, { child: true })).find((x) => x.name === "foreman_triage"), undefined);
  const off = (await tools(t, { config: { ladder: { sizing: { enabled: false } } } })).find((x) => x.name === "foreman_triage");
  assert.equal(off?.prepareLoadout?.({ declared }), undefined);
});
