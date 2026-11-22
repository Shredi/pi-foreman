// A suite command with a secret-shaped token goes into the PR body redacted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewsLine } from "../prbody.ts";

test("suite command secrets are redacted in the Reviews line", () => {
  const line = reviewsLine({ head: "abcdef1234", occasion: "pre-pr", run: "r1", suites: [{ command: "API_TOKEN=supersecretvalue1 npm test", result: "pass" }] });
  assert.ok(!line.includes("supersecretvalue1"), line);
  assert.match(line, /\[redacted\]/);
});
