// A question tool call holds an own Herdr blocked source from tool_call to tool_execution_end, independent of Pi's ui_prompt_* events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

type Sent = { active: boolean; label?: string };

async function rig(t: Parameters<typeof r11Rig>[0]) {
  const sent: Sent[] = [];
  const bus = {
    on: () => () => undefined,
    emit: (ch: string, d: unknown) => void (ch === "herdr:blocked" && sent.push(d as Sent)),
  };
  // the rig clears HERDR_ENV before it builds pi; the getter runs while pi is built, just before the adapter installs the shim
  const piExtra = {
    get events() {
      process.env.HERDR_ENV = "1";
      return bus;
    },
  };
  const r = await r11Rig(t, {}, { piExtra });
  return { r, sent };
}

const end = (r: Awaited<ReturnType<typeof rig>>["r"], id: string) => r.fire("tool_execution_end", { toolName: "ask_user_question", toolCallId: id, result: {}, isError: false });

test("ask_user_question: blocked from tool_call to tool_execution_end with no ui_prompt events", async (t) => {
  const { r, sent } = await rig(t);
  await r.fire("tool_call", { toolName: "ask_user_question", toolCallId: "q1", input: { questions: [{ header: "Pick\none", question: "x", options: [] }] } });
  assert.deepEqual(sent.map((s) => s.active), [true]);
  assert.equal(sent[0].label, "Pick one");
  await end(r, "q1");
  assert.deepEqual(sent.map((s) => s.active), [true, false]);
});

test("an overlapping ui_prompt still yields exactly one true/false pair", async (t) => {
  const { r, sent } = await rig(t);
  await r.fire("tool_call", { toolName: "ask_user_question", toolCallId: "q2", input: { questions: [] } });
  await r.fire("ui_prompt_start", { kind: "custom" });
  await r.fire("ui_prompt_end", {});
  assert.deepEqual(sent.map((s) => s.active), [true], "the own source still holds");
  await end(r, "q2");
  assert.deepEqual(sent.map((s) => s.active), [true, false]);
});

test("turn_start and agent_end release an unanswered question", async (t) => {
  const { r, sent } = await rig(t);
  await r.fire("tool_call", { toolName: "plan_mode_question", toolCallId: "q3", input: {} });
  assert.deepEqual(sent.map((s) => s.active), [true]);
  assert.equal(sent[0].label, "question");
  await r.turnStart();
  assert.deepEqual(sent.map((s) => s.active), [true, false]);
  await r.fire("tool_call", { toolName: "ask_user_question", toolCallId: "q4", input: {} });
  await r.fire("agent_end", {});
  assert.deepEqual(sent.map((s) => s.active), [true, false, true, false]);
});
