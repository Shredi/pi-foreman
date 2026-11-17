// pi-subagents 0.89 wraps each of its custom messages in `<pi_subagents_notice>` on `context_with_system`. Pi runs the handlers in load order
// and the adapter loads first, so the capture the idle warm replays must carry the same wrap or the warm differs from the real request at the
// first notice. The real pi-subagents handler is loaded from the installed package and run after the adapter's, as Pi runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai";
import { SUBAGENT_NOTICE_TYPES, subagentNoticeWrap } from "../warmreplay.ts";
import { r11Rig } from "./_r11rig.ts";
import { SUBAGENTS_PKG as PKG, subagentsHandlers } from "./_subagents-handlers.ts";

type Msg = { role: string } & Record<string, unknown>;

const notice = (customType: string, content: unknown): Msg => ({ role: "custom", customType, content, display: true, timestamp: 3 });

test("the wrap list equals the types the installed pi-subagents wraps", async () => {
  const handlers = await subagentsHandlers();
  const probe = SUBAGENT_NOTICE_TYPES.map((t) => notice(t, "x"));
  const stranger = notice("foreman_wake", "x");
  const out = (await handlers.context_with_system![0]({ messages: [...probe, stranger] }, {}))!.messages!;
  assert.deepEqual(out.filter((m) => !String((m.content as string)).includes("pi_subagents_notice")).map((m) => m.customType), ["foreman_wake"], "every listed type is wrapped, a foreign type is not");
  // and every type the package shows in the chat is in the list
  const { SUBAGENT_MESSAGE_TYPES } = (await import(pathToFileURL(path.join(PKG, "src", "tui", "subagent-messages.js")).href)) as { SUBAGENT_MESSAGE_TYPES: string[] };
  for (const t of SUBAGENT_MESSAGE_TYPES) assert.ok(SUBAGENT_NOTICE_TYPES.includes(t), `${t} is wrapped by pi-subagents but missing from SUBAGENT_NOTICE_TYPES`);
});

test("subagentNoticeWrap equals the installed pi-subagents handler on string, block and view-only messages", async () => {
  const handlers = await subagentsHandlers();
  const messages: Msg[] = [
    { role: "user", content: "hi", timestamp: 1 },
    notice("subagent-notify", "done"),
    notice("subagent_control_notice", [{ type: "text", text: "blocks" }]),
    { ...notice("subagent-slash-text-result", "view only"), details: { viewOnly: true } },
    notice("subagent-slash-text-result", "shown"),
    notice("intercom_message", "foreign"),
  ];
  const real = (await handlers.context_with_system![0]({ messages }, {}))!.messages;
  assert.deepEqual(subagentNoticeWrap(messages), real);
});

test("the idle warm replays the request pi-subagents' wrap produced, for a branch with a notice", async (t) => {
  const handlers = await subagentsHandlers();
  const calls: { messages: Msg[] }[] = [];
  const registry = {
    find: (provider: string, id: string) => ({ provider, id, api: "openai-responses", contextWindow: 200_000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 } }),
    getProviderAuthStatus: () => ({ configured: true }),
    streamSimple: (_m: unknown, context: { messages: Msg[] }) => {
      calls.push(structuredClone(context));
      return { result: async () => ({ stopReason: "length", provider: "pa", model: "big", usage: { input: 5, output: 1, cacheRead: 100_000, cacheWrite: 0, cost: { total: 0.01 } } }) };
    },
  };
  const config = {
    providers: { pa: { roles: { foreman: { model: "pa/big" } }, cache: { ttlSeconds: 3600, billing: "token", keepalive: { enabled: true, compactMinTokens: 0 }, warmCompact: false } } },
    roles: { foreman: { codemode: false } },
  };
  const sections = { preamble: "Preamble.", rules: "Rules.", cwd: "cwd: /project" };
  const session: Msg[] = [
    { role: "system", content: "", sections, toolsAdded: [], timestamp: 1 },
    { role: "user", content: [{ type: "text", text: "build it" }], timestamp: 2 },
    notice("subagent-notify", "Background task completed: **builder**"),
    notice("subagent_control_notice", [{ type: "text", text: "needs attention" }]),
  ];
  const r = await r11Rig(t, {}, {
    config,
    ctx: {
      model: { provider: "pa", id: "big", api: "openai-responses", contextWindow: 200_000 },
      modelRegistry: registry,
      isIdle: () => true,
      hasPendingMessages: () => false,
      getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000 }),
      getSystemPrompt: () => Object.values(sections).join("\n\n"),
    },
    piExtra: { getAllTools: () => [], appendEntry: () => undefined },
  });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  t.after(() => t.mock.timers.reset());
  await r.fire("agent_start", {});
  await r.fire("before_agent_start", { prompt: "build it", systemPrompt: "", systemPromptOptions: { sections: { ...sections } } });
  // Pi's order: the adapter's handlers (loaded first), then pi-subagents'
  let messages: Msg[] = structuredClone(session);
  for (const h of [...r.handlersOf("context_with_system"), ...handlers.context_with_system!]) {
    const res = (await h({ type: "context_with_system", messages }, r.ctx)) as { messages?: Msg[] } | undefined;
    if (res?.messages) messages = res.messages;
  }
  assert.ok(messages.some((m) => typeof m.content === "string" && m.content.includes("<pi_subagents_notice")), "the real handler wrapped the notice");
  const sent = normalizeContext({ messages: convertToLlm(messages as never) } as never) as { messages: Msg[] };
  await r.fire("message_end", { message: { role: "assistant", provider: "pa", model: "big", content: [{ type: "text", text: "ok" }], stopReason: "stop", usage: { input: 100_000, output: 10, cacheRead: 0, cacheWrite: 0 } } });
  await r.fire("agent_end", { messages: [] });
  await r.fire("agent_settled", {});
  t.mock.timers.tick(55 * 60_000);
  for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res));
  assert.equal(calls.length, 1, `one idle warm went out; trace: ${JSON.stringify(r.trace().map((e) => [e.event, e.outcome, e.reason]))}`);
  // the system head is the catch-all's concern (warm-request-catchall.test.ts); here the conversation, notices included, must match
  const conversation = (ms: Msg[]): Msg[] => ms.filter((m) => m.role !== "system");
  const warm = conversation(normalizeContext(calls[0] as never).messages as Msg[]);
  assert.ok(JSON.stringify(warm).includes("pi_subagents_notice"), "the warm carries the wrapped notice");
  assert.deepEqual(warm, conversation(sent.messages), "the warm's messages equal the sent request's");
});
