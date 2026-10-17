// R11 item 1 (P1a): a review_fail rung_up never lowers the provider rank: the target is max(current, strong).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ABOVE_STRONG_REASON, LadderState } from "../ladder.ts";
import { applyLaunchModels, splitLevel } from "../launchmodel.ts";
import { ranksOf } from "../ranks.ts";

const OPUS = "anthropic/claude-opus-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const HAIKU = "anthropic/claude-haiku-5-5";
const CONFIG = { providers: { anthropic: { ranks: [{ match: "claude-opus-*", tier: 0 }, { match: "claude-sonnet-*", tier: 1 }, { match: "claude-haiku-*", tier: 2 }] } }, ladder: { childPolicy: "at-or-below" } };
const RANKS = ranksOf(CONFIG);
const OPTS = { preferStrong: true, revisionReason: "review_fail" as const, ranks: RANKS };
// The explicit-model rule of index.ts (ranks.ts explicitModelAllowed) with an opus foreman: every ranked model passes.
const LAUNCH = { preferStrong: true, explicit: () => true };
const base = (m: unknown): string => splitLevel(String(m)).base;

// R10 config: the builder's strong rung is sonnet.
const R10_ROLES = { builder: { model: HAIKU, thinking: "medium", strong: { model: SONNET, thinking: "high" } } };
// Strong rung above sonnet, so a sonnet launch is not already on the strong rung (no rung_top path).
const OPUS_STRONG_ROLES = { builder: { model: HAIKU, thinking: "medium", strong: { model: OPUS, thinking: "high" } } };

test("ladder_review_fail_opus_stays_opus", () => {
  // An explicit opus launch on a review_fail revision: stays opus, traced as already above the strong rung.
  const l = new LadderState();
  const input: Record<string, unknown> = { agent: "builder", task: "fix", model: OPUS };
  const p = l.plan(input, R10_ROLES, OPTS);
  assert.equal(p.block, undefined);
  assert.deepEqual(l.apply(p.climbs, () => []), [{ event: "rung_top", role: "builder", model: OPUS, reason: ABOVE_STRONG_REASON }]);
  applyLaunchModels(input, R10_ROLES, "high", LAUNCH);
  assert.equal(base(input.model), OPUS);
  assert.equal(ABOVE_STRONG_REASON, "already above strong rung");

  // The live rung is opus and the revision passes no model: it stays opus, never lowered to sonnet.
  const l2 = new LadderState();
  l2.noteLaunched({ agent: "builder", model: `${OPUS}:high` });
  const rev: Record<string, unknown> = { agent: "builder", task: "fix" };
  const p2 = l2.plan(rev, R10_ROLES, OPTS);
  assert.deepEqual(l2.apply(p2.climbs, () => []), [{ event: "rung_top", role: "builder", model: OPUS, reason: ABOVE_STRONG_REASON }]);
  applyLaunchModels(rev, R10_ROLES, "high", LAUNCH);
  assert.equal(base(rev.model), OPUS);
});

test("ladder_review_fail_sonnet_rises_to_strong", () => {
  // An explicit sonnet launch, strong rung opus: rises to opus.
  const l = new LadderState();
  const input: Record<string, unknown> = { agent: "builder", task: "fix", model: SONNET };
  const p = l.plan(input, OPUS_STRONG_ROLES, OPTS);
  assert.deepEqual(l.apply(p.climbs, () => []), [{ event: "rung_up", role: "builder", from: SONNET, to: OPUS, reason: "review_fail" }]);
  applyLaunchModels(input, OPUS_STRONG_ROLES, "high", LAUNCH);
  assert.equal(base(input.model), OPUS);

  // The live rung is sonnet and the revision passes no model: rises to opus.
  const l2 = new LadderState();
  l2.noteLaunched({ agent: "builder", model: SONNET });
  const rev: Record<string, unknown> = { agent: "builder", task: "fix" };
  const p2 = l2.plan(rev, OPUS_STRONG_ROLES, OPTS);
  assert.deepEqual(l2.apply(p2.climbs, () => []), [{ event: "rung_up", role: "builder", from: SONNET, to: OPUS, reason: "review_fail" }]);
  applyLaunchModels(rev, OPUS_STRONG_ROLES, "high", LAUNCH);
  assert.equal(base(rev.model), OPUS);
});

test("review_fail without ranks keeps the previous climb (no rank, no comparison)", () => {
  const l = new LadderState();
  l.noteLaunched({ agent: "builder", model: OPUS });
  const p = l.plan({ agent: "builder", task: "fix" }, R10_ROLES, { preferStrong: true, revisionReason: "review_fail" });
  assert.deepEqual(l.apply(p.climbs, () => []), [{ event: "rung_up", role: "builder", from: OPUS, to: SONNET, reason: "review_fail" }]);
});
