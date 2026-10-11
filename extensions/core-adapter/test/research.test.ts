import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLaunchModels } from "../launchmodel.ts";
import { applyFactCriticalRungs, applyResearchFloor, factCriticalRung, markedEntries, researchMarkerOf, researchTraces } from "../research.ts";
import { sanitizeTrace } from "../trace.ts";

const ROLES = {
  explorer: { model: "p/m-haiku", strong: { model: "p/m-sonnet", thinking: "medium" } },
  reviewer: { model: "p/m-haiku", strong: { model: "p/m-sonnet" } },
  builder: { model: "p/m-haiku", strong: { model: "p/m-opus", thinking: "high" } },
};
const RANKS = { providers: { p: { ranks: [{ match: "m-opus*", tier: 1 }, { match: "m-sonnet*", tier: 2 }, { match: "m-haiku*", tier: 3 }] } } };

function launch(input: Record<string, unknown>, config: Record<string, unknown> = RANKS, roles: Record<string, Record<string, unknown>> = ROLES, max: unknown = "high") {
  applyLaunchModels(input, roles, max);
  const marked = markedEntries(input);
  applyResearchFloor(marked, roles, config, max, undefined);
  applyFactCriticalRungs(marked, roles, config, max, undefined);
  return marked;
}

test("markers: case-insensitive, fact-critical wins over research", () => {
  assert.equal(researchMarkerOf("see [Research] now"), "research");
  assert.equal(researchMarkerOf("[RESEARCH] [fact-critical]"), "fact-critical");
  assert.equal(researchMarkerOf("plain"), null);
});

test("[research] floor: the bottom rung becomes the strong rung, in every entry shape", () => {
  const single: Record<string, unknown> = { agent: "explorer", task: "[research] look it up" };
  launch(single);
  assert.equal(single.model, "p/m-sonnet:medium");
  const chain = { chain: [{ agent: "explorer", task: "x" }, { parallel: [{ agent: "explorer", task: "[research] y" }] }] };
  launch(chain);
  assert.deepEqual([(chain.chain[0] as any).model, (chain.chain[1] as any).parallel[0].model], ["p/m-haiku", "p/m-sonnet:medium"]);
});

test("[research] on a model already as strong or stronger changes nothing", () => {
  const roles = { ...ROLES, builder: { model: "p/m-opus", strong: { model: "p/m-sonnet" } } };
  const input: Record<string, unknown> = { agent: "builder", task: "[research] x" };
  applyLaunchModels(input, roles, "high");
  applyResearchFloor(markedEntries(input), roles, RANKS, "high", undefined);
  assert.equal(input.model, "p/m-opus");
});

test("[fact-critical] chain: factCriticalRung, then the security rung, then the strong rung", () => {
  const own = { ...RANKS, ladder: { research: { factCriticalRung: "p/m-opus:max" }, reviewerClimb: { securityRung: "p/m-sonnet" } } };
  assert.equal(factCriticalRung(own, ROLES, "explorer"), "p/m-opus:max");
  assert.equal(factCriticalRung({ ladder: { reviewerClimb: { securityRung: "p/m-sec" } } }, ROLES, "explorer"), "p/m-sec");
  const dflt = factCriticalRung(RANKS, ROLES, "explorer"); // default security rung: next rank above the reviewer's strong rung
  assert.equal(dflt, "p/m-opus:high");
  assert.equal(factCriticalRung({}, ROLES, "explorer"), "p/m-sonnet:medium");
});

test("[fact-critical] level is capped by maxThinking and childMaxThinking", () => {
  const input: Record<string, unknown> = { agent: "explorer", task: "[fact-critical] q" };
  const config = { ...RANKS, ladder: { research: { factCriticalRung: "p/m-opus:max" } } };
  applyLaunchModels(input, ROLES, "high");
  const marked = markedEntries(input);
  applyFactCriticalRungs(marked, ROLES, config, "high", "medium");
  assert.equal(input.model, "p/m-opus:medium");
});

test("research_rung trace carries role, marker and the final model; marker is a trace field", () => {
  const input: Record<string, unknown> = { agent: "explorer", task: "[fact-critical] q" };
  const marked = launch(input, { ladder: { research: { factCriticalRung: "p/m-opus:high" } } });
  const rec = researchTraces(marked);
  assert.deepEqual(sanitizeTrace(rec[0]), { event: "research_rung", role: "explorer", marker: "fact-critical", kind: "single", model: "p/m-opus" });
});
