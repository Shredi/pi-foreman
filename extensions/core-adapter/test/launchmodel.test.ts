import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLaunchModels, applyLaunchTimeouts, launchModel } from "../launchmodel.ts";

const ROLES = {
  explorer: { model: "p1/small", thinking: "low" },
  builder: { model: "p1/mid", thinking: "medium" },
  reviewer: { model: "p1/big", thinking: null },
};

test("no foreman model: the mapped model and thinking are set", () => {
  const input: Record<string, unknown> = { agent: "explorer", task: "t" };
  assert.deepEqual(applyLaunchModels(input, ROLES, "high").overrides, []);
  assert.equal(input.model, "p1/small:low");
});

test("foreman level is kept, provider and model come from the map", () => {
  const input: Record<string, unknown> = { agent: "explorer", task: "t", model: ":medium" };
  assert.deepEqual(applyLaunchModels(input, ROLES, "high").overrides, []);
  assert.equal(input.model, "p1/small:medium");
  assert.equal(launchModel("explorer", ROLES, "p1/small:high", "high")?.model, "p1/small:high");
});

test("foreman level above maxThinking is clamped", () => {
  assert.equal(launchModel("builder", ROLES, ":max", "high")?.model, "p1/mid:high");
  assert.equal(launchModel("builder", ROLES, ":xhigh", undefined)?.model, "p1/mid:xhigh");
});

test("a differing foreman model is replaced and reported", () => {
  const input: Record<string, unknown> = { agent: "builder", task: "t", model: "p2/other:low" };
  assert.deepEqual(applyLaunchModels(input, ROLES, "high").overrides, [{ role: "builder", model: "p1/mid", requested: "p2/other" }]);
  assert.equal(input.model, "p1/mid:low");
});

test("tasks and chain entries each get their role's model; top-level model is dropped", () => {
  const input: Record<string, unknown> = {
    model: "p2/x",
    tasks: [{ agent: "explorer", task: "a" }, { agent: "builder", task: "b" }],
  };
  const flagged = applyLaunchModels(input, ROLES, "high").overrides;
  assert.deepEqual(input, { tasks: [{ agent: "explorer", task: "a", model: "p1/small:low" }, { agent: "builder", task: "b", model: "p1/mid:medium" }] });
  assert.deepEqual(flagged, [{ role: "explorer", model: "p1/small", requested: "p2/x" }, { role: "builder", model: "p1/mid", requested: "p2/x" }]);

  const chain: Record<string, unknown> = { chain: [{ agent: "explorer" }, { parallel: [{ agent: "reviewer", task: "x" }, { agent: "builder", task: "y" }] }] };
  assert.deepEqual(applyLaunchModels(chain, ROLES, "high").overrides, []);
  assert.deepEqual(chain, {
    chain: [{ agent: "explorer", model: "p1/small:low" }, { parallel: [{ agent: "reviewer", task: "x", model: "p1/big" }, { agent: "builder", task: "y", model: "p1/mid:medium" }] }],
  });
});

test("thinking null gives no suffix; management calls are untouched", () => {
  assert.equal(launchModel("reviewer", ROLES, undefined, "high")?.model, "p1/big");
  const mgmt: Record<string, unknown> = { action: "status", id: "r1", model: "p9/z" };
  assert.deepEqual(applyLaunchModels(mgmt, ROLES, "high").overrides, []);
  assert.equal(mgmt.model, "p9/z");
});

const STRONG = { ...ROLES, builder: { model: "p1/mid", thinking: "medium", strong: { model: "p1/big", thinking: "high" } } };

test("strength: no keyword gives the builder its strong model on a heavy tier or with preferStrong", () => {
  assert.equal(launchModel("builder", STRONG, undefined, "high", { tier: "standard" })?.model, "p1/mid:medium");
  assert.equal(launchModel("builder", STRONG, undefined, "high", { tier: "heavy" })?.model, "p1/big:high");
  assert.equal(launchModel("builder", STRONG, undefined, "high", { tier: "trivial", preferStrong: true })?.model, "p1/big:high");
  assert.equal(launchModel("builder", STRONG, "default", "high", { tier: "heavy" })?.model, "p1/mid:medium");
  assert.equal(launchModel("builder", STRONG, "strong:low", "high", { tier: "standard" })?.model, "p1/big:low");
  assert.equal(launchModel("explorer", STRONG, undefined, "high", { tier: "heavy" })?.model, "p1/small:low");
});

