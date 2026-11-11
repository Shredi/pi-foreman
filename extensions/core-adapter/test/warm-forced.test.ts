// The warm's system text equals the real turn's when a `before_agent_start` handler forced the prompt (an extension that
// returns `systemPrompt`). Pi projects the forced prompt after the `context_with_system` handlers (one head message with the
// forced text, no sections, no other system message), so the capture must carry that projection or the bridge's capture
// lookup refuses the warm. A fake of the bridge's capture records the key as the bridge does at `turn_start`
// (`ctx.getSystemPrompt()`) and resolves a context's system text as it does (exact key, else a prompt that embeds a key).
import { test } from "node:test";
import assert from "node:assert/strict";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { contentText, getCurrentSystemMessage, getCurrentTools, getSystemMessageText, normalizeContext } from "@earendil-works/pi-ai";
import { forcedProjection, replayWarm } from "../warmreplay.ts";

type Msg = Record<string, unknown>;
const tool = (name: string) => ({ name, description: `${name} description`, parameters: { type: "object", properties: {} } });

/** The bridge's canonical section order (its transcript.ts) and its system text of a context. */
const RANK = new Map([["preamble", 0], ["tools", 1], ["rules", 2], ["docs", 3], ["addendum", 4], ["project_context", 5], ["skills", 6], ["cwd", 7]]);
function bridgeSystemText(messages: Msg[]): string | undefined {
  const head = getCurrentSystemMessage(messages as never);
  if (!head) return undefined;
  const sections = Object.entries(head.sections ?? {}).filter((e): e is [string, string] => e[1] !== null);
  const ranked = sections.map(([n, v]) => ({ v, r: RANK.get(n) ?? 8 })).sort((a, b) => a.r - b.r);
  const parts = [contentText(head.content), ...ranked.map((x) => x.v)].filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** The bridge's capture: keys recorded at turn_start; a lookup is an exact match or a prompt that embeds a key. */
class FakeCapture {
  keys = new Set<string>();
  record(key: string): void {
    this.keys.add(key);
  }
  resolve(prompt: string | undefined): "exact" | "embedded" {
    if (!prompt) throw new Error("no prompt");
    if (this.keys.has(prompt)) return "exact";
    if ([...this.keys].some((k) => k.length > 0 && prompt.includes(k))) return "embedded";
    throw new Error(`prompt-capture: no capture for this ${prompt.length}-char system prompt`);
  }
}

/** Pi's request pipeline after the `context_with_system` handlers: hidden projection, forced projection, convertToLlm, normalizeContext. */
function realTurn(messages: Msg[], hidden: string[], forced: string | undefined): { messages: Msg[] } {
  const hide = new Set(hidden);
  let out = messages.map((m) => {
    if (m.role !== "system" || (!m.toolsAdded && !m.toolsRemoved)) return m;
    const { toolsAdded, toolsRemoved, ...rest } = m as { toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] } & Msg;
    const added = toolsAdded?.filter((t) => !hide.has(t.name)) ?? [];
    const removed = toolsRemoved?.filter((t) => !hide.has(t.name)) ?? [];
    return { ...rest, ...(added.length > 0 ? { toolsAdded: added } : {}), ...(removed.length > 0 ? { toolsRemoved: removed } : {}) };
  });
  if (forced !== undefined) {
    const current = getCurrentSystemMessage(out as never);
    const head = { role: "system", content: forced, ...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}), timestamp: current?.timestamp ?? Date.now() };
    out = [head, ...out.filter((m) => m.role !== "system")];
  }
  return normalizeContext({ messages: convertToLlm(out as never) } as never) as never;
}

async function warmContext(captured: Msg[], hidden: string[]): Promise<{ messages: Msg[] }> {
  let seen: unknown;
  await replayWarm({ id: "m" }, captured, new AbortController().signal, {
    convertToLlm: (m) => convertToLlm(m as never) as unknown[],
    hidden: () => hidden,
    thinkingLevel: () => "off",
    sessionId: () => "sess",
    cacheRetention: () => "short",
    streamSimple: (_m, context) => {
      seen = context;
      return { result: async () => ({ usage: {}, stopReason: "length" }) };
    },
  });
  return normalizeContext(seen as never) as never;
}

