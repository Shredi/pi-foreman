// With sizing off the foreman's `subagent` tool description still carries the `mcp` launch sentence (when a role has an MCP ceiling);
// the text is the same on every prep of a session, and with sizing on it is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MCP_LAUNCH_NOTE, TOP_LEVEL_NOTE } from "../sizing.ts";
import { r11Rig } from "./_r11rig.ts";

const declared = [{ name: "bash", description: "b" }, { name: "subagent", description: "Delegate." }];

type Tool = { name: string; prepareLoadout?: (l: unknown) => { descriptions?: Record<string, string> } | undefined };

async function triage(t: Parameters<typeof r11Rig>[0], config: Record<string, unknown>): Promise<Tool | undefined> {
  const seen: Tool[] = [];
  await r11Rig(t, {}, { config, piExtra: { registerTool: (tool: Tool) => void seen.push(tool) } });
  return seen.find((x) => x.name === "foreman_triage");
}

const OFF = { ladder: { sizing: { enabled: false } } };
const CEILING = { roles: { builder: { mcp: ["alpha"] } } };

test("sizing off, a role with an MCP ceiling: the description gets the mcp sentence once, the same bytes on every prep", async (t) => {
  const tool = await triage(t, { ...OFF, ...CEILING });
  const first = tool?.prepareLoadout?.({ declared })?.descriptions?.subagent;
  assert.equal(first, `Delegate.\n\n${MCP_LAUNCH_NOTE}`);
  assert.equal(first?.includes(TOP_LEVEL_NOTE), false);
  assert.equal(tool?.prepareLoadout?.({ declared })?.descriptions?.subagent, first);
  assert.equal(tool?.prepareLoadout?.({ declared: [{ name: "subagent", description: first! }] }), undefined, "never appended twice");
});

test("sizing on: the description is unchanged (placement sentence, then the mcp sentence)", async (t) => {
  const tool = await triage(t, CEILING);
  assert.equal(tool?.prepareLoadout?.({ declared })?.descriptions?.subagent, `Delegate.\n\nBuilder launches (pi-foreman): ${TOP_LEVEL_NOTE} ${MCP_LAUNCH_NOTE}`);
});
