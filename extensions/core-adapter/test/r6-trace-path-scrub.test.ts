// R6 lane 7f security: a tool_error message never carries a path or a file name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeTrace, scrubPaths, toolErrorRecord } from "../trace.ts";

test("scrubPaths: absolute, home, relative and bare file names become [path]", () => {
  assert.equal(scrubPaths("precondition failed: dst_exists (/work/proj/b.txt already exists)"), "precondition failed: dst_exists ([path] already exists)");
  assert.equal(scrubPaths("cannot read ~/notes/a"), "cannot read [path]");
  assert.equal(scrubPaths("see ./src/x and ../y/z"), "see [path] and [path]");
  assert.equal(scrubPaths("open src/lib failed"), "open [path] failed");
  assert.equal(scrubPaths("no such file: b.txt."), "no such file: [path].");
});

test("scrubPaths: a message without paths is unchanged", () => {
  const m = "precondition failed: dst_exists [redacted] retry 3 times";
  assert.equal(scrubPaths(m), m);
});

test("tool_error: the traced message holds no path, name or secret", () => {
  const rec = sanitizeTrace(toolErrorRecord("foreman_move", [{ type: "text", text: "precondition failed: dst_exists (/tmp/p/b.txt already exists) token=abcdef" }]));
  assert.equal(rec.message, "precondition failed: dst_exists ([path] already exists) token=[redacted]");
  assert.ok(!JSON.stringify(rec).includes("b.txt"));
});
