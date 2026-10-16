// Ledger 11: pi-subagents 0.76.1+ appends notices and supervisor requests to an idle parent with
// triggerTurn false (no extension message_end) and wakes it with its own user message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CustomSeen, isSubagentWake, SUBAGENT_WAKE_TEXT } from "../idlecustom.ts";
import { userPromptOf } from "../review.ts";

const WAKE = SUBAGENT_WAKE_TEXT;
const msg = (id: string, customType: string, details: unknown = {}) => ({ type: "custom_message", id, customType, content: `c-${id}`, details });
const user = { type: "message", id: "u", message: { role: "user" } };

test("trailing custom entries after the last message are returned once, oldest first", () => {
  const seen = new CustomSeen();
  const branch = [msg("a", "subagent-notify"), user, msg("b", "subagent-notify"), msg("c", "subagent_supervisor_request", { requestId: "r1" })];
  assert.deepEqual(seen.unseenTrailing(branch).map((m) => m.customType), ["subagent-notify", "subagent_supervisor_request"]);
  assert.deepEqual(seen.unseenTrailing(branch), []);
});

test("a custom message handled at message_end is not handled again from the branch", () => {
  const seen = new CustomSeen();
  const e = msg("b", "subagent-notify", { runs: [1] });
  seen.mark({ role: "custom", customType: e.customType, content: e.content, details: e.details });
  assert.deepEqual(seen.unseenTrailing([user, e, msg("c", "subagent-notify")]).map((m) => m.content), ["c-c"]);
});

test("only pi-subagents' extension wake counts as a subagent wake", () => {
  assert.equal(isSubagentWake("extension", WAKE), true);
  assert.equal(isSubagentWake("rpc", WAKE), false);
  assert.equal(isSubagentWake("extension", "New intercom message above."), false);
});

test("an owner prompt that starts with or quotes the wake text is not the wake", () => {
  const quoted = `${WAKE} Then also fix the parser.`;
  const first = "Inspect subagent updates above. What did the reviewer say?";
  assert.equal(isSubagentWake("extension", quoted), false);
  assert.equal(isSubagentWake("extension", first), false);
  assert.equal(userPromptOf({ messageType: "user", prompt: quoted }), quoted);
  assert.equal(userPromptOf({ messageType: "user", prompt: first }), first);
});

test("a key marked before an assistant message does not hide a later idle message with the same content", () => {
  const seen = new CustomSeen();
  const e = msg("x", "subagent-notify", { runs: [1] });
  seen.mark({ role: "custom", customType: e.customType, content: e.content, details: e.details });
  seen.settle();
  const later = { ...msg("y", "subagent-notify", { runs: [1] }), content: e.content };
  assert.deepEqual(seen.unseenTrailing([user, later]).map((m) => m.content), ["c-x"]);
});

test("the subagent wake prompt is not the owner's request", () => {
  assert.equal(userPromptOf({ messageType: "user", prompt: WAKE }), null);
  assert.equal(userPromptOf({ messageType: "user", prompt: "fix the parser" }), "fix the parser");
});
