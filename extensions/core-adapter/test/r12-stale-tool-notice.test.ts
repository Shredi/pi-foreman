import { test } from "node:test";
import assert from "node:assert/strict";
import { AttentionNotices, dedupeToolCallNotices, dropEndedRunNotices, hideStaleNotice } from "../notices.ts";

const notice = (runId: string, toolCallId = "c1") => ({
  role: "custom",
  customType: "subagent_control_notice",
  display: true,
  content: "tool 'bash' open for 240s",
  details: { event: { type: "needs_attention", reason: "tool_open_threshold", runId, toolCallId } },
});

test("tool_open_notice_dropped_after_run_exit", () => {
  const user = { role: "user", content: "x" };
  const msgs = [notice("r1"), notice("r2"), user];
  const out = dropEndedRunNotices(dedupeToolCallNotices(msgs)?.messages ?? msgs, new Set(["r1"]));
  assert.equal(out?.dropped, 1);
  assert.deepEqual(out?.messages, [msgs[1], user]);
});

test("tool_open_visible_notice_stops_after_run_exit", () => {
  const att = new AttentionNotices();
  const first = notice("r1");
  assert.equal(hideStaleNotice(att, first), null, "live run: shown");
  att.onRunEnd("r1");
  const hidden = hideStaleNotice(att, notice("r1", "c2")) as { display?: boolean } | null;
  assert.equal(hidden?.display, false, "ended run: hidden");
  assert.equal(hideStaleNotice(att, notice("r2")), null, "other run unaffected");
});

test("tool_open_visible_notice_two_indices_live_run_both_shown", () => {
  const att = new AttentionNotices();
  assert.equal(hideStaleNotice(att, notice("r1", "c1")), null);
  assert.equal(hideStaleNotice(att, notice("r1", "c2")), null);
  assert.equal(hideStaleNotice(att, notice("r1", "c1")), null, "same state again: still shown, dedupe is pi-subagents'");
});

test("tool_open_notice_kept_for_live_run", () => {
  const msgs = [notice("r1"), notice("r2", "c2")];
  assert.equal(dropEndedRunNotices(msgs, new Set(["r9"])), null);
  assert.equal(dropEndedRunNotices(msgs, new Set()), null);
});
