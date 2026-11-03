// context_with_system keeps the provider's prompt equal to ctx.getSystemPrompt() when only the section order differs
// (alignSections unit tests, then the wiring: reload/restart, nothing changed, compaction, hints present/absent, content differs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import { alignSections, keepSection } from "../usage.ts";
import { r11Rig } from "./_r11rig.ts";

type Sys = { role: string; content: string; sections?: Record<string, string | null>; timestamp?: number };
type Msg = Sys | { role: "user"; content: string };

/** Pi's getCurrentSystemPrompt: replay every system message (patched by name, new keys appended), then render. */
function replay(messages: Msg[]): string {
  const content: string[] = [];
  const sections = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "system") continue;
    const s = m as Sys;
    if (s.content) content.push(s.content);
    for (const [k, v] of Object.entries(s.sections ?? {})) if (v === null) sections.delete(k);
    else sections.set(k, v);
  }
  return getSystemMessageText({ role: "system", content: content.join("\n\n"), sections: Object.fromEntries(sections), timestamp: 0 } as never);
}

const user: Msg = { role: "user", content: "hi" };
const head = (sections: Record<string, string | null>): Sys => ({ role: "system", content: "base", sections, timestamp: 1 });
const patch = (sections: Record<string, string | null>): Sys => ({ role: "system", content: "", sections, timestamp: 2 });
const canonicalOf = (sections: Record<string, string>) => getSystemMessageText({ role: "system", content: "base", sections, timestamp: 0 } as never);

const fresh = { cwd: "cwd: /x", "pi-foreman-deferred": "deferred hint", "pi-foreman-skills": "skills hint", "pi-foreman": "foreman block", pi_background_shell_policy: "shell policy", mcp_servers: "mcp" };

test("alignSections: hints appended by a later patch end up in the canonical order", () => {
  const messages: Msg[] = [head({ cwd: "cwd: /x", "pi-foreman": "foreman block", pi_background_shell_policy: "shell policy", mcp_servers: "mcp" }), user, patch({ "pi-foreman-deferred": "deferred hint", "pi-foreman-skills": "skills hint", "pi-foreman": "foreman block" })];
  const want = canonicalOf(fresh);
  assert.notEqual(replay(messages), want);
  const out = alignSections(messages, want);
  assert.ok(out);
  assert.equal(replay(out), want);
  assert.equal(out.length, messages.length);
  assert.equal((out[2] as Sys).content, "");
});

test("alignSections: nothing to change returns null", () => {
  const messages: Msg[] = [head(fresh), user];
  assert.equal(alignSections(messages, canonicalOf(fresh)), null);
  assert.equal(alignSections([user], "x"), null);
});

test("alignSections: differing content leaves the messages alone", () => {
  const messages: Msg[] = [head({ cwd: "cwd: /x", "pi-foreman": "old block" }), patch({ "pi-foreman-skills": "skills hint" })];
  assert.equal(alignSections(messages, canonicalOf({ "pi-foreman-skills": "skills hint", cwd: "cwd: /x", "pi-foreman": "new block" })), null);
  assert.equal(alignSections(messages, canonicalOf({ cwd: "cwd: /x" })), null);
});

test("alignSections: a later null patch is folded into the head", () => {
  const messages: Msg[] = [head({ a: "A", b: "B", c: "C" }), patch({ b: null, d: "D" })];
  const want = canonicalOf({ d: "D", a: "A", c: "C" });
  const out = alignSections(messages, want);
  assert.ok(out);
  assert.equal(replay(out), want);
});

test("keepSection re-put plus alignSections: a compacted head gets the sections back in canonical order", () => {
  const messages: Msg[] = [head({ cwd: "cwd: /x" }), user];
  let m = keepSection(messages, "pi-foreman", "foreman block") ?? messages;
  m = keepSection(m, "pi-foreman-skills", "skills hint") ?? m;
  const want = canonicalOf({ cwd: "cwd: /x", "pi-foreman-skills": "skills hint", "pi-foreman": "foreman block" });
  assert.notEqual(replay(m), want);
  const out = alignSections(m, want);
  assert.ok(out);
  assert.equal(replay(out), want);
});

type Out = { messages: Msg[] } | undefined;
async function rig(t: Parameters<typeof r11Rig>[0], hidden: string[]) {
  const prompt = { text: "" };
  const r = await r11Rig(t, {}, {
    config: { skills: { visible: [], hidden } },
    ctx: { getSystemPrompt: () => prompt.text, sessionManager: { getSessionId: () => "al-1", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] }, ui: { notify: () => undefined, confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined } },
    piExtra: { registerTool: () => undefined, getActiveTools: () => ["read", "bash", "tool_search"], getAllTools: () => [], setActiveTools: () => undefined, appendEntry: () => undefined },
  });
  const turn = async (skills: { name: string; description: string; filePath: string }[]) => {
    const event = { prompt: "go", systemPromptOptions: { sections: {} as Record<string, string>, skills } };
    await r.fire("before_agent_start", event);
    return event.systemPromptOptions.sections;
  };
  return { r, prompt, turn };
}
const sk = (name: string) => ({ name, description: `${name} d`, filePath: `/s/${name}/SKILL.md` });

