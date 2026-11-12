// The warm replays the captured messages as a real turn would hand them to the provider: the same context (the leading
// system message with its sections stays in `messages`; no separate systemPrompt, no tools), hidden tool declarations
// projected out like Pi's projection does, and the captured array untouched. A fake provider records what it receives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { replayWarm } from "../warmreplay.ts";

type Rec = { context: unknown; options: Record<string, unknown> };
type Msg = Record<string, unknown>;
const tool = (name: string) => ({ name, description: `${name} description`, parameters: { type: "object", properties: {} } });

/** What the agent loop hands the provider for these captured messages: Pi's hidden projection, then convertToLlm; no systemPrompt, no tools. */
function realTurn(messages: Msg[], hidden: string[]): unknown {
  const hide = new Set(hidden);
  const projected =
    hide.size === 0
      ? messages
      : messages.map((m) => {
          if (m.role !== "system" || (!m.toolsAdded && !m.toolsRemoved)) return m;
          const { toolsAdded, toolsRemoved, ...rest } = m as { toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] } & Msg;
          const added = toolsAdded?.filter((t) => !hide.has(t.name)) ?? [];
          const removed = toolsRemoved?.filter((t) => !hide.has(t.name)) ?? [];
          return { ...rest, ...(added.length > 0 ? { toolsAdded: added } : {}), ...(removed.length > 0 ? { toolsRemoved: removed } : {}) };
        });
  return { messages: convertToLlm(projected as never) };
}

async function warm(messages: Msg[], hidden: string[]): Promise<Rec> {
  let seen: Rec | null = null;
  await replayWarm({ id: "m" }, messages, new AbortController().signal, {
    convertToLlm: (m) => convertToLlm(m as never) as unknown[],
    hidden: () => hidden,
    thinkingLevel: () => "off",
    sessionId: () => "sess",
    cacheRetention: () => "short",
    streamSimple: (_m, context, options) => {
      seen = { context, options: options as Record<string, unknown> };
      return { result: async () => ({ usage: {}, stopReason: "length" }) };
    },
  });
  return seen!;
}

const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === "object") for (const x of Object.values(v)) deepFreeze(x);
  return Object.freeze(v);
};

const cases: { name: string; messages: Msg[]; hidden: string[] }[] = [
  {
    name: "a sections-only head",
    messages: [{ role: "system", content: "", sections: { base: "Base text.", extra: "Extra text." }, timestamp: 1 }, { role: "user", content: "hello", timestamp: 2 }],
    hidden: [],
  },
  {
    name: "a head plus a later system patch",
    messages: [
      { role: "system", content: "", sections: { base: "Base text." }, toolsAdded: [tool("alpha")], timestamp: 1 },
      { role: "user", content: "hello", timestamp: 2 },
      { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 3 },
      { role: "system", content: "", sections: { base: null, extra: "Patched." }, toolsAdded: [tool("beta")], toolsRemoved: [tool("alpha")], timestamp: 4 },
      { role: "user", content: "again", timestamp: 5 },
    ],
    hidden: [],
  },
  {
    name: "a hidden tool",
    messages: [
      { role: "system", content: "", sections: { base: "Base text." }, toolsAdded: [tool("alpha"), tool("secret")], timestamp: 1 },
      { role: "user", content: "hello", timestamp: 2 },
      { role: "system", content: "", toolsAdded: [tool("secret")], toolsRemoved: [tool("secret"), tool("alpha")], timestamp: 3 },
      { role: "user", content: "again", timestamp: 4 },
    ],
    hidden: ["secret"],
  },
];

for (const c of cases) {
  test(`warm parity: ${c.name}: the provider gets the real turn's context`, async () => {
    const messages = deepFreeze(structuredClone(c.messages));
    const before = structuredClone(messages);
    const got = await warm(messages, c.hidden);
    assert.deepEqual(got.context, realTurn(c.messages, c.hidden));
    assert.deepEqual(Object.keys(got.context as object), ["messages"], "no systemPrompt and no tools field");
    assert.deepEqual(messages, before, "the captured array and its messages are unchanged");
    assert.equal(got.options.sessionId, "sess");
    assert.equal(got.options.maxTokens, 1);
    assert.equal("reasoning" in got.options, false);
    assert.equal(got.options.cacheRetention, "short");
  });
}

test("warm parity: a hidden tool is gone from every patch and a patch left empty loses its keys", async () => {
  const got = await warm(cases[2].messages, ["secret"]);
  const sys = (got.context as { messages: Msg[] }).messages.filter((m) => m.role === "system");
  assert.deepEqual(sys[0].toolsAdded, [tool("alpha")]);
  assert.equal("toolsAdded" in sys[1], false);
  assert.deepEqual(sys[1].toolsRemoved, [tool("alpha")]);
  assert.equal(JSON.stringify(got.context).includes("secret"), false);
});

test("warm parity: nothing hidden passes the messages through unchanged", async () => {
  const messages = cases[1].messages;
  const got = await warm(messages, []);
  assert.deepEqual((got.context as { messages: unknown[] }).messages, convertToLlm(messages as never));
});
