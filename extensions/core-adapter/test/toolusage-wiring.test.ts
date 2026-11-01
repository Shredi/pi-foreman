// The tool-usage line wired into the adapter (first turn, rewrite on change, none when unchanged, written by a child into the
// parent's file) and a child session's hidden skills (the pi-foreman-skills section and the child tool_search).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";
import { usageDir } from "../usage.ts";

type T = { after(fn: () => void | Promise<void>): void };
type Def = { name: string; execute(id: string, p: Record<string, unknown>): Promise<{ content: { text: string }[] }> };

const NAMES = ["read", "bash", "tool_search", "example_tool", "bg_kill"];

async function rigWith(t: T, o: { child?: boolean; config?: Record<string, unknown>; roles?: Record<string, unknown>; cwd?: string } = {}) {
  const registered = new Map<string, Def>();
  const saved = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  if (o.child) process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({ "pi-foreman/1": { foremanSession: "fs-1", workspace: "/w", role: "builder", launchId: "L1", kind: "first", model: null } });
  t.after(() => {
    if (saved === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
    else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = saved;
  });
  const rig = await r11Rig(t, {}, {
    child: o.child,
    config: { ...(o.roles ? { roles: o.roles } : {}), ...o.config },
    ctx: { ...(o.cwd ? { cwd: o.cwd } : {}), sessionManager: { getSessionId: () => "tu-1", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] }, ui: { notify: () => undefined, confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined } },
    piExtra: {
      registerTool: (d: Def) => void registered.set(d.name, d),
      getActiveTools: () => [...NAMES],
      getAllTools: () => NAMES.map((name) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} }, exposure: "direct", sourceInfo: { path: name === "example_tool" ? "/p/node_modules/example-package/index.ts" : "builtin:" + name, source: "local" } })),
      setActiveTools: () => undefined,
      appendEntry: () => undefined,
    },
  });
  const toolLines = (): Record<string, unknown>[] => {
    const dir = usageDir(rig.agentDir);
    const out: Record<string, unknown>[] = [];
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) for (const l of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) if (l.includes('"tool-usage"')) out.push(JSON.parse(l));
    return out;
  };
  return { rig, registered, toolLines };
}

const turn = (skills?: { name: string; description: string; filePath: string }[]) => ({ prompt: "go", systemPromptOptions: { sections: {} as Record<string, string>, ...(skills ? { skills } : {}) } });
const msg = (name: string, args: unknown = {}) => ({ message: { role: "assistant", content: [{ type: "toolCall", id: "c", name, arguments: args }] }, toolResults: [] });

test("the first turn writes one tool-usage line; a changed used writes another; an unchanged turn writes none", async (t) => {
  const r = await rigWith(t, { config: { skills: { visible: [], hidden: ["example-*"] } } });
  await r.rig.fire("before_agent_start", turn([{ name: "example-domain-skill", description: "d", filePath: "/s/example-domain-skill/SKILL.md" }, { name: "other-skill", description: "d", filePath: "/s/other-skill/SKILL.md" }]));
  const first = r.toolLines();
  assert.equal(first.length, 1);
  assert.equal(first[0].role, "foreman");
  assert.equal(first[0].session, "tu-1");
  assert.deepEqual(first[0].skillsListed, ["other-skill"]);
  assert.deepEqual(first[0].skillsHidden, ["example-domain-skill"]);
  assert.deepEqual(first[0].used, []);
  assert.ok((first[0].declared as string[]).includes("example_tool"));
  assert.equal((first[0].sources as Record<string, string>).example_tool, "example-package");
  await r.rig.fire("turn_end", msg("example_tool"));
  assert.equal(r.toolLines().length, 2);
  assert.deepEqual(r.toolLines()[1].used, ["example_tool"]);
  await r.rig.fire("turn_end", msg("example_tool"));
  await r.rig.fire("before_agent_start", turn());
  assert.equal(r.toolLines().length, 2, "no change, no line");
  await r.registered.get("tool_search")!.execute("t1", { query: "example domain skill" });
  await r.rig.fire("turn_end", msg("read", { path: "/s/example-domain-skill/SKILL.md" }));
  const last = r.toolLines().at(-1)!;
  assert.deepEqual(last.found, ["example-domain-skill"]);
  assert.deepEqual(last.skillsRead, ["example-domain-skill"]);
  assert.deepEqual(last.used, ["example_tool", "read"]);
});

test("a second session_start in one load (/new, /resume) starts a fresh tracker: its first line carries only its own sets", async (t) => {
  const r = await rigWith(t);
  await r.rig.fire("before_agent_start", turn());
  await r.rig.fire("turn_end", msg("example_tool"));
  assert.equal(r.toolLines().length, 2);
  await r.rig.restart();
  await r.rig.fire("before_agent_start", turn());
  assert.equal(r.toolLines().length, 3);
  const last = r.toolLines().at(-1)!;
  assert.deepEqual(last.used, []);
  assert.deepEqual(last.found, []);
});

test("a child writes its tool-usage line, with its role, into the foreman session's file", async (t) => {
  const r = await rigWith(t, { child: true });
  await r.rig.fire("before_agent_start", turn());
  const lines = r.toolLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].role, "builder");
  assert.equal(lines[0].foremanSession, "fs-1");
  const files = fs.readdirSync(usageDir(r.rig.agentDir));
  assert.deepEqual(files, ["fs-1.jsonl"]);
});

test("a child session: the pi-foreman-skills section lists the role's hidden skills and the child tool_search returns one", async (t) => {
  // the role's skills resolve from the session's cwd at session start, so the project exists before the rig starts
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "toolusage-skill-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const dir = path.join(cwd, ".agents", "skills", "example-domain-skill");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: example-domain-skill\ndescription: example domain skill for a child\n---\nbody\n");
  const r = await rigWith(t, { cwd, child: true, roles: { builder: { searchable: [], skills: ["example-domain-skill"] } }, config: { skills: { visible: [], hidden: ["example-*"] } } });
  const event = turn();
  await r.rig.fire("before_agent_start", event);
  assert.equal(event.systemPromptOptions.sections["pi-foreman-skills"], "Searchable skills, find one with `tool_search <words>` and read its file: example-domain-skill");
  const res = await r.registered.get("tool_search")!.execute("t1", { query: "example domain skill" });
  assert.match(res.content[0].text, /<name>example-domain-skill<\/name>/);
  assert.equal(r.toolLines()[0].role, "builder");
  assert.deepEqual(r.toolLines()[0].skillsHidden, ["example-domain-skill"]);
});
