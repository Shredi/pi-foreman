import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeToolCallNotices } from "../notices.ts";

const notice = (toolCallId: string | undefined, runId = "r1") => ({
  role: "custom",
  customType: "subagent_control_notice",
  details: { event: { type: "needs_attention", reason: "tool_open_threshold", runId, ...(toolCallId ? { toolCallId } : {}) } },
});

test("repeated tool-open notices for one tool call keep only the first", () => {
  const first = notice("c1");
  const out = dedupeToolCallNotices([first, notice("c1"), notice("c1")]);
  assert.equal(out?.dropped, 2);
  assert.deepEqual(out?.messages, [first]);
});

test("another tool call, another run, a notice without a call id and other messages stay", () => {
  const msgs = [notice("c1"), notice("c2"), notice("c1", "r2"), notice(undefined), notice(undefined), { role: "user", content: "x" }];
  assert.equal(dedupeToolCallNotices(msgs), null);
});
