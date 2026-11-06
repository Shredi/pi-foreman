// Prompt cache, catch-all: every `context` and `before_agent_start` handler the whole adapter registers keeps the sent prefix
// byte-identical (docs/cache.md "Stable prefix"). The handlers are collected from the rig, never picked by name, so a new hook is
// covered without editing this file. They run the way Pi's request loop runs them: `context` handlers chain on the visible list,
// `before_agent_start` handlers share one system options object and their messages follow the prompt in the session.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { writeOpenCommand } from "../opencommand.ts";
import { r11Rig } from "./_r11rig.ts";

type Msg = { role: string } & Record<string, unknown>;

const notice = (runId: string, toolCallId: string) => ({
  role: "custom",
  customType: "subagent_control_notice",
  content: `Subagent needs attention: builder ${runId}`,
  display: true,
  details: { event: { type: "needs_attention", reason: "tool_open_threshold", runId, toolCallId, currentTool: "bash" } },
});
const finished = (runId: string) => ({
  role: "custom",
  customType: "subagent-notify",
  content: `Background task completed: **builder**\n\nbuilder:\nreport\n\nRetention-managed async directory: /tmp/pi-subagents-uid-1/async-subagent-runs/${runId}\n\nSession file: /x/s.jsonl`,
  display: false,
});

