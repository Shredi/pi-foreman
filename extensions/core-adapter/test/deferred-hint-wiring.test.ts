// The pi-foreman-deferred hint across context_with_system: re-put after a compaction, not re-put once the hidden set is empty,
// reset by a fresh session start (driven through the real adapter with a fake pi).
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

type Def = { name: string; execute(id: string, p: Record<string, unknown>): Promise<unknown> };
type Sys = { role: "system"; content: string; sections?: Record<string, string | null>; timestamp: number };
type Out = { messages: Sys[] } | undefined;

const NAMES = ["read", "bash", "tool_search", "bg_run", "bg_result", "bg_kill", "fusion_reason", "foreman_move", "plan_mode_question", "subagent"];
const head: Sys = { role: "system", content: "base", sections: { cwd: "cwd: /x" }, timestamp: 1 };
const user = { role: "user", content: "hi" };

async function rig(t: Parameters<typeof r11Rig>[0]) {
  const registered = new Map<string, Def>();
  const r = await r11Rig(t, {}, {
    ctx: { sessionManager: { getSessionId: () => "dh-1", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] }, ui: { notify: () => undefined, confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined } },
    piExtra: {
      registerTool: (d: Def) => void registered.set(d.name, d),
      getActiveTools: () => [...NAMES],
      getAllTools: () => NAMES.map((name) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} }, exposure: "direct" })),
      setActiveTools: () => undefined,
      appendEntry: () => undefined,
    },
  });
  const turn = async () => {
    const event = { prompt: "go", systemPromptOptions: { sections: {} as Record<string, string> } };
    await r.fire("before_agent_start", event);
    return event.systemPromptOptions.sections["pi-foreman-deferred"];
  };
  const context = async () => (await r.fire("context_with_system", { messages: [head, user] })) as Out;
  return { r, registered, turn, context };
}

test("compaction: the head lacks the deferred section and it is put back", async (t) => {
  const x = await rig(t);
  const hint = await x.turn();
  assert.ok(hint);
  const out = await x.context();
  assert.ok(out?.messages.some((m) => m.role === "system" && m.sections?.["pi-foreman-deferred"] === hint), "hint re-put");
});

test("the hidden set empties mid-session: the stale hint is not re-put", async (t) => {
  const x = await rig(t);
  assert.ok(await x.turn());
  for (const n of ["bg_result", "bg_kill", "fusion_reason", "foreman_move", "plan_mode_question", "pr_comments"]) await x.registered.get("tool_search")!.execute("t", { query: `${n} tool` });
  assert.equal(await x.turn(), undefined);
  const out = await x.context();
  assert.equal(out?.messages.some((m) => m.sections?.["pi-foreman-deferred"] !== undefined), false);
});

test("a fresh session start resets the hint until the next turn", async (t) => {
  const x = await rig(t);
  assert.ok(await x.turn());
  await x.r.fire("session_start", { reason: "startup" });
  const out = await x.context();
  assert.equal(out?.messages.some((m) => m.sections?.["pi-foreman-deferred"] !== undefined) ?? false, false);
});
