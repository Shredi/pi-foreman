// Prompt cache, catch-all for the idle warm (docs/cache.md "Stable prefix", "Idle warm"): after every stage of one scripted session the
// warm the whole adapter sends while idle equals the last real request in everything a provider keys its cache on: model, system text and
// blocks, tool list (names, order, schemas), every message, and the request options (session id, reasoning, cache retention, headers).
// The hooks are discovered, never named: every handler the adapter registers for an event that can change a request is run the way Pi
// runs it, so a new hook that rewrites the real request but not the warm (or the capture) fails this file without a new case. A guard
// derives the request-changing events from Pi's extension types and fails for a registered one that the script does not drive.
// The real request is Pi's pipeline after the hooks (hidden projection, forced-prompt projection, convertToLlm, normalizeContext), as in
// warm-forced.test.ts; the warm is whatever reaches `modelRegistry.streamSimple`.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage, getCurrentTools, getSystemMessageText, normalizeContext } from "@earendil-works/pi-ai";
import { r11Rig } from "./_r11rig.ts";

type Msg = { role: string } & Record<string, unknown>;
type Json = Record<string, unknown>;
type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Call = { model: { provider: string; id: string }; context: { messages: Msg[] }; options: Json };
type Request = Call & { headers: Json };

/** Events whose handlers the script drives: the whole discovered list of each runs in the session. */
const DRIVEN = new Set(["input", "before_agent_start", "context", "context_with_system", "before_provider_request", "before_provider_headers", "message_end", "tool_call", "tool_result", "session_before_compact", "turn_end", "agent_before_settle", "cache_warming_decision"]);
/** Request-changing events the script does not drive, each with the reason it cannot change the cached prefix. */
const NOT_DRIVEN: Record<string, string> = {
  session_before_tree: "branch navigation only supplies a summary for the abandoned branch; the script has no tree navigation",
};
/**
 * Request options that legitimately differ for a warm; every other option, the headers, the model and the messages must be equal.
 * Pi's `buildRequestOptions` (sdk.js, a closure inside createAgentSession: not importable) adds timeoutMs, websocketConnectTimeoutMs, maxRetries,
 * maxRetryDelayMs, identity and transformHeaders to the agent loop's options (sessionId, reasoning, cacheRetention, transport, thinkingBudgets).
 * The real request below carries each of them; the warm sends none of them but maxRetries. Assumption (not provable offline): none of these
 * enters a provider's cache key; they are transport, timing and telemetry settings. A new option on either side fails the key check in warmEquals.
 */
const ALLOWED_DIFF: Record<string, string> = {
  maxTokens: "the warm caps the output at one token; a real turn leaves the cap to the model",
  maxRetries: "a warm never retries (0); a real turn keeps Pi's retry policy",
  signal: "each warm owns an AbortController that the next real request aborts",
  timeoutMs: "Pi's idle timeout of the HTTP stream; timing, not part of the request body",
  websocketConnectTimeoutMs: "Pi's websocket connect timeout; timing",
  maxRetryDelayMs: "Pi's retry back-off cap; the warm never retries",
  transport: "Pi's transport setting (sse or websocket); it selects the wire, not the cached prefix",
  thinkingBudgets: "per-level token budgets of Pi's settings; the warm only replays a model whose reasoning level maps to an effort (replayable in warmreplay.ts)",
  identity: "Pi's client identity (telemetry headers); not part of the cached prefix",
  transformHeaders: "Pi's before_provider_headers runner; the real request's resulting headers are compared (the adapter's hook adds none for a warm)",
};
/** Options both sides must carry equal. */
const COMPARED_OPTIONS = ["sessionId", "reasoning", "cacheRetention"];
/** What Pi's buildRequestOptions adds to a real request (sample values). */
const PI_ADDED = { timeoutMs: 300_000, websocketConnectTimeoutMs: 30_000, maxRetries: 3, maxRetryDelayMs: 60_000, transport: "sse", thinkingBudgets: undefined, identity: { name: "pi" }, transformHeaders: async (h: Json) => h };