const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === "object") for (const x of Object.values(v)) deepFreeze(x);
  return Object.freeze(v);
};

const sections = { preamble: "Preamble.", rules: "Rules.", cwd: "cwd: /x", "pi-foreman": "Foreman block.", mcp_servers: "Servers." };
const head: Msg = { role: "system", content: "", sections, toolsAdded: [tool("alpha"), tool("secret")], timestamp: 1 };
const user: Msg = { role: "user", content: "hello", timestamp: 2 };
const patch: Msg = { role: "system", content: "", sections: { "pi-foreman": "Foreman block, later." }, toolsAdded: [tool("beta")], toolsRemoved: [tool("alpha")], timestamp: 3 };
const render = (messages: Msg[]): string => getSystemMessageText(getCurrentSystemMessage(messages as never) as never);
// what a memory extension returns: the prompt it saw (before the MCP handler added its section) plus its block
const withoutServers = { ...sections } as Record<string, string>;
delete withoutServers.mcp_servers;
const forcedText = (messages: Msg[]): string => `${getSystemMessageText({ role: "system", content: "", sections: withoutServers, timestamp: 0 } as never)}\n\n## Memory\n${"m".repeat(200)}\n${messages.length}`;

const cases: { name: string; messages: Msg[]; hidden: string[]; forced: boolean }[] = [
  { name: "no forced prompt, sections head with a hidden tool", messages: [head, user], hidden: ["secret"], forced: false },
  { name: "no forced prompt, head plus a later system patch", messages: [head, user, patch, { role: "user", content: "again", timestamp: 4 }], hidden: ["secret"], forced: false },
  { name: "a forced prompt, sections head with a hidden tool", messages: [head, user], hidden: ["secret"], forced: true },
  { name: "a forced prompt, head plus a later system patch", messages: [head, user, patch, { role: "user", content: "again", timestamp: 4 }], hidden: ["secret"], forced: true },
];

for (const c of cases) {
  test(`warm forced prompt: ${c.name}: the bridge resolves the warm's system text like the real turn's`, async () => {
    const messages = deepFreeze(structuredClone(c.messages));
    const before = structuredClone(messages);
    const live = c.forced ? forcedText(messages) : render(messages); // ctx.getSystemPrompt() at the hook
    const bridge = new FakeCapture();
    bridge.record(live); // turn_start
    const real = realTurn(messages, c.hidden, c.forced ? live : undefined);
    const realText = bridgeSystemText(real.messages);
    assert.equal(bridge.resolve(realText), "exact", "the real turn resolves");
    const captured = forcedProjection(messages, live) as Msg[];
    const warm = await warmContext(captured, c.hidden);
    assert.equal(bridgeSystemText(warm.messages), realText, "the system text is byte-equal");
    assert.equal(bridge.resolve(bridgeSystemText(warm.messages)), "exact", "the warm resolves");
    assert.deepEqual(warm, real, "the whole context is the real turn's");
    assert.deepEqual(messages, before, "the captured messages are unchanged");
  });
}

test("warm forced prompt: without the projection the forced prompt's warm is refused (the defect)", async () => {
  const messages = [head, user];
  const live = forcedText(messages);
  const bridge = new FakeCapture();
  bridge.record(live);
  const warm = await warmContext(messages, ["secret"]);
  assert.throws(() => bridge.resolve(bridgeSystemText(warm.messages)), /no capture for this/);
});

test("forcedProjection: no live prompt, no system message, or the same sections in another order return the messages themselves", () => {
  const messages = [head, user];
  assert.equal(forcedProjection(messages, undefined), messages);
  assert.equal(forcedProjection(messages, ""), messages);
  const bare = [user];
  assert.equal(forcedProjection(bare, "x"), bare);
  const reordered = Object.values(sections).reverse().join("\n\n");
  assert.equal(forcedProjection(messages, reordered), messages);
});
