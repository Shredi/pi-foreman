// One detector for an inbound pi-intercom message on both delivery paths (pi-intercom 0.18.1):
// Pi 1.2+ idle triggerTurn (before_agent_start, then message_end, no `input`), busy steer (message_end),
// Pi < 1.2.0 wake line (`input`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { intercomInbound, intercomSender, isIntercomCustom } from "../intercomguard.ts";
import { causeOfCustom, causeOfInput, INTERCOM_WAKE_TEXT } from "../usage.ts";

const details = (id = "m1") => ({ from: { id: "abcdef123456", name: "builder" }, message: { id, content: { text: "hi" } }, replyCommand: "x" });
const custom = (d: unknown = details(), customType = "intercom_message") => ({ role: "custom", customType, content: "c", display: true, details: d });
const entry = (d: unknown) => ({ type: "custom_message", customType: "intercom_message", details: d });

test("isIntercomCustom keys on the customType and the details objects, not on text", () => {
  assert.equal(isIntercomCustom(custom()), true);
  assert.equal(isIntercomCustom(custom(details(), "foreman_wake")), false);
  assert.equal(isIntercomCustom(custom({ from: "x", message: {} })), false);
  assert.equal(isIntercomCustom(custom({ from: {} })), false);
  assert.equal(isIntercomCustom(custom(null)), false);
  assert.equal(isIntercomCustom(null), false);
});

test("before_agent_start (Pi 1.2+ idle triggerTurn run) detects the custom message", () => {
  const hit = intercomInbound({ hook: "before_agent_start", messageType: "custom", message: custom() });
  assert.deepEqual(hit, { details: details(), id: "m1" });
  assert.equal(intercomSender(hit!.details), "builder");
  assert.equal(intercomInbound({ hook: "before_agent_start", messageType: "user", message: custom() }), null);
  assert.equal(intercomInbound({ hook: "before_agent_start", messageType: "custom", message: custom(details(), "subagent-notify") }), null);
  assert.equal(intercomInbound({ hook: "before_agent_start", messageType: "custom" }), null);
});

test("message_end (busy steer, and the triggerTurn run) detects a custom-role message only", () => {
  assert.equal(intercomInbound({ hook: "message_end", message: custom() })?.id, "m1");
  assert.equal(intercomInbound({ hook: "message_end", message: { ...custom(), role: "assistant" } }), null);
  assert.equal(intercomInbound({ hook: "message_end", message: custom(details(), "other") }), null);
  assert.equal(intercomInbound({ hook: "message_end", message: undefined }), null);
});

test("both hooks of one message report the same id (callers dedupe on it)", () => {
  const a = intercomInbound({ hook: "before_agent_start", messageType: "custom", message: custom(details("same")) });
  const b = intercomInbound({ hook: "message_end", message: custom(details("same")) });
  assert.equal(a!.id, b!.id);
  assert.equal(intercomInbound({ hook: "message_end", message: custom({ from: {}, message: {} }) })?.id, "");
});

test("input detects only the legacy wake line from an extension, then reads the branch", () => {
  const branch = [entry(details("old")), { type: "message", message: { role: "user" } }, entry(details("new"))];
  const wake = intercomInbound({ hook: "input", source: "extension", text: INTERCOM_WAKE_TEXT, branch });
  assert.equal(wake?.id, "new");
  assert.equal(intercomInbound({ hook: "input", source: "interactive", text: INTERCOM_WAKE_TEXT, branch }), null);
  assert.equal(intercomInbound({ hook: "input", source: "rpc", text: INTERCOM_WAKE_TEXT, branch }), null);
  assert.equal(intercomInbound({ hook: "input", source: "extension", text: "Inspect subagent updates above.", branch }), null);
  assert.equal(intercomInbound({ hook: "input", source: "extension", text: INTERCOM_WAKE_TEXT, branch: [entry(details())].concat([{ type: "message", message: { role: "user" } } as never]) }), null);
});

test("turn cause: the custom message (triggerTurn) and the legacy wake line are both intercom", () => {
  assert.equal(causeOfCustom("intercom_message"), "intercom");
  assert.equal(causeOfInput("extension", INTERCOM_WAKE_TEXT), "intercom");
});
