// The row model of a child run (index.ts onLaunchCall: rowModelOf): single launches, composite launches, an unknown resume, a climb.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChildRuns } from "../runs.ts";
import { applyLaunchModels, rowModelOf } from "../launchmodel.ts";
import { recordUsageLaunch, singleLaunchRole } from "../usage.ts";

const LOW = "anthropic/claude-haiku-5-5";
const MID = "anthropic/claude-sonnet-5-5";
const ROLES = { builder: { model: LOW }, reviewer: { model: MID } };

/** What index.ts passes to onLaunchCall for a call (the binding exists for single launches only). */
function bound(input: Record<string, unknown>): string | null {
  const role = singleLaunchRole(input);
  if (!role) return null;
  return recordUsageLaunch(new Map(), { foremanSession: "f", workspace: "w", role, model: typeof input.model === "string" && input.model ? input.model : null, activeProvider: "anthropic" }).model;
}

test("(a) a single builder launch without an explicit model: the harness-picked model is on the row", () => {
  const input: Record<string, unknown> = { agent: "builder", task: "x" };
  applyLaunchModels(input, ROLES, undefined);
  assert.equal(bound(input), LOW, "the binding already carried it at HEAD");
  assert.equal(rowModelOf(input, bound(input)), LOW);
});

test("(b) a composite launch with a builder: null from the binding at HEAD, the builder's model now", () => {
  const input: Record<string, unknown> = { tasks: [{ agent: "reviewer", task: "r" }, { agent: "builder", task: "b" }] };
  applyLaunchModels(input, ROLES, undefined);
  assert.equal(bound(input), null, "no binding for a composite launch: the row model was null at HEAD");
  assert.equal(rowModelOf(input, null), LOW);
  const chain: Record<string, unknown> = { chain: [{ agent: "reviewer", task: "r" }, { parallel: [{ agent: "builder", task: "b" }] }] };
  applyLaunchModels(chain, ROLES, undefined);
  assert.equal(rowModelOf(chain, null), LOW);
});

test("a composite launch without a builder shows the first role's model; none known stays null", () => {
  const input: Record<string, unknown> = { tasks: [{ agent: "reviewer", task: "r" }] };
  applyLaunchModels(input, ROLES, undefined);
  assert.equal(rowModelOf(input, null), MID);
  assert.equal(rowModelOf({ tasks: [{ agent: "scout", task: "s" }] }, null), null);
});

test("(c) a resume of an unknown run records the model of the resumed launch when known", () => {
  const input = { action: "resume", id: "run9", task: "go on" };
  assert.equal(bound(input), null, "a resume has no binding: null at HEAD");
  assert.equal(rowModelOf(input, null, MID), MID);
  assert.equal(rowModelOf(input, null, null), null);
  const c = new ChildRuns();
  c.onLaunchCall("call2", { launchId: null, role: "", rung: null, model: rowModelOf(input, null, MID) });
  c.onResumed("call2", "run9", "run9", ["builder"], 1000);
  assert.equal(c.views()[0].model, MID);
});

test("a composite launch's row carries the model through onLaunched", () => {
  const input: Record<string, unknown> = { tasks: [{ agent: "builder", task: "b" }, { agent: "reviewer", task: "r" }] };
  applyLaunchModels(input, ROLES, undefined);
  const c = new ChildRuns();
  c.onLaunchCall("call1", { launchId: null, role: "", rung: null, model: rowModelOf(input, null) });
  c.onLaunched("call1", "run1", ["builder", "reviewer"], 1000);
  assert.equal(c.views()[0].model, LOW);
});

test("a ladder climb is a new launch: its row shows the new model, the old row keeps its own", () => {
  const first: Record<string, unknown> = { agent: "builder", task: "x" };
  applyLaunchModels(first, ROLES, undefined);
  const climbed: Record<string, unknown> = { agent: "builder", task: "x" };
  applyLaunchModels(climbed, { builder: { model: LOW, strong: { model: MID } } }, undefined, { preferStrong: true });
  const c = new ChildRuns();
  c.onLaunchCall("c1", { launchId: "L1", role: "builder", rung: "model", model: rowModelOf(first, bound(first)) });
  c.onLaunched("c1", "run1", [], 1000);
  c.onLaunchCall("c2", { launchId: "L2", role: "builder", rung: "model", model: rowModelOf(climbed, bound(climbed)) });
  c.onLaunched("c2", "run2", [], 2000);
  const models = c.views().map((v) => v.model);
  assert.deepEqual(models, [LOW, MID]);
});
