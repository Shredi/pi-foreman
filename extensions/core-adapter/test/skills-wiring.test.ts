// Skill visibility wired into before_agent_start (ledger item 3): the filtered systemPromptOptions.skills, the stable
// pi-foreman-skills section, the hidden skills reaching tool_search and the re-put of the hint sections after a compaction.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";

type T = { after(fn: () => void | Promise<void>): void };
type Def = { name: string; execute(id: string, p: Record<string, unknown>): Promise<{ content: { text: string }[] }> };
type Skill = { name: string; description: string; filePath: string };

async function rigWith(t: T, config: Record<string, unknown>) {
  const registered = new Map<string, Def>();
  const rig = await r11Rig(t, {}, {
    config,
    ctx: { sessionManager: { getSessionId: () => "sv-1", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] }, ui: { notify: () => undefined, confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined } },
    piExtra: {
      registerTool: (d: Def) => void registered.set(d.name, d),
      getActiveTools: () => ["read", "bash", "tool_search"],
      getAllTools: () => [],
      setActiveTools: () => undefined,
      appendEntry: () => undefined,
    },
  });
  return { rig, registered };
}

const skill = (name: string, filePath = `/skills/${name}/SKILL.md`): Skill => ({ name, description: `${name} description`, filePath });
const turn = (skills: Skill[]) => ({ prompt: "go", systemPromptOptions: { sections: {} as Record<string, string>, skills } });

test("hidden-by-config skills leave the list, get the hint section and keep their entry for tool_search", async (t) => {
  const r = await rigWith(t, { skills: { visible: [], hidden: ["example-*"] } });
  const event = turn([skill("example-domain-skill"), skill("other-skill")]);
  await r.rig.fire("before_agent_start", event);
  assert.deepEqual(event.systemPromptOptions.skills.map((s) => s.name), ["other-skill"]);
  assert.equal(event.systemPromptOptions.sections["pi-foreman-skills"], "Searchable skills, find one with `tool_search <words>` and read its file: example-domain-skill");
  const res = await r.registered.get("tool_search")!.execute("t1", { query: "example domain skill" });
  assert.match(res.content[0].text, /<name>example-domain-skill<\/name>/);
  assert.match(res.content[0].text, /<location>\/skills\/example-domain-skill\/SKILL\.md<\/location>/);
});

test("frontmatter metadata.visibility: search hides a skill; a skill without metadata stays", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillwire-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const search = path.join(dir, "search.md");
  const plain = path.join(dir, "plain.md");
  fs.writeFileSync(search, "---\nname: example-domain-skill\nmetadata:\n  visibility: search\n---\n");
  fs.writeFileSync(plain, "---\nname: other-skill\ndescription: x\n---\n");
  const r = await rigWith(t, { skills: { visible: [], hidden: [] } });
  const event = turn([skill("example-domain-skill", search), skill("other-skill", plain)]);
  await r.rig.fire("before_agent_start", event);
  assert.deepEqual(event.systemPromptOptions.skills.map((s) => s.name), ["other-skill"]);
});

test("nothing hidden: the list is untouched and no section is added", async (t) => {
  const r = await rigWith(t, { skills: { visible: [], hidden: [] } });
  const event = turn([skill("example-domain-skill"), skill("other-skill")]);
  await r.rig.fire("before_agent_start", event);
  assert.equal(event.systemPromptOptions.skills.length, 2);
  assert.equal(event.systemPromptOptions.sections["pi-foreman-skills"], undefined);
});

test("the split is made once: a later turn hides the same names and the section text does not change", async (t) => {
  const r = await rigWith(t, { skills: { visible: [], hidden: ["example-*"] } });
  const first = turn([skill("example-domain-skill"), skill("other-skill")]);
  await r.rig.fire("before_agent_start", first);
  const second = turn([skill("example-domain-skill"), skill("other-skill"), skill("example-new-skill")]);
  await r.rig.fire("before_agent_start", second);
  assert.deepEqual(second.systemPromptOptions.skills.map((s) => s.name), ["other-skill", "example-new-skill"]);
  assert.equal(second.systemPromptOptions.sections["pi-foreman-skills"], first.systemPromptOptions.sections["pi-foreman-skills"]);
});

test("a non-empty skills.visible makes every other skill searchable", async (t) => {
  const r = await rigWith(t, { skills: { visible: ["other-*"], hidden: [] } });
  const event = turn([skill("example-domain-skill"), skill("other-skill")]);
  await r.rig.fire("before_agent_start", event);
  assert.deepEqual(event.systemPromptOptions.skills.map((s) => s.name), ["other-skill"]);
});

test("after a compaction the stored head lacks the hint sections: context_with_system puts them back", async (t) => {
  const r = await rigWith(t, { skills: { visible: [], hidden: ["example-*"] } });
  await r.rig.fire("before_agent_start", turn([skill("example-domain-skill")]));
  const head = { role: "system", content: "", sections: {} };
  const out = (await r.rig.fire("context_with_system", { messages: [head, { role: "user", content: "hi" }] })) as { messages: { sections?: Record<string, string> }[] } | undefined;
  assert.match(out?.messages[0].sections?.["pi-foreman-skills"] ?? "", /^Searchable skills, find one with `tool_search <words>`/);
});
