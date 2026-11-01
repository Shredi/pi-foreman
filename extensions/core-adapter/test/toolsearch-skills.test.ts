// tool_search with skills and the single-match un-hide (ledger items 3, 4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolSearchTool } from "../toolsearch.ts";
import type { SearchableSkill, ToolInfoLike } from "../toolsearch.ts";

const schema = (props: Record<string, unknown>) => ({ type: "object", properties: props, required: ["id"] });
const tool = (name: string, description: string): ToolInfoLike => ({ name, description, parameters: schema({ id: { type: "string" } }), exposure: "direct" });
const SKILLS: SearchableSkill[] = [{ name: "example-domain-skill", description: "Handle example domain widgets & gadgets.", filePath: "/skills/example-domain-skill/SKILL.md" }];

function rig(codemode: boolean) {
  const tools = [tool("example_tool", "Stop a running example task."), tool("example_other", "Stop a running example job."), tool("read", "Read a file.")];
  let active = ["read", "example_tool", "example_other", "tool_search", ...(codemode ? ["codemode"] : [])];
  let hidden = ["example_tool", "example_other"];
  const unhidden: string[] = [];
  const found: { name: string; kind: string; unhidden: boolean }[] = [];
  const t = createToolSearchTool({ host: { getAllTools: () => tools, getActiveTools: () => [...active], setActiveTools: (n) => void (active = [...n]) }, hidden: () => hidden, unhide: (n) => { unhidden.push(...n); hidden = hidden.filter((h) => !n.includes(h)); }, skills: () => SKILLS, found: (h) => void found.push(h) });
  return { run: async (query: string) => (await t.execute("t1", { query })), unhidden, found };
}

test("a skill hit prints the <skill> entry with name, description and location (escaped)", async () => {
  const r = rig(true);
  const res = await r.run("domain widgets gadgets");
  const text = res.content[0].text;
  assert.match(text, /<skill>\n {2}<name>example-domain-skill<\/name>\n {2}<description>Handle example domain widgets &amp; gadgets\.<\/description>\n {2}<location>\/skills\/example-domain-skill\/SKILL\.md<\/location>\n<\/skill>/);
  assert.deepEqual(r.found, [{ name: "example-domain-skill", kind: "skill", unhidden: false }]);
  assert.deepEqual((res.details as { skills: string[] }).skills, ["example-domain-skill"]);
});

test("without codemode one search un-hides only the single best match, never every hit", async () => {
  const r = rig(false);
  const res = await r.run("stop running example");
  assert.equal(r.unhidden.length, 1);
  const text = res.content[0].text;
  assert.match(text, /Loaded deferred tool example_(tool|other)\./);
  assert.match(text, /Other matches, search by exact name to load one: example_(tool|other)/);
  assert.equal(r.found.filter((f) => f.unhidden).length, 1);
});

test("without codemode the exact tool name wins over a better ranked neighbour", async () => {
  const r = rig(false);
  await r.run("example_other");
  assert.deepEqual(r.unhidden, ["example_other"]);
});

test("with codemode several matches print their schemas and nothing is un-hidden", async () => {
  const r = rig(true);
  const res = await r.run("stop running example");
  assert.deepEqual(r.unhidden, []);
  assert.match(res.content[0].text, /tools\.example_tool\(\{ id: <string> \}\)/);
  assert.match(res.content[0].text, /tools\.example_other\(\{ id: <string> \}\)/);
});