test("wiring, reload/restart: hints first appear in a patch; the provider render equals getSystemPrompt", async (t) => {
  const x = await rig(t, ["example-*"]);
  const added = await x.turn([sk("example-one")]);
  assert.ok(added["pi-foreman-skills"]);
  const foreman = "foreman block";
  const messages: Msg[] = [head({ cwd: "cwd: /x", "pi-foreman": foreman, pi_background_shell_policy: "shell policy" }), user, patch({ "pi-foreman-skills": added["pi-foreman-skills"], "pi-foreman": foreman })];
  x.prompt.text = canonicalOf({ cwd: "cwd: /x", "pi-foreman-skills": added["pi-foreman-skills"], "pi-foreman": foreman, pi_background_shell_policy: "shell policy" });
  const out = (await x.r.fire("context_with_system", { messages })) as Out;
  assert.ok(out, "reordered");
  assert.equal(replay(out.messages), x.prompt.text);
});

test("wiring, nothing changed: the handler returns undefined", async (t) => {
  const x = await rig(t, []);
  await x.turn([sk("other")]);
  const messages: Msg[] = [head({ cwd: "cwd: /x", "pi-foreman": "foreman block" }), user];
  x.prompt.text = replay(messages);
  assert.equal(await x.r.fire("context_with_system", { messages }), undefined);
});

test("wiring, compaction: the head lacks pi-foreman and the hint; both are put back and the render matches", async (t) => {
  const x = await rig(t, ["example-*"]);
  const added = await x.turn([sk("example-one")]);
  const hint = added["pi-foreman-skills"];
  const messages: Msg[] = [head({ cwd: "cwd: /x" }), user];
  const plain = (await x.r.fire("context_with_system", { messages })) as Out;
  assert.ok(plain?.messages.some((m) => m.role === "system" && (m as Sys).sections?.["pi-foreman-skills"] === hint), "hint re-put");
  const put = (plain!.messages[0] as Sys).sections!;
  assert.ok(put["pi-foreman"], "foreman section re-put");
  x.prompt.text = canonicalOf({ cwd: "cwd: /x", "pi-foreman-skills": hint, "pi-foreman": put["pi-foreman"]! });
  const out = (await x.r.fire("context_with_system", { messages })) as Out;
  assert.equal(replay(out!.messages), x.prompt.text);
});

test("wiring, hints absent: no hidden skills puts no skills hint", async (t) => {
  const x = await rig(t, []);
  const sections = await x.turn([sk("other")]);
  assert.equal(sections["pi-foreman-skills"], undefined);
  const out = (await x.r.fire("context_with_system", { messages: [head({ cwd: "cwd: /x" }), user] })) as Out;
  assert.equal((out?.messages[0] as Sys | undefined)?.sections?.["pi-foreman-skills"], undefined);
});

test("wiring, the hidden set empties: the stale hint is not re-put", async (t) => {
  const x = await rig(t, ["example-*"]);
  const added = await x.turn([sk("example-one")]);
  assert.ok(added["pi-foreman-skills"]);
  // the skills split is once per session, so empty the hidden set through a fresh session start
  await x.r.fire("session_start", { reason: "reload" });
  await x.turn([sk("other")]);
  const out = (await x.r.fire("context_with_system", { messages: [head({ cwd: "cwd: /x" }), user] })) as Out;
  const secs = (out?.messages[0] as Sys | undefined)?.sections ?? {};
  assert.equal(secs["pi-foreman-skills"], undefined);
});

test("wiring, content differs (not a permutation): the order is untouched", async (t) => {
  const x = await rig(t, []);
  await x.turn([sk("other")]);
  const messages: Msg[] = [head({ cwd: "cwd: /x", "pi-foreman": "foreman block" }), user, patch({ extra: "new" })];
  x.prompt.text = canonicalOf({ extra: "different", cwd: "cwd: /x", "pi-foreman": "foreman block" });
  assert.equal(await x.r.fire("context_with_system", { messages }), undefined);
});

async function misordered(t: Parameters<typeof r11Rig>[0], compat: Record<string, unknown> | undefined) {
  const x = await rig(t, ["example-*"]);
  const added = await x.turn([sk("example-one")]);
  const foreman = "foreman block";
  const messages: Msg[] = [head({ cwd: "cwd: /x", "pi-foreman": foreman }), user, patch({ "pi-foreman-skills": added["pi-foreman-skills"], "pi-foreman": foreman })];
  x.prompt.text = canonicalOf({ cwd: "cwd: /x", "pi-foreman-skills": added["pi-foreman-skills"], "pi-foreman": foreman });
  x.r.setModel({ provider: "fake", id: "m", compat } as never);
  return { x, messages };
}

test("wiring, supportsMidConvoSystemMessages true: the patches stay apart (no alignment)", async (t) => {
  const { x, messages } = await misordered(t, { supportsMidConvoSystemMessages: true });
  assert.equal(await x.r.fire("context_with_system", { messages }), undefined);
});

test("wiring, supportsMidConvoSystemMessages absent: the order is aligned", async (t) => {
  const { x, messages } = await misordered(t, undefined);
  const out = (await x.r.fire("context_with_system", { messages })) as Out;
  assert.ok(out);
  assert.equal(replay(out.messages), x.prompt.text);
});
