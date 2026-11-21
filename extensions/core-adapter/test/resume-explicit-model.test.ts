// D150: a resume of a run that was launched with an explicit, rank-allowed `model` is kept while the model stays allowed; a run on the role map's model keeps
// today's check against the map (launchpolicy.test.ts), and an explicit model the policy no longer allows is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordLaunch, subagentActionCheck } from "../actions.ts";
import type { ActionContext, RunRegistry } from "../actions.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

const ROLES = { builder: { model: "p1/big", tools: ["read", "bash", "edit", "write"] } };
const ctx = (runs: RunRegistry, over: Partial<ActionContext> = {}): ActionContext => ({ allowWorkflow: false, runs, allowed: ["builder"], resolution: { provider: "p1", roles: ROLES, source: "cli" }, maxThinking: "high", ...over });

test("recordLaunch keeps the explicit flag only when the launch says so; a resume inherits it", () => {
  const runs: RunRegistry = new Map();
  recordLaunch(runs, { agent: "builder", task: "t", model: "p1/lower:low" }, { runId: "r1" }, false, true);
  recordLaunch(runs, { agent: "builder", task: "t", model: "p1/big" }, { runId: "r2" }, false);
  assert.deepEqual(runs.get("r1"), { role: "builder", model: "p1/lower", explicitModel: true });
  assert.deepEqual(runs.get("r2"), { role: "builder", model: "p1/big" });
  recordLaunch(runs, { action: "resume", id: "r1", message: "m" }, { runId: "r3" }, false);
  assert.deepEqual(runs.get("r3"), { role: "builder", model: "p1/lower", explicitModel: true });
});

test("resume of an explicit-model run: allowed while the rank policy allows it, refused once it does not; the map-derived run is still checked against the map", () => {
  const runs: RunRegistry = new Map();
  recordLaunch(runs, { agent: "builder", task: "t", model: "p1/lower" }, { runId: "r1" }, false, true);
  recordLaunch(runs, { agent: "builder", task: "t", model: "p1/lower" }, { runId: "r2" }, false);
  const resume = (id: string, c: ActionContext) => subagentActionCheck({ action: "resume", id, message: "go on" }, c).block ?? "";
  assert.equal(resume("r1", ctx(runs, { explicitAllowed: (role, m) => role === "builder" && m === "p1/lower" })), "");
  assert.match(resume("r1", ctx(runs, { explicitAllowed: () => false })), /ran on p1\/lower, an explicit model that the rank policy no longer allows for builder; launch a fresh builder instead/);
  assert.match(resume("r1", ctx(runs)), /no longer allows/, "no policy callback: refused");
  assert.match(resume("r2", ctx(runs, { explicitAllowed: () => true })), /ran on p1\/lower, the role map now gives p1\/big/);
});

const RANKS = [{ match: "foreman", tier: 1 }, { match: "builder", tier: 3 }, { match: "lower", tier: 3 }];

test("adapter: a builder launched with an explicit allowed model resumes; one on the mapped model resumes as before", async (t) => {
  const roles = { explorer: { model: "fake/explorer" }, reviewer: { model: "fake/reviewer" }, builder: { model: "fake/builder" } };
  const base = reviewAllowOpts();
  const ui = { notify: () => undefined, confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined };
  const a = await r11Rig(t, { default: "standard" }, { ctx: { ...base.ctx, ui, model: { provider: "fake", id: "foreman" } }, config: { providers: { fake: { review: { model: "m" }, roles, ranks: RANKS } } } });
  const explicit = { agent: "builder", task: "build it", model: "fake/lower", reason: "a one-line fix" };
  const first = await a.launch(explicit);
  assert.equal(first.res, undefined, first.res?.reason);
  assert.equal(explicit.model, "fake/lower");
  await a.started(first.id, explicit, "run-x1");
  const resumed = await a.launch({ action: "resume", id: "run-x1", message: "go on" });
  assert.equal(resumed.res, undefined, resumed.res?.reason);
  const plain = { agent: "builder", task: "build it" };
  const second = await a.launch(plain);
  assert.equal(second.res, undefined, second.res?.reason);
  await a.started(second.id, plain, "run-x2");
  const again = await a.launch({ action: "resume", id: "run-x2", message: "go on" });
  assert.equal(again.res, undefined, again.res?.reason);
});
