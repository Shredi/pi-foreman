// An answered ask_user_question lifts the [review_loop] stop (index.ts tool_execution_end); cancelled, no-UI, error and empty answers do not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { world } from "./_r46world.ts";
import { FAIL_REPORT, codeReview, loopRefused, stopLoop } from "./_loopstop.ts";
import type { Adapter } from "./_loopstop.ts";
import { askAnsweredSome } from "../askhooks.ts";

const standard = { ceremony: { default: "standard" } };
const answered = { answers: [{ questionIndex: 0, question: "How to go on?", kind: "option", answer: "retry" }], cancelled: false };

const end = (a: Adapter, details: unknown, opts: { isError?: boolean; toolName?: string } = {}) =>
  a.fire("tool_execution_end", { toolName: opts.toolName ?? "ask_user_question", toolCallId: "q1", result: { content: [{ type: "text", text: "x" }], details }, isError: opts.isError ?? false });

test("an answered ask lifts the stop", async (t) => {
  const w = world(t, standard);
  const a = await w.adapter("startup");
  await stopLoop(a);
  assert.ok(loopRefused(await a.launch("builder")));
  await end(a, answered);
  assert.equal(await a.launch("builder"), undefined);
  assert.equal((await w.traceEvents()).filter((r) => r.event === "cap_reset" && r.by === "ask").length, 1);
});

test("a cancelled, no-UI, error or empty answer does not lift it; nor do other tools", async (t) => {
  const w = world(t, standard);
  const a = await w.adapter("startup");
  await stopLoop(a);
  await end(a, { answers: [], cancelled: true });
  await end(a, { answers: [], cancelled: true, error: "no_ui" });
  await end(a, { ...answered, cancelled: true });
  await end(a, answered, { isError: true });
  await end(a, { answers: [], cancelled: false });
  await end(a, answered, { toolName: "intercom" });
  await end(a, answered, { toolName: "contact_supervisor" });
  assert.ok(loopRefused(await a.launch("builder")));
  assert.equal((await w.traceEvents()).filter((r) => r.event === "cap_reset").length, 0);
});

test("after the lift a further repeat FAIL loop stops again", async (t) => {
  const w = world(t, standard);
  const a = await w.adapter("startup");
  await stopLoop(a);
  await end(a, answered);
  assert.equal(await a.launch("builder"), undefined);
  // the round state is kept: another FAIL with the same findings repeats the last round
  assert.equal(await codeReview(a, FAIL_REPORT, 3), null);
  assert.ok(loopRefused(await a.launch("builder")));
});

test("askAnsweredSome needs a non-error, non-cancelled result with at least one answer", () => {
  assert.equal(askAnsweredSome(answered, false), true);
  assert.equal(askAnsweredSome(answered, true), false);
  assert.equal(askAnsweredSome({ answers: [], cancelled: false }, false), false);
  assert.equal(askAnsweredSome({ cancelled: false }, false), false);
  assert.equal(askAnsweredSome({ answers: [], cancelled: true, error: "no_ui" }, false), false);
  assert.equal(askAnsweredSome({ ...answered, cancelled: true }, false), false);
  assert.equal(askAnsweredSome(undefined, false), false);
});
