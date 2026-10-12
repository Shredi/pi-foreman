// R6 lane 7f: isError tool results are traced as tool_error{tool, message}, message redacted and cut to 200 chars.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeTrace, toolErrorRecord, TRACE_FIELDS } from "../trace.ts";

test("7f: tool_error carries the tool and a redacted, cut message", () => {
  const rec = sanitizeTrace(toolErrorRecord("bash", [{ type: "text", text: "curl failed: Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 " + "x".repeat(400) }]));
  assert.equal(rec.event, "tool_error");
  assert.equal(rec.tool, "bash");
  assert.ok(String(rec.message).length <= 200);
  assert.doesNotMatch(String(rec.message), /abcdefghijklmnopqrstuvwxyz0123456789/);
  assert.match(String(rec.message), /^curl failed/);
});

test("7f: message is kept only on a tool_error; fields were appended", () => {
  assert.equal(sanitizeTrace({ event: "other", message: "hello" }).message, undefined);
  assert.deepEqual(TRACE_FIELDS.slice(-2), ["tool", "message"]);
  assert.equal(sanitizeTrace(toolErrorRecord("read", undefined)).message, "");
});
