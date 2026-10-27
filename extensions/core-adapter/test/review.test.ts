import { test } from "node:test";
import assert from "node:assert/strict";
import { autoReviewTarget, reviewTarget, withEstimatedUsage } from "../review.ts";
import type { RegistryLike } from "../review.ts";

const config = { providers: { a: { review: { model: "a/small", timeoutMs: 50 } }, b: { roles: {} }, c: { review: { model: "tiny" } } } };

test("reviewTarget reads providers.<active>.review; none means review off", () => {
  assert.deepEqual(reviewTarget(config, "a"), { provider: "a", modelId: "small", timeoutMs: 50 });
  assert.deepEqual(reviewTarget(config, "c"), { provider: "c", modelId: "tiny", timeoutMs: 15000 });
  assert.equal(reviewTarget(config, "b"), null);
  assert.equal(reviewTarget(config, undefined), null);
});

test("no review.model: the cheapest role-map model with auth is auto-picked; none gives null", () => {
  const models: Record<string, { cost: { input: number }; auth: boolean }> = { "p/big": { cost: { input: 5 }, auth: true }, "p/mid": { cost: { input: 2 }, auth: true }, "p/tiny": { cost: { input: 0.1 }, auth: false } };
  const registry: RegistryLike = { find: (p, id) => models[`${p}/${id}`], hasConfiguredAuth: (m) => (m as unknown as { auth: boolean }).auth, complete: async () => ({ content: [{ type: "text", text: '{"verdict":"allow"}' }], stopReason: "stop" }) };
  const cfg = { providers: { p: { roles: { foreman: { model: "p/big:high" }, builder: { model: "p/tiny", strong: { model: "p/mid" } }, explorer: { model: "gone" } } } } };
  assert.deepEqual(autoReviewTarget(cfg, "p", registry), { provider: "p", modelId: "mid", timeoutMs: 15000, auto: true });
  assert.equal(autoReviewTarget({ providers: { p: { roles: { builder: { model: "p/tiny" } } } } }, "p", registry), null);
});

test("withEstimatedUsage: a zero-usage reply gets a chars/4 estimate with estimated:true; real usage is untouched", () => {
  const zero = withEstimatedUsage({ content: [{ type: "text", text: "abcdefgh" }], usage: { input: 0, output: 0 } }, "x".repeat(40), "y".repeat(40)) as { usage: { input: number; output: number }; estimated?: boolean };
  assert.deepEqual([zero.usage.input, zero.usage.output, zero.estimated], [20, 2, true]);
  const real = { content: [], usage: { input: 5, output: 1 } };
  assert.equal(withEstimatedUsage(real, "x", "y"), real);
});
