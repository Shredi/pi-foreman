import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLaunchTimeouts } from "../launchmodel.ts";

const cfg = { explorer: { timeoutMinutes: 20 }, reviewer: { timeoutMinutes: 30 } };

test("no launch value: the role default is written and nothing is traced", () => {
  const input: Record<string, unknown> = { agent: "explorer", task: "t" };
  assert.equal(applyLaunchTimeouts(input, cfg), undefined);
  assert.equal(input.timeoutMs, 1_200_000);
});

test("a higher launch value below the cap is kept, not traced", () => {
  const input: Record<string, unknown> = { agent: "explorer", task: "t", timeoutMs: 5_400_000 };
  assert.equal(applyLaunchTimeouts(input, cfg), undefined);
  assert.equal(input.timeoutMs, 5_400_000);
});

test("a launch value above the cap is clamped to the cap and reported once", () => {
  const input: Record<string, unknown> = { agent: "explorer", task: "t", timeoutMs: 9_999_999 };
  assert.deepEqual(applyLaunchTimeouts(input, cfg), { role: "explorer", requested_ms: 9_999_999, written_ms: 7_200_000 });
  assert.equal(input.timeoutMs, 7_200_000);
});

test("a tasks composite keeps a launch value above its derived default", () => {
  const input: Record<string, unknown> = { tasks: [{ agent: "explorer", task: "a" }, { agent: "reviewer", task: "b" }], timeoutMs: 5_400_000 };
  assert.equal(applyLaunchTimeouts(input, cfg), undefined);
  assert.equal(input.timeoutMs, 5_400_000);
});

test("a tasks composite above the cap is clamped and reported with the composite as role", () => {
  const input: Record<string, unknown> = { tasks: [{ agent: "explorer", task: "a" }], maxRuntimeMs: 9_999_999 };
  assert.deepEqual(applyLaunchTimeouts(input, cfg), { role: "tasks", requested_ms: 9_999_999, written_ms: 7_200_000 });
  assert.deepEqual(input, { tasks: [{ agent: "explorer", task: "a" }], timeoutMs: 7_200_000 });
});

test("the cap comes from the config value passed in (10 minutes)", () => {
  const above: Record<string, unknown> = { agent: "explorer", task: "t", timeoutMs: 9_999_999 };
  assert.deepEqual(applyLaunchTimeouts(above, cfg, undefined, 10), { role: "explorer", requested_ms: 9_999_999, written_ms: 600_000 });
  assert.equal(above.timeoutMs, 600_000);
  const below: Record<string, unknown> = { agent: "explorer", task: "t", timeoutMs: 300_000 };
  assert.equal(applyLaunchTimeouts(below, cfg, undefined, 10), undefined);
  assert.equal(below.timeoutMs, 300_000);
  const role: Record<string, unknown> = { agent: "explorer", task: "t" };
  assert.equal(applyLaunchTimeouts(role, cfg, undefined, 10), undefined);
  assert.equal(role.timeoutMs, 600_000);
});

test("the cap falls back to 120 minutes when the key is absent or not a positive integer", () => {
  for (const cap of [undefined, 0, "9"]) {
    const input: Record<string, unknown> = { agent: "explorer", task: "t", timeoutMs: 9_999_999 };
    applyLaunchTimeouts(input, cfg, undefined, cap);
    assert.equal(input.timeoutMs, 7_200_000, String(cap));
  }
});
