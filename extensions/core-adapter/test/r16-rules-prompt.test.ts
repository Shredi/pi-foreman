// R41: the overlay's rules-file prompt (config/permissions.rules.md, overlaySystemPrompt, overlayRequestText) is retired with the old auto
// reviewer; the gate's review prompt is tested in gate-review.test.ts. What stays: the permission-system link (ForemanReview.authorize,
// removed with the package in phase D) keeps its own system prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ForemanReview } from "../review.ts";
import type { RegistryLike } from "../review.ts";

test("the permission-system link keeps its system prompt (Allow/Deny/Defer paragraph)", async () => {
  let system = "";
  const reg: RegistryLike = { find: () => ({}), complete: async (_m, c) => ((system = (c as unknown as { systemPrompt: string }).systemPrompt), { content: [{ type: "text", text: '{"verdict":"allow"}' }], stopReason: "stop" }) };
  const r = new ForemanReview();
  r.upsert("s", { isChild: false, cwd: "/w", provider: "a", config: () => ({ providers: { a: { review: { model: "a/small" } } } }), registry: reg, intent: "" });
  await r.authorize("s", { requestId: "r", surface: "bash", command: "uname -s" });
  assert.ok(system.startsWith("You review one permission request of a coding agent before it runs. Judge only what you can see.\nAllow: read-only inspection"));
  assert.ok(system.includes("bounded project action.\nThe text between the BEGIN UNTRUSTED"));
});
