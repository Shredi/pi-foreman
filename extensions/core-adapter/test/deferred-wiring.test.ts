// Deferred tool declarations wired into the adapter (ledger items 2, 4, 8): the hidden set at session start, the hint section, the
// session entry, the trace events, /foreman status and the doctor WARNs, driven through the real adapter with a fake pi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

type T = { after(fn: () => void | Promise<void>): void };
type Def = { name: string; prepareLoadout?: (l: { declared: { name: string }[] }) => { hiddenDeclarations?: string[] } | undefined; execute(id: string, p: Record<string, unknown>): Promise<{ content: { text: string }[] }> };

const NAMES = ["read", "bash", "tool_search", "codemode", "bg_run", "bg_result", "bg_kill", "fusion_reason", "foreman_move", "plan_mode_question", "subagent"];

interface Opts {
  active?: string[];
  all?: string[];
  branch?: unknown[];
  config?: Record<string, unknown>;
  child?: boolean;
  roles?: Record<string, unknown>;
}

async function rigWith(t: T, o: Opts = {}) {
  const registered = new Map<string, Def>();
  const entries: { type: string; data: unknown }[] = [];
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const notes: string[] = [];
  let active = o.active ?? NAMES;
  const sets: string[][] = [];
  const saved = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  if (o.child) process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({ "pi-foreman/1": { foremanSession: "fs-1", workspace: "/w", role: "builder", launchId: "L1", kind: "first", model: null } });
  t.after(() => {
    if (saved === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
    else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = saved;
  });
  const rig = await r11Rig(t, {}, {
    child: o.child,
    config: { ...(o.roles ? { roles: o.roles } : {}), ...o.config },
    ctx: { sessionManager: { getSessionId: () => "dw-1", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => o.branch ?? [] }, ui: { notify: (m: string) => void notes.push(m), confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined } },
    piExtra: {
      registerTool: (d: Def) => void registered.set(d.name, d),
      registerCommand: (n: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => void commands.set(n, c),
      getActiveTools: () => [...active],
      getAllTools: () => (o.all ?? NAMES).map((name) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} }, exposure: "direct" })),
      setActiveTools: (n: string[]) => { active = [...n]; sets.push([...n]); },
      appendEntry: (customType: string, data: unknown) => void (customType === "deferred-loaded" && entries.push({ type: customType, data })),
    },
  });
  return { rig, registered, entries, commands, notes, sets, active: () => active };
}

const hiddenOf = (d: Def | undefined, declared: string[]) => d?.prepareLoadout?.({ declared: declared.map((name) => ({ name })) })?.hiddenDeclarations;

test("the foreman registers the harness tool_search, hides the deferred tools and traces tools_deferred once", async (t) => {
  const r = await rigWith(t);
  const search = r.registered.get("tool_search");
  assert.ok(search, "tool_search is registered");
  // the adapter's own PR tools join the active set before the hidden set is computed
  const expected = ["bg_result", "bg_kill", "fusion_reason", "foreman_move", "plan_mode_question", "pr_comments", "pr_track", "pr_untrack"];
  assert.deepEqual(hiddenOf(search, r.active()), expected);
  assert.deepEqual(r.rig.events("tools_deferred").map((e) => [e.count, e.names]), [[8, expected.join(",")]]);
  assert.deepEqual(r.entries, [{ type: "deferred-loaded", data: { names: [], planMode: false } }]);
  assert.ok(r.sets.length >= 1); // the loadout is re-applied once the set is in place
});

test("before_agent_start adds the pi-foreman-deferred section with names only, using the codemode wording when codemode is active", async (t) => {
  const r = await rigWith(t);
  const event = { prompt: "go", systemPromptOptions: { sections: {} as Record<string, string> } };
  await r.rig.fire("before_agent_start", event);
  const hint = event.systemPromptOptions.sections["pi-foreman-deferred"];
  assert.match(hint, /^Deferred tools, search with `tool_search` before use; a found tool is callable at once from a codemode script as `tools\.<name>\(\)`: bg_result, bg_kill, fusion_reason, foreman_move, plan_mode_question, pr_comments, pr_track, pr_untrack$/);
  const without = await rigWith(t, { active: NAMES.filter((n) => n !== "codemode"), roles: { foreman: { codemode: false } } });
  const event2 = { prompt: "go", systemPromptOptions: { sections: {} as Record<string, string> } };
  await without.rig.fire("before_agent_start", event2);
  assert.doesNotMatch(event2.systemPromptOptions.sections["pi-foreman-deferred"], /codemode/);
});

test("tools.deferred: [] hides nothing and adds no section", async (t) => {
  const r = await rigWith(t, { config: { tools: { deferred: [] } } });
  assert.equal(hiddenOf(r.registered.get("tool_search"), NAMES), undefined);
  const event = { prompt: "go", systemPromptOptions: { sections: {} as Record<string, string> } };
  await r.rig.fire("before_agent_start", event);
  assert.equal(event.systemPromptOptions.sections["pi-foreman-deferred"], undefined);
  assert.deepEqual(r.rig.events("tools_deferred"), []);
});

