// Ledger 7: Pi 1.2 fires before_agent_start for idle custom-message runs (wake, child notice) with
// messageType "custom" and no prompt; only a user run (or a Pi 1.1 event without messageType) may
// set the review intent and triage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { userPromptOf } from "../review.ts";

test("a Pi 1.2 user run yields its prompt", () => {
  assert.equal(userPromptOf({ type: "before_agent_start", messageType: "user", prompt: "fix the parser" }), "fix the parser");
  assert.equal(userPromptOf({ messageType: "user" }), "");
});

test("a Pi 1.1 event without messageType is a user run", () => {
  assert.equal(userPromptOf({ type: "before_agent_start", prompt: "add a test" }), "add a test");
  assert.equal(userPromptOf({ type: "before_agent_start" }), "");
});

test("a custom-message run (wake, child notice) yields no prompt", () => {
  assert.equal(userPromptOf({ type: "before_agent_start", messageType: "custom", message: { customType: "foreman_wake", content: "w1 (timer)" } }), null);
  assert.equal(userPromptOf({ messageType: "custom", prompt: "stray" }), null);
  assert.equal(userPromptOf({ messageType: "other" }), null);
});

test("garbage events count as a user run with an empty prompt", () => {
  assert.equal(userPromptOf(undefined), "");
  assert.equal(userPromptOf(null), "");
  assert.equal(userPromptOf({ prompt: 42 }), "");
});

test("a wake between two user runs leaves the latest request alone", () => {
  let intent = "";
  // the same guard the before_agent_start handler applies
  const onStart = (event: unknown) => {
    const prompt = userPromptOf(event);
    if (prompt !== null) intent = prompt;
  };
  onStart({ messageType: "user", prompt: "refactor the cache" });
  assert.equal(intent, "refactor the cache");
  onStart({ messageType: "custom", message: { customType: "foreman_wake" } });
  assert.equal(intent, "refactor the cache");
  onStart({ messageType: "user", prompt: "now ship it" });
  assert.equal(intent, "now ship it");
});
