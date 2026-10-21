// R24 item 2: revision chains start again on every owner-typed prompt, not on harness notices.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isOwnerPrompt } from "../rounds.ts";
import { SUBAGENT_WAKE_TEXT } from "../idlecustom.ts";
import { INTERCOM_WAKE_TEXT } from "../usage.ts";
import { r11Rig } from "./_r11rig.ts";

test("isOwnerPrompt: owner prompts and harness texts", () => {
  assert.equal(isOwnerPrompt("interactive", "why?"), true);
  assert.equal(isOwnerPrompt("rpc", "why?"), true);
  assert.equal(isOwnerPrompt("extension", "[continue]"), true);
  assert.equal(isOwnerPrompt("extension", "pi-foreman: steer"), false);
  assert.equal(isOwnerPrompt("extension", SUBAGENT_WAKE_TEXT), false);
  assert.equal(isOwnerPrompt("extension", INTERCOM_WAKE_TEXT), false);
  assert.equal(isOwnerPrompt("extension", "Background task completed: **reviewer**"), false);
  assert.equal(isOwnerPrompt("other", "why?"), false);
});

test("input hook: [continue] from an extension clears the chains, a notice does not", async (t) => {
  const a = await r11Rig(t);
  await a.input("extension", "Background task completed: **builder**");
  assert.deepEqual(a.events("chain_clear"), []);
  await a.input("extension", "[continue]");
  await a.input("interactive", "why?");
  assert.deepEqual(a.events("chain_clear").map((e) => e.kind), ["extension", "interactive"]);
});
