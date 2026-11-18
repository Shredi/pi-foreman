// D96: a launch with only options.timeoutMs / options.toolTimeoutMs starts with that value; the adapter's own top-level value is not a duplicate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLaunchTimeouts } from "../launchmodel.ts";

type In = Record<string, unknown>;
const run = (input: In, cap?: number): In => (applyLaunchTimeouts(input, {}, 1800, cap), input);

test("only options.timeoutMs: moved to the top level, no duplicate", () => {
  const input = run({ agent: "explorer", task: "t", options: { timeoutMs: 1_140_000 } });
  assert.equal(input.timeoutMs, 1_140_000);
  assert.deepEqual(input.options, {});
  // a builder's run limit is raised to the child timeout, as for a top-level value
  assert.equal(run({ agent: "builder", task: "t", options: { timeoutMs: 1_140_000 } }).timeoutMs, run({ agent: "builder", task: "t", timeoutMs: 1_140_000 }).timeoutMs);
});

test("options.timeoutMs is capped as a top-level value would be", () => {
  const nested = run({ agent: "builder", task: "t", options: { timeoutMs: 1_140_000 } }, 10);
  const top = run({ agent: "builder", task: "t", timeoutMs: 1_140_000 }, 10);
  assert.equal(nested.timeoutMs, top.timeoutMs);
  assert.deepEqual(nested.options, {});
});

test("only options.toolTimeoutMs: moved to the top level, the default is not written beside it", () => {
  const input = run({ agent: "builder", task: "t", options: { toolTimeoutMs: 1_140_000 } });
  assert.equal(input.toolTimeoutMs, 1_140_000);
  assert.deepEqual(input.options, {});
});

test("a numeric string is converted", () => {
  const input = run({ agent: "explorer", task: "t", options: { timeoutMs: "1140000", toolTimeoutMs: "5000" } });
  assert.equal(input.timeoutMs, 1_140_000);
  assert.equal(input.toolTimeoutMs, 5000);
  assert.deepEqual(input.options, {});
});

test("a non-numeric value stays in options", () => {
  const input = run({ agent: "builder", task: "t", options: { timeoutMs: "soon", toolTimeoutMs: {} } });
  assert.deepEqual(input.options, { timeoutMs: "soon", toolTimeoutMs: {} });
  assert.equal(input.timeoutMs, undefined);
});

test("options.maxRuntimeMs is never moved", () => {
  const input = run({ agent: "builder", task: "t", options: { maxRuntimeMs: 1_140_000 } });
  assert.deepEqual(input.options, { maxRuntimeMs: 1_140_000 });
  assert.equal(input.maxRuntimeMs, undefined);
});

test("both places set: nothing moves", () => {
  const input = run({ agent: "builder", task: "t", timeoutMs: 2_000_000, toolTimeoutMs: 7, options: { timeoutMs: 1_140_000, toolTimeoutMs: 9 } });
  assert.deepEqual(input.options, { timeoutMs: 1_140_000, toolTimeoutMs: 9 });
  assert.deepEqual([input.timeoutMs, input.toolTimeoutMs], [2_000_000, 7]);
});

test("top-level only: unchanged", () => {
  const input = run({ agent: "builder", task: "t", timeoutMs: 2_000_000, toolTimeoutMs: 7 });
  assert.deepEqual(input, { agent: "builder", task: "t", timeoutMs: 2_000_000, toolTimeoutMs: 7 });
});
