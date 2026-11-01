// The harness tool_search (ledger items 2, 4): candidates, ranking, the codemode result, the un-hide path and parity with Pi's search.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolSearchToolDefinition } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/tool-search/tool.js";
import { createToolSearchTool, TOOL_SEARCH_DESCRIPTION } from "../toolsearch.ts";
import type { SearchableSkill, ToolInfoLike } from "../toolsearch.ts";

const schema = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });

const MCP_ECHO: ToolInfoLike = { name: "mcp__fx__echo", description: "Echo a message back.\nSecond line.", parameters: schema({ text: { type: "string", description: "Text to echo" } }, ["text"]), exposure: "deferred" };
const MCP_SHOUT: ToolInfoLike = { name: "mcp__fx__shout", description: "Shout a message in capitals.", parameters: schema({ text: { type: "string" } }), exposure: "deferred" };
const BG_RESULT: ToolInfoLike = { name: "bg_result", description: "Fetch the stored result of a finished background task.", parameters: schema({ id: { type: "string", description: "Task id" }, tail: { type: "number" } }, ["id"]), exposure: "direct" };
const BG_KILL: ToolInfoLike = { name: "bg_kill", description: "Stop a running background task.", parameters: schema({ id: { type: "string" } }, ["id"]), exposure: "direct" };
const READ: ToolInfoLike = { name: "read", description: "Read a file.", parameters: schema({ path: { type: "string" } }, ["path"]), exposure: "direct" };
const SKILLS: SearchableSkill[] = [
  { name: "example-domain-skill", description: "Handle example domain widgets and gadgets.", filePath: "/skills/example-domain-skill/SKILL.md" },
  { name: "other-skill", description: "Unrelated guidance about invoices.", filePath: "/skills/other-skill/SKILL.md" },
];

interface Opts {
  active?: string[];
  hidden?: string[];
  skills?: SearchableSkill[];
  tools?: ToolInfoLike[];
}

function rig(o: Opts = {}) {
  const tools = o.tools ?? [MCP_ECHO, MCP_SHOUT, BG_RESULT, BG_KILL, READ];
  let active = o.active ?? ["read", "bg_result", "bg_kill", "tool_search", "codemode"];
  let hidden = o.hidden ?? ["bg_result", "bg_kill"];
  const unhidden: string[] = [];
  const found: unknown[] = [];
  const sets: string[][] = [];
  const host = { getAllTools: () => tools, getActiveTools: () => [...active], setActiveTools: (n: string[]) => { active = [...n]; sets.push([...n]); } };
  const tool = createToolSearchTool({ host, hidden: () => hidden, unhide: (n) => { unhidden.push(...n); hidden = hidden.filter((h) => !n.includes(h)); }, skills: () => o.skills ?? [], found: (h) => void found.push(h) });
  const run = async (query: string, limit?: number): Promise<{ text: string; details: Record<string, unknown> }> => {
    const r = await tool.execute("t1", { query, ...(limit ? { limit } : {}) });
    return { text: r.content[0].text, details: r.details as Record<string, unknown> };
  };
  return { tool, run, host, unhidden, found, sets, active: () => active, hidden: () => hidden };
}

test("the tool is model-only, reaches all tools and names the three kinds in its description", () => {
  const { tool } = rig();
  assert.equal(tool.name, "tool_search");
  assert.equal(tool.exposure, "model-only");
  assert.equal(tool.reachesTools(), "all");
  assert.match(TOOL_SEARCH_DESCRIPTION, /not declared to you upfront/);
  assert.match(TOOL_SEARCH_DESCRIPTION, /deferred tools/);
  assert.match(TOOL_SEARCH_DESCRIPTION, /searchable skills/);
});

test("prepareLoadout hides the harness-hidden names that are declared", () => {
  const { tool } = rig({ hidden: ["bg_result", "bg_kill", "not_declared"] });
  assert.deepEqual(tool.prepareLoadout({ declared: [{ name: "bg_result" }, { name: "bg_kill" }, { name: "read" }] }), { hiddenDeclarations: ["bg_result", "bg_kill"] });
  assert.equal(rig({ hidden: [] }).tool.prepareLoadout({ declared: [{ name: "read" }] }), undefined);
});

test("candidates are the union of Pi-searchable tools, hidden declarations and skills; a declared tool is not a candidate", async () => {
  const r = rig({ skills: SKILLS });
  const echo = await r.run("echo message");
  assert.match(echo.text, /mcp__fx__echo/);
  const result = await r.run("stored result finished task");
  assert.match(result.text, /bg_result/);
  const skill = await r.run("domain widgets gadgets");
  assert.match(skill.text, /<name>example-domain-skill<\/name>/);
  assert.equal((await r.run("read a file path")).text, "No matching tools found."); // read is declared and not hidden
});

