import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ChildLadder, childMaxTurns, LadderState, revisionClimb, strongAbove } from "../ladder.ts";
import { applyLaunchModels } from "../launchmodel.ts";
import { explicitModelAllowed, rankRefusal, rankRefusalFor, rolePolicy } from "../ranks.ts";
import { cliModelOf, foremanModelSpec } from "../session.ts";
import { checkLaunch, hasSecurityFinding, initialRounds, onReviewDone } from "../rounds.ts";
import { sanitizeTrace, TRACE_FIELDS } from "../trace.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const readJson = (p: string) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const REFUSAL = "strong launch of builder refused [strong_no_reason]: pass `reason` as an extra top-level field";
const ROLES = { builder: { model: "p/small", thinking: "medium", strong: { model: "p/big", thinking: "medium" } } };

test("5a: a strong launch without reason is refused with the literal text; with an extra top-level reason it is accepted", () => {
  const refused = new LadderState().plan({ agent: "builder", task: "t", model: "strong" }, ROLES);
  assert.ok(refused.block?.includes(REFUSAL), refused.block);
  const input: Record<string, unknown> = { agent: "builder", task: "t", model: "strong", reason: "needs a deeper refactor" };
  const ok = new LadderState().plan(input, ROLES);
  assert.equal(ok.block, undefined);
  assert.equal(ok.climbs[0].reason, "foreman");
  assert.equal("reason" in input, false, "the extra field is removed before the tool sees it");
});

test("5a: a climb-eligible handoff allows a strong launch with no reason", () => {
  const st = new LadderState();
  st.onLaunch("c1", "builder", true);
  st.onLaunched("c1", "run1");
  st.onRunEnd({ runId: "run1", summary: "RUNG_UP: context\nDone: x", resultPath: null } as never);
  assert.equal(st.plan({ agent: "builder", task: "t", model: "strong" }, ROLES).block, undefined);
});

test("5b: strongOnRevision climbs a builder revision after a FAIL; without it nothing climbs", () => {
  const on = { ladder: { strongOnRevision: true } };
  assert.equal(revisionClimb(on, "p", true), "review_fail");
  assert.equal(revisionClimb({ ladder: { strongOnRevision: false } }, "p", true), null);
  assert.equal(revisionClimb(on, "p", false), null);
});

test("5b: revision_security_exempt alone lifts only the revision cap, not the rung", () => {
  assert.equal(hasSecurityFinding("verdict: FAIL\nSECURITY: path traversal"), true);
  const failed = onReviewDone({ ...initialRounds(), built: true, reviewOpen: true }, "fail", true);
  const r = checkLaunch(failed, [["builder"]], "standard", { standard: 1 });
  assert.equal(r.block, undefined);
  assert.equal(r.exempt, 1);
  assert.equal(revisionClimb({ ladder: { strongOnRevision: false } }, "p", true), null, "the exemption does not climb by itself");
  assert.equal(revisionClimb({ ladder: { strongOnRevision: true } }, "p", true), "review_fail");
});

test("5c: the claude-bridge presets put Sonnet on the bottom rung of explorer, builder and reviewer", () => {
  for (const f of ["config/presets/claude-bridge.json", "config/presets/claude-bridge-sonnet-reviewer.json"]) {
    const roles = readJson(f).providers["claude-bridge"].roles;
    for (const r of ["explorer", "builder", "reviewer"]) assert.equal(roles[r].model, "claude-bridge/claude-sonnet-5-5", `${f} ${r}`);
    assert.equal(roles.builder.strong.model, "claude-bridge/claude-opus-5-5");
  }
});

const RANKS = { "claude-bridge": { ranks: [{ match: "claude-fable-*", tier: 0 }, { match: "claude-opus-*", tier: 1 }, { match: "claude-sonnet-*", tier: 2 }, { match: "claude-haiku-*", tier: 3 }] } };
const BR = { roles: { explorer: { model: "claude-bridge/claude-haiku-5-5" } } };
const preset = readJson("config/presets/claude-bridge.json");
const cfg = { providers: RANKS, ladder: { rolePolicy: preset.ladder.rolePolicy } };