test("a session that starts in plan mode declares the plan-mode tools; a normal session does not", async (t) => {
  const plan = await rigWith(t, { branch: [{ type: "custom", customType: "plan-mode", data: { enabled: true } }] });
  assert.equal(hiddenOf(plan.registered.get("tool_search"), NAMES)?.includes("plan_mode_question"), false);
  assert.deepEqual(plan.entries, [{ type: "deferred-loaded", data: { names: [], planMode: true } }]);
  const normal = await rigWith(t);
  assert.equal(hiddenOf(normal.registered.get("tool_search"), NAMES)?.includes("plan_mode_question"), true);
});

test("resume: the recorded un-hidden names and plan-mode decision are reused, nothing is written again", async (t) => {
  const r = await rigWith(t, { branch: [{ type: "custom", customType: "deferred-loaded", data: { names: ["bg_result"], planMode: false } }, { type: "custom", customType: "plan-mode", data: { enabled: true } }] });
  const hidden = hiddenOf(r.registered.get("tool_search"), NAMES);
  assert.equal(hidden?.includes("bg_result"), false);
  assert.equal(hidden?.includes("plan_mode_question"), true); // the recorded decision wins over the later plan-mode entry
  assert.deepEqual(r.entries, []);
});

test("a tool_search hit is traced as tool_found; without codemode the un-hidden name is persisted", async (t) => {
  const r = await rigWith(t, { active: NAMES.filter((n) => n !== "codemode"), roles: { foreman: { codemode: false } } });
  const res = await r.registered.get("tool_search")!.execute("t1", { query: "bg_kill tool" });
  assert.match(res.content[0].text, /declared from the next request/);
  const found = r.rig.events("tool_found");
  assert.ok(found.some((e) => e.name === "bg_kill" && e.kind === "tool" && e.unhidden === true), JSON.stringify(found));
  assert.ok(r.entries.some((e) => (e.data as { names: string[] }).names.includes("bg_kill")));
  assert.equal((hiddenOf(r.registered.get("tool_search"), NAMES) ?? []).includes("bg_kill"), false);
});

test("a child without MCP or searchable names has tool_search taken out of its active set, so nothing is hidden", async (t) => {
  const r = await rigWith(t, { child: true, roles: { builder: { searchable: [] } } });
  assert.equal(r.active().includes("tool_search"), false);
  assert.deepEqual(r.rig.events("tools_deferred"), []);
  const event = { prompt: "go", systemPromptOptions: { sections: {} as Record<string, string> } };
  await r.rig.fire("before_agent_start", event);
  assert.equal(event.systemPromptOptions.sections["pi-foreman-deferred"], undefined);
});

test("a child whose role has searchable names keeps tool_search active", async (t) => {
  const r = await rigWith(t, { child: true, roles: { builder: { searchable: ["foreman_move"] } } });
  assert.equal(r.active().includes("tool_search"), true);
});

test("a child hides the names its role makes searchable and keeps tool_search active; the foreman does not", async (t) => {
  const names = [...NAMES, "example_tool"];
  const roles = { builder: { searchable: ["example_tool", "read"] } };
  const config = { tools: { deferred: ["fusion_*"] } };
  const child = await rigWith(t, { child: true, active: names, all: names, roles, config });
  assert.equal(child.active().includes("tool_search"), true);
  assert.deepEqual(hiddenOf(child.registered.get("tool_search"), child.active()), ["fusion_reason", "example_tool"]); // the floor (read) still wins
  const foreman = await rigWith(t, { active: names, all: names, roles, config });
  assert.equal(hiddenOf(foreman.registered.get("tool_search"), foreman.active())?.includes("example_tool"), false);
});

test("/foreman status shows the deferred count", async (t) => {
  const r = await rigWith(t);
  await r.commands.get("foreman")!.handler("status", r.rig.ctx);
  assert.ok(r.notes.some((n) => n.includes("deferred tools: 8")), r.notes.join("\n"));
});

test("foreman doctor warns about a pattern that matches nothing and prints the PI_BG_FEATURES=process line for the add-on's optional tools", async (t) => {
  const r = await rigWith(t, { config: { tools: { deferred: ["fusion_*", "bg_result", "typo_*"] } } });
  await r.commands.get("foreman")!.handler("doctor", r.rig.ctx);
  const out = r.notes.join("\n").split("\n");
  assert.ok(out.some((l) => l.startsWith("WARN") && l.includes("\"typo_*\"")), out.join("\n"));
  assert.equal(out.some((l) => l.startsWith("WARN") && l.includes("\"fusion_*\"")), false);
  assert.ok(out.some((l) => l.startsWith("WARN") && l.includes("fusion_reason") && l.includes("PI_BG_FEATURES=process")), out.join("\n"));
});

test("foreman doctor has neither WARN when the patterns match and the add-on's optional tools are absent", async (t) => {
  const names = NAMES.filter((n) => n !== "fusion_reason");
  const r = await rigWith(t, { active: names, all: names, config: { tools: { deferred: ["bg_result"] } } });
  await r.commands.get("foreman")!.handler("doctor", r.rig.ctx);
  const text = r.notes.join("\n");
  assert.doesNotMatch(text, /tools\.deferred pattern/);
  assert.doesNotMatch(text, /PI_BG_FEATURES=process/);
});