test("ranking: the best match comes first and the limit applies across kinds", async () => {
  const r = rig({ skills: SKILLS });
  const res = await r.run("background task", 1);
  assert.match(res.text, /bg_(result|kill)/);
  assert.equal(res.text.split("\n").filter((l) => l.startsWith("- ")).length, 1);
  const stop = await r.run("stop a running background task");
  assert.ok(stop.text.indexOf("bg_kill") < stop.text.indexOf("bg_result") || !stop.text.includes("bg_result"), stop.text);
});

test("no hit: the text Pi prints", async () => {
  assert.deepEqual(await rig().run("zzz qqq"), { text: "No matching tools found.", details: { loaded: [] } });
  await assert.rejects(() => rig().run("  "), /query must not be empty/);
  await assert.rejects(() => rig().run("echo", -1), /limit must be a positive integer|query/);
});

test("a hidden declaration with codemode active prints the schema and the codemode call and leaves the declarations unchanged", async () => {
  const r = rig();
  const before = r.active();
  const res = await r.run("stored result finished");
  assert.match(res.text, /callable now from a codemode script/);
  assert.ok(res.text.includes(JSON.stringify(BG_RESULT.parameters)), "the full JSON schema");
  assert.match(res.text, /tools\.bg_result\(\{ id: <string> \}\)/);
  assert.deepEqual(r.active(), before);
  assert.deepEqual(r.sets, []); // no setActiveTools call: the cached prefix is untouched
  assert.deepEqual(r.unhidden, []);
  assert.deepEqual(r.hidden(), ["bg_result", "bg_kill"]);
  assert.deepEqual(r.found, [{ name: "bg_result", kind: "tool", unhidden: false }]);
});

test("without codemode a hidden declaration is un-hidden once and the loadout is re-applied", async () => {
  const r = rig({ active: ["read", "bg_result", "bg_kill", "tool_search"] });
  const res = await r.run("stored result finished");
  assert.match(res.text, /declared from the next request/);
  assert.deepEqual(r.unhidden, ["bg_result"]);
  assert.deepEqual(r.hidden(), ["bg_kill"]);
  assert.deepEqual(r.sets, [["read", "bg_result", "bg_kill", "tool_search"]]); // setActiveTools(getActiveTools())
  assert.deepEqual(r.found, [{ name: "bg_result", kind: "tool", unhidden: true }]);
  assert.deepEqual(r.tool.prepareLoadout({ declared: [{ name: "bg_result" }, { name: "bg_kill" }] }), { hiddenDeclarations: ["bg_kill"] });
  // the un-hidden tool is a declared tool now, no longer a candidate
  assert.equal((await r.run("stored result finished")).text, "No matching tools found.");
});

test("a skill hit prints its <skill> entry with name, description and location, escaped", async () => {
  const r = rig({ skills: [{ name: "s", description: "Fish & <chips>", filePath: "/x/SKILL.md" }] });
  const res = await r.run("fish chips");
  assert.match(res.text, /<skill>\n  <name>s<\/name>\n  <description>Fish &amp; &lt;chips&gt;<\/description>\n  <location>\/x\/SKILL\.md<\/location>\n<\/skill>/);
  assert.deepEqual(r.found, [{ name: "s", kind: "skill", unhidden: false }]);
  assert.deepEqual(r.sets, []);
});

test("child parity: on a Pi candidate set only, the output and the activation equal Pi's own search", async () => {
  for (const query of ["echo", "shout capitals", "message", "text", "nothing here at all"]) {
    const ours = rig({ tools: [MCP_ECHO, MCP_SHOUT, READ], active: ["read", "tool_search"], hidden: [] });
    let piActive = ["read", "tool_search"];
    const piTools = [MCP_ECHO, MCP_SHOUT, READ];
    const pi = createToolSearchToolDefinition({ tools: { getAllTools: () => piTools, getActiveTools: () => [...piActive], setActiveTools: (n: string[]) => { piActive = [...n]; } } as never }) as unknown as { execute(id: string, p: { query: string }): Promise<{ content: { text: string }[]; details: { loaded: string[] } }> };
    const expected = await pi.execute("t", { query });
    const got = await ours.run(query);
    assert.equal(got.text, expected.content[0].text, query);
    assert.deepEqual(got.details.loaded, expected.details.loaded, query);
    assert.deepEqual(ours.active(), piActive, query);
  }
});