test("strong without a mapped strong model: default model plus a notice naming it", () => {
  const input: Record<string, unknown> = { agent: "explorer", task: "t", model: "strong" };
  const r = applyLaunchModels(input, STRONG, "high", { tier: "heavy", provider: "p1" });
  assert.equal(input.model, "p1/small:low");
  assert.deepEqual(r.overrides, []);
  assert.deepEqual(r.notices.map((n) => n.text), ["pi-foreman: no strong model mapped for explorer on p1; launched on p1/small:low"]);
  assert.equal(launchModel("builder", ROLES, undefined, "high", { tier: "heavy" })?.notice, undefined);
});

test("a raw model id on a heavy tier is replaced by the builder's strong model and reported", () => {
  const input: Record<string, unknown> = { agent: "builder", task: "t", model: "p2/other" };
  assert.deepEqual(applyLaunchModels(input, STRONG, "high", { tier: "heavy" }).overrides, [{ role: "builder", model: "p1/big", requested: "p2/other" }]);
  assert.equal(input.model, "p1/big:high");
});

test("timeouts: the role limit is written, a lower foreman value kept, a higher one clamped", () => {
  const cfg = { explorer: { timeoutMinutes: 20 }, builder: { timeoutMinutes: 60 }, reviewer: { timeoutMinutes: 30 } };
  const single: Record<string, unknown> = { agent: "builder", task: "t" };
  applyLaunchTimeouts(single, cfg);
  assert.equal(single.timeoutMs, 3_600_000);
  const lower: Record<string, unknown> = { agent: "explorer", task: "t", timeoutMs: 60_000 };
  applyLaunchTimeouts(lower, cfg);
  assert.equal(lower.timeoutMs, 60_000);
  const higher: Record<string, unknown> = { agent: "explorer", task: "t", maxRuntimeMs: 9_999_999 };
  applyLaunchTimeouts(higher, cfg);
  assert.deepEqual(higher, { agent: "explorer", task: "t", timeoutMs: 1_200_000 });
  const tasks: Record<string, unknown> = { tasks: [{ agent: "explorer", task: "a" }, { agent: "reviewer", task: "b" }] };
  applyLaunchTimeouts(tasks, cfg);
  assert.equal(tasks.timeoutMs, 1_800_000);
  const chain: Record<string, unknown> = { chain: [{ agent: "builder" }, { parallel: [{ agent: "explorer", task: "x" }, { agent: "reviewer", task: "y" }] }] };
  applyLaunchTimeouts(chain, cfg);
  assert.equal(chain.timeoutMs, 5_400_000);
  const mgmt: Record<string, unknown> = { action: "status", id: "r1" };
  applyLaunchTimeouts(mgmt, cfg);
  assert.equal(mgmt.timeoutMs, undefined);
});

test("timeouts: a foreman value on a call without a role limit is clamped to the largest role limit", () => {
  const cfg = { explorer: { timeoutMinutes: 20 }, builder: { timeoutMinutes: 60 }, overlay: {} };
  const noAgent: Record<string, unknown> = { chain: [{ agent: "builder", task: "x" }, { task: "y" }], timeoutMs: 999_999_999 };
  applyLaunchTimeouts(noAgent, cfg);
  assert.equal(noAgent.timeoutMs, 3_600_000);
  const emptyParallel: Record<string, unknown> = { chain: [{ agent: "explorer" }, { parallel: [] }], maxRuntimeMs: 999_999_999 };
  applyLaunchTimeouts(emptyParallel, cfg);
  assert.deepEqual(emptyParallel, { chain: [{ agent: "explorer" }, { parallel: [] }], timeoutMs: 3_600_000 });
  const lower: Record<string, unknown> = { tasks: [{ agent: "overlay", task: "a" }], timeoutMs: 60_000 };
  applyLaunchTimeouts(lower, cfg);
  assert.equal(lower.timeoutMs, 60_000);
  const none: Record<string, unknown> = { agent: "overlay", task: "t" };
  applyLaunchTimeouts(none, cfg);
  assert.equal(none.timeoutMs, undefined);
});
