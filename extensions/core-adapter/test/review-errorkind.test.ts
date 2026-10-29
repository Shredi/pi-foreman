import { test } from "node:test";
import assert from "node:assert/strict";
import { errorKind } from "../review.ts";

test("errorKind classifies auth, abort and provider errors and never carries the value", () => {
  assert.equal(errorKind("Not logged in · Please run /login"), "auth");
  assert.equal(errorKind("Provider is not configured: x"), "auth");
  assert.equal(errorKind("Aborted"), "aborted");
  const capture = "prompt-capture: no capture for this 34-char system prompt, and it embeds none of the 3 known.";
  assert.equal(errorKind(capture), `provider_error:${capture.slice(0, 60)}`);
  assert.equal(errorKind("bad request: git push origin main rejected", "git push origin main"), "provider_error:bad request: <value> rejected");
  assert.equal(errorKind(""), "provider_error:unknown");
});
