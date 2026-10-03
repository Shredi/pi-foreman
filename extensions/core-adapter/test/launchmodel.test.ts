import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLaunchModels, launchModel } from "../launchmodel.ts";

const ROLES = {
  explorer: { model: "p1/small", thinking: "low" },
  builder: { model: "p1/mid", thinking: "medium" },
  reviewer: { model: "p1/big", thinking: null },
};

test("no foreman model: the mapped model and thinking are set", () => {
  const input: Record<string, unknown> = { agent: "explorer", task: "t" };
  assert.deepEqual(applyLaunchModels(input, ROLES, "high"), []);
  assert.equal(input.model, "p1/small:low");
});

test("foreman level is kept, provider and model come from the map", () => {
  const input: Record<string, unknown> = { agent: "explorer", task: "t", model: ":medium" };
  assert.deepEqual(applyLaunchModels(input, ROLES, "high"), []);
  assert.equal(input.model, "p1/small:medium");
  assert.equal(launchModel("explorer", ROLES, "p1/small:high", "high")?.model, "p1/small:high");
});

test("foreman level above maxThinking is clamped", () => {
  assert.equal(launchModel("builder", ROLES, ":max", "high")?.model, "p1/mid:high");
  assert.equal(launchModel("builder", ROLES, ":xhigh", undefined)?.model, "p1/mid:xhigh");
});

test("a differing foreman model is replaced and reported", () => {
  const input: Record<string, unknown> = { agent: "builder", task: "t", model: "p2/other:low" };
  assert.deepEqual(applyLaunchModels(input, ROLES, "high"), [{ role: "builder", model: "p1/mid" }]);
  assert.equal(input.model, "p1/mid:low");
});

test("tasks and chain entries each get their role's model; top-level model is dropped", () => {
  const input: Record<string, unknown> = {
    model: "p2/x",
    tasks: [{ agent: "explorer", task: "a" }, { agent: "builder", task: "b" }],
  };
  const flagged = applyLaunchModels(input, ROLES, "high");
  assert.deepEqual(input, { tasks: [{ agent: "explorer", task: "a", model: "p1/small:low" }, { agent: "builder", task: "b", model: "p1/mid:medium" }] });
  assert.deepEqual(flagged, [{ role: "explorer", model: "p1/small" }, { role: "builder", model: "p1/mid" }]);

  const chain: Record<string, unknown> = { chain: [{ agent: "explorer" }, { parallel: [{ agent: "reviewer", task: "x" }, { agent: "builder", task: "y" }] }] };
  assert.deepEqual(applyLaunchModels(chain, ROLES, "high"), []);
  assert.deepEqual(chain, {
    chain: [{ agent: "explorer", model: "p1/small:low" }, { parallel: [{ agent: "reviewer", task: "x", model: "p1/big" }, { agent: "builder", task: "y", model: "p1/mid:medium" }] }],
  });
});

test("thinking null gives no suffix; management calls are untouched", () => {
  assert.equal(launchModel("reviewer", ROLES, undefined, "high")?.model, "p1/big");
  const mgmt: Record<string, unknown> = { action: "status", id: "r1", model: "p9/z" };
  assert.deepEqual(applyLaunchModels(mgmt, ROLES, "high"), []);
  assert.equal(mgmt.model, "p9/z");
});
