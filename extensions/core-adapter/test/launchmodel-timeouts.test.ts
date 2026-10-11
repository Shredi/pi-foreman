import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLaunchTimeouts, childTimeoutSeconds } from "../launchmodel.ts";

test("childTimeoutSeconds: positive integer, else 1800", () => {
  assert.deepEqual([childTimeoutSeconds(undefined), childTimeoutSeconds(0), childTimeoutSeconds("9"), childTimeoutSeconds(600)], [1800, 1800, 1800, 600]);
});

test("toolTimeoutMs is set for the five child roles", () => {
  for (const agent of ["planner", "builder", "reviewer", "senior-reviewer", "finalizer"]) {
    const input: Record<string, unknown> = { agent, task: "t" };
    applyLaunchTimeouts(input, {}, 1800);
    assert.equal(input.toolTimeoutMs, 1_800_000, agent);
  }
  const input: Record<string, unknown> = { tasks: [{ agent: "explorer", task: "t" }, { parallel: [{ agent: "builder", task: "t" }] }] };
  applyLaunchTimeouts(input, {}, 100);
  assert.equal(input.toolTimeoutMs, 100_000);
});

test("timeoutMs is raised when lower, kept when higher; a set toolTimeoutMs stays", () => {
  const low: Record<string, unknown> = { agent: "builder", task: "t", timeoutMs: 1000 };
  applyLaunchTimeouts(low, {});
  assert.equal(low.timeoutMs, 1_800_000);
  const high: Record<string, unknown> = { agent: "builder", task: "t", timeoutMs: 9_000_000, toolTimeoutMs: 5 };
  applyLaunchTimeouts(high, {});
  assert.deepEqual([high.timeoutMs, high.toolTimeoutMs], [9_000_000, 5]);
});

test("untouched without a child role or when timeoutMs is absent", () => {
  const ex: Record<string, unknown> = { agent: "explorer", task: "t", timeoutMs: 1000 };
  applyLaunchTimeouts(ex, {});
  assert.deepEqual(ex, { agent: "explorer", task: "t", timeoutMs: 1000 });
  const b: Record<string, unknown> = { agent: "builder", task: "t" };
  applyLaunchTimeouts(b, {});
  assert.equal("timeoutMs" in b, false);
});