const piTypes = path.join(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "core", "extensions", "types.d.ts");
/** Events of `ExtensionAPI.on` whose handler can return a result, plus the one that mutates the headers in place. */
function requestChangingEvents(): string[] {
  const out: string[] = [];
  for (const m of fs.readFileSync(piTypes, "utf8").matchAll(/on\(event: "([a-z_]+)", handler: ExtensionHandler<[^,>]+(, [^>]+)?>\)/g)) if (m[2] || m[1] === "before_provider_headers") out.push(m[1]);
  return out;
}

const THINKING = "high"; // the rig's pi.getThinkingLevel()
const TTL_S = 3600;
const WARM_AFTER_MS = 55 * 60_000; // past the first warm tick (0.9 of the TTL) and the settle check
const ROLES = Object.fromEntries(["explorer", "planner", "builder", "reviewer", "senior-reviewer", "finalizer"].map((r) => [r, { model: `pa/${r}-m` }]));
const config = {
  providers: { pa: { roles: { ...ROLES, foreman: { model: "pa/big" } }, cache: { ttlSeconds: TTL_S, billing: "token", keepalive: { enabled: true, compactMinTokens: 0 }, warmCompact: false } } },
  roles: { foreman: { codemode: false } },
  tools: { deferred: ["secret_*"] },
  ceremony: { default: "standard", launchWait: "detach", heavySignals: ["ci"] },
};
const TOOLS = ["read", "bash", "tool_search", "subagent", "ask_user_question", "bg_run", "secret_a", "secret_b"];
const decl = (name: string) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: { q: { type: "string" } } } });
const BASE = { preamble: "Preamble.", rules: "Rules.", cwd: "cwd: /project" };

const notice = (runId: string, toolCallId: string): Msg => ({
  role: "custom",
  customType: "subagent_control_notice",
  content: `Subagent needs attention: builder ${runId}`,
  display: true,
  details: { event: { type: "needs_attention", reason: "tool_open_threshold", runId, toolCallId, currentTool: "bash" } },
});
/** Calls of the three Pi functions that change the next request without an event result, with the event being driven when they happened. */
const piCalls: { fn: string; during: string }[] = [];
let during = "script";
/** Events the script fires through the rig's `fire`. */
const SCRIPT_FIRED = new Set(["agent_start", "agent_end", "agent_settled", "session_compact", "session_start"]);
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res));
};