test("every context and before_agent_start handler leaves the sent prefix byte-identical across a scripted session", async (t) => {
  const r = await r11Rig(t, { default: "standard" }, { config: { ceremony: { default: "standard", launchWait: "detach", heavySignals: ["ci"] } } });
  assert.ok(r.handlersOf("context").length > 0 && r.handlersOf("before_agent_start").length > 0, "the adapter registers both hooks");

  // Pi's session: append-only. The model sees the request's `context` result of it, never the stored list.
  const session: Msg[] = [];
  // Pi keeps one system prompt options object for the session; before_agent_start handlers edit its sections in place.
  const options = { sections: {} as Record<string, string>, forceSystemPrompt: undefined as string | undefined };
  const renderSystem = () => options.forceSystemPrompt ?? Object.entries(options.sections).map(([k, v]) => `<${k}>\n${v}\n</${k}>`).join("\n");
  let sent: { label: string; visible: Msg[]; system: string } | undefined;
  let calls = 0;

  const say = async (msg: Msg) => {
    session.push(msg);
    await r.fire("message_end", { message: msg });
  };
  const reply = (text: string) => say({ role: "assistant", content: [{ type: "text", text }] });

  // A prompt as Pi runs it: input handlers, then before_agent_start (its messages come after the user message), then the append.
  const startPrompt = async (text: string) => {
    assert.deepEqual(await r.inputRun("interactive", text), { action: "continue" }, `prompt "${text}" is not handled by an input hook`);
    const extra: Msg[] = [];
    for (const h of r.handlersOf("before_agent_start")) {
      const event = { prompt: text, type: "before_agent_start", get systemPrompt() { return renderSystem(); }, systemPromptOptions: options };
      const res = (await h(event, r.ctx)) as { message?: { customType: string; content: string; display?: boolean }; systemPrompt?: string } | undefined;
      if (res?.message) extra.push({ role: "custom", customType: res.message.customType, content: res.message.content, display: res.message.display ?? true });
      if (res?.systemPrompt !== undefined) options.forceSystemPrompt = res.systemPrompt;
    }
    await say({ role: "user", content: [{ type: "text", text }] });
    for (const m of extra) await say(m);
  };

  // A tool call as Pi runs it: the assistant's call, the tool_call and tool_result hooks, then the result. `events: false` is a result
  // that lands without its hooks (a fetched run result: only its messages matter here).
  const toolTurn = async (name: string, input: Record<string, unknown>, result: { text: string; details?: Record<string, unknown> }, events = true) => {
    const id = `call-${++calls}`;
    await say({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: structuredClone(input) }] });
    const block = events ? await r.fire("tool_call", { toolName: name, toolCallId: id, input }) : undefined;
    const content = [{ type: "text", text: result.text }];
    const details = result.details ?? {};
    if (events) await r.fire("tool_result", { toolName: name, toolCallId: id, input, details, content, isError: false });
    await say({ role: "toolResult", toolCallId: id, toolName: name, content, details, isError: false });
    return { id, block: block as { block?: boolean; reason?: string } | undefined };
  };

  // One model request: the `context` handlers in order on a copy of the session, then the byte check against the last request.
  const request = async (label: string) => {
    let visible = structuredClone(session);
    for (const h of r.handlersOf("context")) {
      const res = (await h({ type: "context", messages: visible }, r.ctx)) as { messages?: Msg[] } | undefined;
      if (res?.messages) visible = res.messages;
    }
    const system = renderSystem();
    if (sent) {
      for (let i = 0; i < sent.visible.length; i++) {
        assert.equal(JSON.stringify(visible[i]), JSON.stringify(sent.visible[i]), `step "${label}": sent message ${i} (${sent.visible[i].role}) changed since step "${sent.label}"`);
      }
      assert.equal(system, sent.system, `step "${label}": the system prompt changed since step "${sent.label}"`);
    }
    sent = { label, visible: structuredClone(visible), system };
  };

  // the first prompt and a child launch
  await startPrompt("build the feature");
  await request("first prompt");
  await reply("starting a builder");
  const input: Record<string, unknown> = { agent: "builder", task: "build" };
  const launch = await toolTurn("subagent", input, { text: "Async: builder [run-1]", details: { runId: "run-1" } });
  assert.equal(launch.block, undefined, "the child launch is not blocked");
  const dir = path.resolve(/(\S*pi-foreman-scratch\S*)/.exec(String(input.task))?.[1]?.replace(/[`'".,]+$/, "") ?? "");
  assert.notEqual(dir, path.resolve(""), `the launch names a scratch dir in its task: ${String(input.task)}`);
  await request("child launch");
  await reply("the builder runs");

  // an open-tool notice, then the same notice suppressed once its command is known to be a long test run
  await say(notice("run-1", "tc1"));
  await request("open-tool notice");
  await reply("waiting");
  writeOpenCommand(dir, { toolCallId: "tc1", command: "npm test", startedAt: Date.now() - 240_000 });
  await r.fire("message_end", { message: notice("run-1", "tc1") });
  await say(notice("run-1", "tc2"));
  await request("notice suppressed");
  await reply("still waiting");

  // the run ends, its result is fetched
  r.end({ runId: "run-1", agent: "builder", success: true, summary: "done", results: [{ agent: "builder" }] });
  await say(finished("run-1"));
  await request("run end");
  await toolTurn("subagent", { runId: "run-1" }, { text: "pi-foreman launch-wait: run run-1 (builder) ended completed after 3s. Result path: x.", details: { runId: "run-1" } }, false);
  await request("result fetched");
  await reply("reviewed");

  // a heavy-signal prompt (the triage hint rides as a message for this prompt), then a plain one
  await startPrompt("fix the ci pipeline");
  assert.ok(session.some((m) => m.customType === "foreman_triage_hint"), "the heavy-signal prompt sends its triage hint");
  await request("heavy-signal prompt");
  await reply("heavy only if the criteria apply");
  await startPrompt("tidy the readme");
  await request("plain prompt");
  await reply("done");

  // a question to the user, and a background task
  await toolTurn("ask_user_question", { questions: [{ question: "Which file?", options: [{ label: "a" }, { label: "b" }] }] }, { text: "User answered: a" });
  await request("ask_user_question");
  await reply("using a");
  await toolTurn("bg_run", { command: "npm test" }, { text: "started background task bg-1" });
  await say({ role: "custom", customType: "bg-task-notify", content: "Background task bg-1 finished: exit 0", display: false });
  await request("background task");
  await reply("bg-1 passed");

  // a second turn
  await startPrompt("thanks, one more thing");
  await request("second turn");
  await reply("done");
});