test("5d: an explicit launch model is honoured when the rank policy allows it", () => {
  const foreman = "claude-bridge/claude-opus-5-5";
  const input: Record<string, unknown> = { agent: "explorer", task: "t", model: "claude-bridge/claude-sonnet-5-5" };
  const out = applyLaunchModels(input, BR.roles, "high", { explicit: (role, m) => explicitModelAllowed(cfg, foreman, m, role) });
  assert.equal(input.model, "claude-bridge/claude-sonnet-5-5");
  assert.deepEqual(out.overrides, []);
  // not allowed (above the foreman): replaced by the role map as before
  const up: Record<string, unknown> = { agent: "explorer", task: "t", model: "claude-bridge/claude-fable-5-1" };
  applyLaunchModels(up, BR.roles, "high", { explicit: (role, m) => explicitModelAllowed(cfg, foreman, m, role) });
  assert.equal(up.model, "claude-bridge/claude-haiku-5-5");
  // without the option the role map still wins
  const plain: Record<string, unknown> = { agent: "explorer", task: "t", model: "claude-bridge/claude-sonnet-5-5" };
  applyLaunchModels(plain, BR.roles, "high");
  assert.equal(plain.model, "claude-bridge/claude-haiku-5-5");
});

test("5d: --model at startup counts as user-picked (model-pick path)", () => {
  assert.equal(cliModelOf(["node", "pi", "--model", "p/m"]), "p/m");
  assert.equal(cliModelOf(["node", "pi", "--model=p/m"]), "p/m");
  assert.equal(cliModelOf(["node", "pi"]), undefined);
  assert.equal(foremanModelSpec("p/overlay", undefined, "p/m"), null);
  assert.equal(foremanModelSpec("p/overlay", undefined, undefined), "p/overlay");
  assert.equal(foremanModelSpec("p/overlay", "p/s"), null);
});

test("5e: the default explorer strongAbove is 200000, other roles 100000", () => {
  const d = readJson("config/foreman.defaults.json");
  assert.equal(d.roles.explorer.strongAbove, 200000);
  assert.equal(d.ladder.strongAbove, 100000);
  assert.equal(strongAbove({ roles: d.roles, ladder: d.ladder }, undefined, "explorer"), 200000);
  assert.equal(strongAbove({ roles: d.roles, ladder: d.ladder }, undefined, "builder"), 100000);
  const l = new ChildLadder({ strongAbove: 200000, bottom: true });
  assert.equal(l.onUsage({ input: 150000 }), null);
  assert.equal(l.onUsage({ input: 210000 })?.trigger, "context");
});

test("5f: ladder.maxTurns.<role> (builder 100) wins; childMaxTurns is the fallback; child_turn_limit carries the limit", () => {
  const d = readJson("config/foreman.defaults.json");
  assert.equal(childMaxTurns({ ladder: d.ladder }, undefined, "builder"), 100);
  assert.equal(childMaxTurns({ ladder: d.ladder }, undefined, "reviewer"), 60);
  assert.equal(childMaxTurns({ ladder: { childMaxTurns: 9 } }, undefined, "builder"), 9);
  assert.equal(childMaxTurns({ ladder: { childMaxTurns: 9, maxTurns: { builder: 7 } } }, undefined, "builder"), 7);
  const l = new ChildLadder({ maxTurns: 2 });
  l.onUsage({});
  l.onUsage({});
  const steer = l.onUsage({});
  assert.deepEqual([steer?.trigger, steer?.count, steer?.limit], ["turns", 3, 2]);
  assert.ok((TRACE_FIELDS as readonly string[]).includes("limit"));
  assert.deepEqual(sanitizeTrace({ event: "child_turn_limit", role: "builder", turns: 3, limit: 2 }), { event: "child_turn_limit", role: "builder", turns: 3, limit: 2 });
});

test("6b: rolePolicy overrides childPolicy per role", () => {
  const OP = "claude-bridge/claude-opus-5-5";
  assert.equal(rolePolicy(cfg, "reviewer"), "at-or-below");
  assert.equal(rolePolicy(cfg, "explorer"), "below");
  assert.equal(rankRefusalFor(cfg, OP, OP, ["reviewer"]), null, "Opus reviewer allowed under at-or-below when the foreman is Opus");
  const no = rankRefusalFor(cfg, OP, OP, ["builder"]);
  assert.match(no?.message ?? "", /rank_policy:below.*child model claude-bridge\/claude-opus-5-5 \(tier 1\) is not below the foreman model claude-bridge\/claude-opus-5-5 \(tier 1\)/);
  assert.equal(rankRefusal(cfg, OP, OP, "builder")?.policy, "below");
});

test("6b: the explicit model is the model checked, and a sonnet explicit model is not refused for a builder under an Opus foreman", () => {
  const OP = "claude-bridge/claude-opus-5-5";
  assert.equal(explicitModelAllowed(cfg, OP, "claude-bridge/claude-sonnet-5-5", "builder"), true);
  assert.equal(explicitModelAllowed(cfg, OP, OP, "builder"), false);
  assert.equal(explicitModelAllowed({}, OP, "claude-bridge/claude-sonnet-5-5", "builder"), false, "no ranks: the role map decides");
});