test("the idle warm equals the last real request after every stage of a scripted session, through every request-changing hook of the adapter", async (t) => {
  // ---- Pi's side: session, system options, tools, the registry the warm sends through ----------------------------------------
  const session: Msg[] = [];
  type Options = { sections: Record<string, string>; forceSystemPrompt: string | undefined };
  let options: Options = { sections: { ...BASE }, forceSystemPrompt: undefined };
  const renderSystem = () => options.forceSystemPrompt ?? Object.values(options.sections).join("\n\n");
  let known: Record<string, string> | null = null; // the sections the stored system messages carry
  let active = [...TOOLS];
  const registered = new Map<string, { prepareLoadout?: (l: { declared: { name: string }[] }) => { hiddenDeclarations?: string[] } | undefined; execute(id: string, p: Json): Promise<unknown> }>();
  const streamCalls: Call[] = [];
  let idle = true;
  let calls = 0;
  const foreign = { forcing: false };
  // a second extension (a memory extension): it forces the prompt it saw plus its block; Pi runs its handler after the adapter's
  const foreignHandlers: Record<string, Handler[]> = {
    before_agent_start: [async (event) => (foreign.forcing ? { systemPrompt: `${(event as { systemPrompt: string }).systemPrompt}\n\n## Memory\n${"m".repeat(200)}` } : undefined)],
  };
  const registry = {
    find: (provider: string, id: string) => ({ provider, id, api: "openai-responses", contextWindow: 200_000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 } }),
    getProviderAuthStatus: () => ({ configured: true }),
    streamSimple: (model: Call["model"], context: Call["context"], opts: Json) => {
      streamCalls.push({ model, context: structuredClone(context), options: { ...opts } });
      return { result: async () => ({ stopReason: "length", provider: "pa", model: "big", usage: { input: 5, output: 1, cacheRead: 100_000, cacheWrite: 0, cost: { total: 0.01 } } }) };
    },
  };
  const r = await r11Rig(t, {}, {
    config,
    ctx: {
      model: { provider: "pa", id: "big", api: "openai-responses", contextWindow: 200_000 },
      modelRegistry: registry,
      isIdle: () => idle,
      hasPendingMessages: () => false,
      getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000 }),
      getSystemPrompt: renderSystem,
    },
    piExtra: {
      registerTool: (d: { name: string } & (typeof registered extends Map<string, infer V> ? V : never)) => void registered.set(d.name, d),
      getActiveTools: () => [...active],
      getAllTools: () => TOOLS.map((name) => ({ ...decl(name), exposure: "direct" })),
      setActiveTools: (n: string[]) => (piCalls.push({ fn: "setActiveTools", during }), void (active = [...n])),
      setThinkingLevel: () => void piCalls.push({ fn: "setThinkingLevel", during }),
      setModel: async () => (piCalls.push({ fn: "setModel", during }), true),
      appendEntry: () => undefined,
    },
  });
  const handlers = (name: string): Handler[] => [...r.handlersOf(name), ...(foreignHandlers[name] ?? [])];
  const ran = new Set<string>(); // driven events that had a handler and ran it
  let rewrites = 0; // times the adapter's context_with_system hook returned changed messages (the restore and align paths)
  const each = async (name: string, event: Json, apply: (res: Json) => void = () => undefined): Promise<void> => {
    for (const h of handlers(name)) {
      ran.add(name);
      const res = (await h({ type: name, ...event }, r.ctx)) as Json | undefined;
      if (res !== undefined && res !== null) apply(res);
    }
  };

  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  t.after(() => t.mock.timers.reset());

  // ---- the session, as Pi runs it ------------------------------------------------------------------------------------------
  const say = async (msg: Msg) => {
    let m = msg;
    await each("message_end", { message: m }, (res) => void (res.message && (m = res.message as Msg)));
    session.push(m);
  };
  const usage = { input: 100_000, output: 10, cacheRead: 0, cacheWrite: 0 };
  const assistant = (content: unknown[], stopReason = "stop"): Msg => ({ role: "assistant", provider: "pa", model: "big", content, stopReason, usage });
  const reply = (text: string) => say(assistant([{ type: "text", text }]));

  // a prompt: input handlers, before_agent_start (its messages follow the user message), then the append; sections are stored as patches
  const prompt = async (text: string, early?: [string, string]) => {
    await r.fire("agent_start", {});
    let input = text;
    for (const h of handlers("input")) {
      ran.add("input");
      const res = (await h({ type: "input", source: "interactive", text: input }, r.ctx)) as { action?: string; text?: string } | undefined;
      assert.notEqual(res?.action, "handled", `prompt "${text}" is not handled by an input hook`);
      if (res?.action === "transform" && res.text) input = res.text;
    }
    const extra: Msg[] = [];
    const run: Options = { sections: { ...BASE }, forceSystemPrompt: undefined };
    options = run;
    await each("before_agent_start", { prompt: input, get systemPrompt() { return renderSystem(); }, systemPromptOptions: run }, (res) => {
      const m = res.message as { customType: string; content: string; display?: boolean } | undefined;
      if (m) extra.push({ role: "custom", customType: m.customType, content: m.content, display: m.display ?? true });
      if (typeof res.systemPrompt === "string") run.forceSystemPrompt = res.systemPrompt;
    });
    if (early) {
      // a section Pi's fresh build places before the adapter's (so a later patch, which appends, renders it in another place)
      const rest = Object.entries(run.sections).filter(([k]) => !(k in BASE));
      run.sections = { ...BASE, [early[0]]: early[1], ...Object.fromEntries(rest) };
    }
    if (known === null) {
      session.push({ role: "system", content: "", sections: { ...run.sections }, toolsAdded: active.map(decl), timestamp: 1 });
      known = { ...run.sections };
    } else {
      const patch: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(run.sections)) if (known[k] !== v) patch[k] = v;
      for (const k of Object.keys(known)) if (!(k in run.sections)) patch[k] = null;
      if (Object.keys(patch).length > 0) session.push({ role: "system", content: "", sections: patch, timestamp: 1 });
      known = { ...run.sections };
    }
    await say({ role: "user", content: [{ type: "text", text: input }], timestamp: 1 });
    for (const m of extra) await say(m);
  };

  const toolCall = async (name: string, input: Json) => {
    const id = `call-${++calls}`;
    await say(assistant([{ type: "toolCall", id, name, arguments: structuredClone(input) }], "toolUse"));
    await each("tool_call", { toolName: name, toolCallId: id, input }, (res) => assert.notEqual(res.block, true, `the ${name} call is not blocked`));
    return id;
  };
  const toolResult = async (id: string, name: string, input: Json, text: string) => {
    let content: unknown = [{ type: "text", text }];
    let details: unknown = {};
    await each("tool_result", { toolName: name, toolCallId: id, input, details, content, isError: false }, (res) => {
      if (res.content) content = res.content;
      if (res.details) details = res.details;
    });
    await say({ role: "toolResult", toolCallId: id, toolName: name, content, details, isError: false, timestamp: 1 });
  };

  // ---- one real request, as Pi sends it ------------------------------------------------------------------------------------
  const hiddenNow = (): string[] => registered.get("tool_search")?.prepareLoadout?.({ declared: active.map((name) => ({ name })) })?.hiddenDeclarations ?? [];
  const retention = (v: unknown) => v ?? (process.env.PI_CACHE_RETENTION === "long" ? "long" : "short"); // pi-ai's default when the option is absent
  let lastReal: Request | undefined;
  const real = async (): Promise<Request> => {
    let messages = structuredClone(session);
    for (const h of handlers("context")) {
      ran.add("context");
      const res = (await h({ type: "context", messages }, r.ctx)) as { messages?: Msg[] } | undefined;
      if (res?.messages) messages = res.messages;
    }
    for (const h of handlers("context_with_system")) {
      ran.add("context_with_system");
      const res = (await h({ type: "context_with_system", messages }, r.ctx)) as { messages?: Msg[] } | undefined;
      if (res?.messages) {
        messages = res.messages;
        rewrites += 1;
      }
    }
    // Pi's projections after the handlers: hidden declarations leave the system messages, a forced prompt becomes the one head
    const hide = new Set(hiddenNow());
    messages = messages.map((m) => {
      if (m.role !== "system" || (!m.toolsAdded && !m.toolsRemoved)) return m;
      const { toolsAdded, toolsRemoved, ...rest } = m as { toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] } & Msg;
      const added = toolsAdded?.filter((x) => !hide.has(x.name)) ?? [];
      const removed = toolsRemoved?.filter((x) => !hide.has(x.name)) ?? [];
      return { ...rest, ...(added.length > 0 ? { toolsAdded: added } : {}), ...(removed.length > 0 ? { toolsRemoved: removed } : {}) };
    });
    if (options.forceSystemPrompt !== undefined) {
      const current = getCurrentSystemMessage(messages as never);
      messages = [{ role: "system", content: options.forceSystemPrompt, ...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}), timestamp: current?.timestamp ?? Date.now() }, ...messages.filter((m) => m.role !== "system")];
    }
    let req: { model: Call["model"]; context: unknown; options: Json } = {
      model: r.ctx.model as Call["model"],
      context: normalizeContext({ messages: convertToLlm(messages as never) } as never),
      options: { sessionId: r.sessionId, reasoning: THINKING, cacheRetention: retention(undefined), ...PI_ADDED },
    };
    // the provider hooks rewrite the real request only (the warm never passes them): the payload and the headers
    await each("before_provider_request", { payload: req }, (res) => void (req = res as never));
    const headers: Json = {};
    for (const h of handlers("before_provider_headers")) {
      ran.add("before_provider_headers");
      await h({ type: "before_provider_headers", headers }, r.ctx);
    }
    return (lastReal = { ...req, headers } as Request);
  };

  // ---- a run's end, the idle warm and the comparison -----------------------------------------------------------------------
  const view = (q: Request) => {
    const o = { ...q.options, cacheRetention: retention(q.options.cacheRetention) };
    for (const k of Object.keys(ALLOWED_DIFF)) delete o[k];
    const messages = normalizeContext(q.context as never).messages as Msg[];
    const head = getCurrentSystemMessage(messages as never);
    const { model: _m, context: _c, options: _o, headers: _h, ...rest } = q; // any other field a payload hook added
    return { rest, model: q.model, system: head ? getSystemMessageText(head as never) : undefined, systemBlocks: head?.content, tools: getCurrentTools(messages as never), messages, options: o, headers: q.headers };
  };
  let stages = 0;
  /** The run ends: the settle hooks, then idle time until the warm goes out; it must equal the last real request. */
  const warmEquals = async (label: string) => {
    assert.ok(lastReal, `stage "${label}": a real request went out`);
    const before = streamCalls.length;
    await each("turn_end", { message: session.at(-1), toolResults: [] }, (res) => assert.equal(res.entries, undefined, `stage "${label}": a turn_end handler appends session entries; model them in the script`));
    await each("agent_before_settle", {}, (res) => assert.equal(res.entries, undefined, `stage "${label}": an agent_before_settle handler appends session entries; model them in the script`));
    await r.fire("agent_end", { messages: [] });
    await r.fire("agent_settled", {});
    t.mock.timers.tick(WARM_AFTER_MS);
    await flush();
    assert.equal(streamCalls.length, before + 1, `stage "${label}": one idle warm went out; keepalive trace: ${JSON.stringify(r.events("keepalive"))}`);
    const warm = streamCalls[streamCalls.length - 1];
    const w = view({ ...warm, headers: {} });
    const q = view(lastReal);
    for (const key of Object.keys(q) as (keyof typeof q)[]) assert.deepStrictEqual(w[key], q[key], `stage "${label}": the warm's ${key} differs from the last real request's`);
    assert.deepStrictEqual(Object.keys(w).sort(), Object.keys(q).sort(), `stage "${label}": the compared fields`);
    for (const side of [lastReal.options, warm.options]) for (const k of Object.keys(side)) assert.ok(COMPARED_OPTIONS.includes(k) || k in ALLOWED_DIFF, `stage "${label}": the option ${k} is neither compared nor allowed to differ; add it to COMPARED_OPTIONS or ALLOWED_DIFF with its reason`);
    stages += 1;
    return q;
  };
  const textOf = (q: ReturnType<typeof view>) => JSON.stringify(q.messages);
  const toolNames = (q: ReturnType<typeof view>) => q.tools.map((x) => x.name);

  // ---- the script ----------------------------------------------------------------------------------------------------------
  // 1. the first prompt: sections head, deferred hint, hidden tools
  await prompt("build the feature");
  await real();
  await reply("starting");
  let q = await warmEquals("first prompt");
  assert.ok(!toolNames(q).includes("secret_a") && toolNames(q).includes("read"), `the deferred tools are hidden from the request: ${toolNames(q)}`);
  assert.match(q.system ?? "", /Deferred tools/, "the deferred hint rides in the system text");

  // 2. a second extension forces the system prompt
  foreign.forcing = true;
  await prompt("tidy the readme");
  await real();
  await reply("done");
  q = await warmEquals("forced system prompt");
  assert.match(q.system ?? "", /## Memory/, "the forced prompt is what the request carries");

  // 3. a hidden tool is found and declared from the next request
  await prompt("use the secret tool");
  await real();
  const search = await toolCall("tool_search", { query: "secret_a tool" });
  await registered.get("tool_search")!.execute(search, { query: "secret_a tool" });
  await toolResult(search, "tool_search", { query: "secret_a tool" }, "found secret_a; declared from the next request");
  await real();
  await reply("found it");
  q = await warmEquals("hidden tool found");
  assert.ok(toolNames(q).includes("secret_a") && !toolNames(q).includes("secret_b"), `the found tool is declared, the other stays hidden: ${toolNames(q)}`);

  // 4. a subagent notice
  await say(notice("run-1", "tc1"));
  await prompt("what is running?");
  await real();
  await reply("waiting");
  q = await warmEquals("notice");
  assert.match(textOf(q), /Subagent needs attention/, "the notice is in the request");

  // 5. an ask: the warm goes out while the question is open, then the answer
  await prompt("which file?");
  await real();
  const questions = { questions: [{ question: "Which file?", options: [{ label: "a" }, { label: "b" }] }] };
  const ask = await toolCall("ask_user_question", questions);
  idle = false; // the turn waits on the owner
  q = await warmEquals("ask pending");
  assert.match(textOf(q), /which file\?/, "the request before the question is the one replayed");
  idle = true;
  await toolResult(ask, "ask_user_question", questions, "User answered: a");
  await real();
  await reply("using a");
  q = await warmEquals("ask answered");
  assert.match(textOf(q), /User answered: a/, "the answer is in the request");

  // 6. a background task and its notification
  await prompt("run the tests");
  await real();
  const bg = await toolCall("bg_run", { command: "npm test" });
  await toolResult(bg, "bg_run", { command: "npm test" }, "started background task bg-1");
  await say({ role: "custom", customType: "bg-task-notify", content: "Background task bg-1 finished: exit 0", display: false, timestamp: 1 });
  await real();
  await reply("bg-1 passed");
  q = await warmEquals("background task");
  assert.match(textOf(q), /Background task bg-1 finished/, "the notification is in the request");

  // 7. a compaction: the stored head loses the sections the adapter adds; the next prompt puts them back
  await each("session_before_compact", { preparation: { tokensBefore: 100_000 }, branchEntries: [], signal: new AbortController().signal }, (res) => assert.notEqual(res.cancel, true, "the compaction is not cancelled"));
  session.splice(0, session.length, { role: "system", content: "", sections: { ...BASE }, toolsAdded: active.map(decl), timestamp: 1 }, { role: "compactionSummary", summary: "Summary of the earlier work.", tokensBefore: 100_000, timestamp: 1 });
  known = { ...BASE };
  await r.fire("session_compact", { compactionEntry: { summary: "Summary of the earlier work." }, reason: "manual" });
  foreign.forcing = false;
  await prompt("carry on");
  await real();
  await reply("carrying on");
  q = await warmEquals("compaction");
  assert.match(textOf(q), /Summary of the earlier work/, "the summary is in the request");
  assert.match(q.system ?? "", /Deferred tools/, "the sections the compaction dropped are back");

  // 7b. a compaction in the middle of a run, no new prompt: the stored head lost the adapter's sections and nothing patches them back,
  // so the context_with_system hook puts them back (keepSection) for the request and the warm alike
  let before = rewrites;
  await each("session_before_compact", { preparation: { tokensBefore: 100_000 }, branchEntries: [], signal: new AbortController().signal });
  const kept = session.filter((m) => m.role !== "system" && m.role !== "compactionSummary").slice(-2);
  session.splice(0, session.length, { role: "system", content: "", sections: { ...BASE }, toolsAdded: active.map(decl), timestamp: 1 }, { role: "compactionSummary", summary: "Second summary.", tokensBefore: 100_000, timestamp: 1 }, ...kept);
  known = { ...BASE };
  await r.fire("session_compact", { compactionEntry: { summary: "Second summary." }, reason: "threshold" });
  await real();
  await reply("going on after the compaction");
  q = await warmEquals("compaction mid-run");
  assert.ok(rewrites > before, "the compaction stage made the hook rewrite the messages");
  assert.match(q.system ?? "", /Foreman rules/, "the foreman section is back in the request");
  assert.match(q.system ?? "", /Deferred tools/, "the deferred hint is back in the request");
  assert.equal(q.system, renderSystem(), "the request's head is the live prompt");

  // 7c. a `pi-foreman: null` patch in the middle of a run (a run Pi started without before_agent_start): the request keeps the section
  before = rewrites;
  session.push({ role: "system", content: "", sections: { "pi-foreman": null }, timestamp: 1 });
  await real();
  await reply("after the null patch");
  q = await warmEquals("null patch");
  assert.ok(rewrites > before, "the null patch made the hook rewrite the messages");
  assert.match(q.system ?? "", /Foreman rules/, "the foreman section survives the null patch");
  assert.equal(q.system, renderSystem(), "the request's head is the live prompt");

  // 7d. a section that first appears mid-session: Pi's replay renders it last, the fresh build in the middle; the hook aligns the order
  before = rewrites;
  await prompt("note something", ["memo", "## Memo\nremember this"]);
  await real();
  await reply("noted");
  q = await warmEquals("new section mid-session");
  assert.ok(rewrites > before, "the late section made the hook rewrite the messages");
  assert.match(q.system ?? "", /## Memo/, "the late section is in the request");
  assert.equal(q.system, renderSystem(), "the request's head renders in the live prompt's order");

  // 8. a forced prompt again after the compaction, then the last turn
  foreign.forcing = true;
  await prompt("one more thing");
  await real();
  await reply("done");
  await warmEquals("forced after compaction");

  assert.equal(stages, streamCalls.length, "every stage sent exactly one warm");
  assert.equal(stages, 12);
  assert.ok(rewrites >= 3, "the context_with_system hook rewrote the messages in the restore and the align stages");

  // ---- guard: every request-changing event the adapter registers is driven by this script ---------------------------------
  // Pi's own refresh is stopped: the adapter's warm is the only one (otherwise a second warm with other options goes out)
  const decisions: unknown[] = [];
  for (const h of r.handlersOf("cache_warming_decision")) decisions.push(await h({ type: "cache_warming_decision", phase: "idle" }, r.ctx));
  ran.add("cache_warming_decision");
  assert.ok(decisions.some((d) => (d as { action?: string } | undefined)?.action === "stop"), "the adapter stops Pi's own cache warming");
  const events = requestChangingEvents();
  assert.ok(events.includes("context") && events.includes("before_agent_start") && events.includes("context_with_system"), `the request-changing events are read from ${piTypes}: ${events}`);
  const withHandlers = events.filter((e) => handlers(e).length > 0);
  assert.deepEqual(withHandlers.filter((e) => !DRIVEN.has(e) && !(e in NOT_DRIVEN)), [], "the adapter registers a handler for a request-changing event this script neither drives nor justifies; drive it in the script or add it to NOT_DRIVEN with its reason");
  assert.deepEqual([...DRIVEN].filter((e) => !events.includes(e)), [], "DRIVEN names an event Pi's types no longer have as request-changing");
  assert.deepEqual(Object.keys(NOT_DRIVEN).filter((e) => !events.includes(e)), [], "NOT_DRIVEN names an event Pi's types no longer have as request-changing");
  assert.deepEqual(withHandlers.filter((e) => DRIVEN.has(e) && !ran.has(e)), [], "a driven event has handlers the script never ran");

  // ---- guard: a handler that returns nothing but calls setActiveTools, setThinkingLevel or setModel also changes the next request ----
  // Every other event the adapter registers is fired once with a bare `{ type }` payload; a call from one of them fails. Gap: a handler
  // that returns early on the missing payload escapes this probe, and the script's own events are covered by the stages above.
  const everyEvent = [...fs.readFileSync(piTypes, "utf8").matchAll(/on\(event: "([a-z_]+)", handler:/g)].map((m) => m[1]);
  const undriven = everyEvent.filter((e) => handlers(e).length > 0 && !ran.has(e) && !SCRIPT_FIRED.has(e)).sort((a, b) => Number(a === "session_shutdown") - Number(b === "session_shutdown"));
  assert.ok(undriven.includes("turn_start") && undriven.includes("model_select"), `the probe reaches the events the script does not drive: ${undriven}`);
  for (const name of undriven) {
    during = name;
    for (const h of handlers(name)) await Promise.resolve(h({ type: name }, r.ctx)).catch(() => undefined);
  }
  during = "script";
  assert.deepEqual(piCalls.filter((c) => undriven.includes(c.during)), [], "the adapter calls setActiveTools, setThinkingLevel or setModel from an event the script does not drive; drive that event in the script and compare the next request");
});
