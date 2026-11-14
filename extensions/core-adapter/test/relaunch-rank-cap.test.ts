// An automatic climb (review_fail / revision relaunch) to a strong rung the rank policy refuses is skipped, not refused: the launch keeps its
// model, the trace is rung_top with RANK_CAPPED_REASON and the launch result says so. An explicit `strong` keyword is still refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LadderState, RANK_CAPPED_REASON } from "../ladder.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

const FAIL = "Overall verdict: FAIL\n1. the parser drops the last line\n";
// foreman tier 1; `above` tier 0; builder models tier 3
const RANKS = [{ match: "above", tier: 0 }, { match: "foreman", tier: 1 }, { match: "*", tier: 3 }];
// map A: the builder's strong rung is the foreman's own model; map B: it ranks above the foreman
const MAPS = { A: "fake/foreman", B: "fake/above" } as const;
type Map_ = keyof typeof MAPS;
type Policy = "below" | "at-or-below";
type Rig = Awaited<ReturnType<typeof r11Rig>>;

const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();

async function rig(t: Parameters<typeof r11Rig>[0], map: Map_, policy: Policy, key?: boolean): Promise<Rig> {
  const roles = { explorer: { model: "fake/explorer" }, reviewer: { model: "fake/reviewer" }, builder: { model: "fake/builder", strong: { model: MAPS[map] } } };
  const base = reviewAllowOpts();
  return r11Rig(t, { default: "standard", revisionRounds: { standard: 1 } }, {
    piExtra: { registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => void commands.set(name, def) },
    ctx: { ...base.ctx, model: { provider: "fake", id: "foreman" } },
    config: { providers: { fake: { review: { model: "m" }, roles, ranks: RANKS } }, ladder: { childPolicy: policy, strongOnRevision: true, ...(key === undefined ? {} : { equalOnStrongRisk: key }) } },
  });
}

const builder = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ agent: "builder", task: "build it", ...extra });
const refusals = (a: Rig): Record<string, unknown>[] => a.events("launch_refused").filter((r) => r.reason === "rank_policy");

/** A builder run, then a reviewer that ends with FAIL (no reviewer when `review` is false). */
async function built(a: Rig, summary = "built", review = true): Promise<void> {
  const b = builder();
  const l = await a.launch(b);
  assert.equal(l.res, undefined, l.res?.reason);
  await a.started(l.id, b, "run-b");
  a.end({ runId: "run-b", agent: "builder", status: "completed", success: true, summary });
  if (!review) return;
  const r = { agent: "reviewer", task: "review items 1" };
  const first = await a.launch(r);
  assert.equal(first.res, undefined, first.res?.reason);
  await a.started(first.id, r, "run-r1");
  a.end({ runId: "run-r1", agent: "reviewer", status: "completed", success: true, output: FAIL });
}

/** The finish gate's settles (the first is the stop guard's reminder); a recorded tier makes the gate run. */
async function settle(a: Rig, n: number): Promise<void> {
  await commands.get("ceremony")!.handler("standard", a.ctx);
  for (let i = 0; i < n; i++) await a.fire("agent_before_settle", { outcome: "completed", entries: [] });
}

const texts = (res: unknown): string => ((res as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");
const SKIP = /the climb of builder to its strong rung fake\/(foreman|above) was skipped: the rank policy \((below|at-or-below)\) does not allow that model for the builder under the foreman fake\/foreman/;

// the capped cases: A + below, B + below, B + at-or-below
const CAPPED: [Map_, Policy][] = [["A", "below"], ["B", "below"], ["B", "at-or-below"]];

for (const [map, policy] of CAPPED) {
  test(`FAIL revision, bare launch, map ${map} + ${policy}: stays on the live rung, not refused, rung_top and a launch line`, async (t) => {
    const a = await rig(t, map, policy);
    await built(a);
    const rev = builder({ task: "fix it" });
    const { id, res } = await a.launch(rev);
    assert.equal(res, undefined, res?.reason);
    assert.equal(rev.model, "fake/builder");
    assert.deepEqual(refusals(a), []);
    assert.deepEqual(a.events("rung_top").map((r) => [r.role, r.model, r.reason]), [["builder", "fake/builder", RANK_CAPPED_REASON]]);
    assert.deepEqual(a.events("rung_up"), []);
    assert.match(texts(await a.started(id, rev, "run-b2")), SKIP);
  });

  test(`FAIL revision, explicit lower model + reason, map ${map} + ${policy}: launched on that model, not refused`, async (t) => {
    const a = await rig(t, map, policy);
    await built(a);
    const rev = builder({ task: "fix it", model: "fake/lower", reason: "a one-line fix" });
    const { id, res } = await a.launch(rev);
    assert.equal(res, undefined, res?.reason);
    assert.equal(rev.model, "fake/lower");
    assert.deepEqual(refusals(a), []);
    assert.deepEqual(a.events("rung_top").map((r) => [r.model, r.reason]), [["fake/lower", RANK_CAPPED_REASON]]);
    assert.match(texts(await a.started(id, rev, "run-b2")), SKIP);
  });

  test(`FAIL revision, explicit lower model without reason, map ${map} + ${policy}: kept as well`, async (t) => {
    const a = await rig(t, map, policy);
    await built(a);
    const rev = builder({ task: "fix it", model: "fake/lower" });
    assert.equal((await a.launch(rev)).res, undefined);
    assert.equal(rev.model, "fake/lower");
    assert.deepEqual(refusals(a), []);
  });

  test(`finish gate after FAIL, map ${map} + ${policy}: no climb_available refusal`, async (t) => {
    const a = await rig(t, map, policy);
    await built(a);
    await settle(a, 3);
    const refused = a.events("finish_refused");
    assert.ok(refused.length > 0);
    assert.deepEqual(refused.filter((r) => r.climb_available === true), []);
  });

  test(`RUNG_UP report, explicit lower model + reason, map ${map} + ${policy}: honoured`, async (t) => {
    const a = await rig(t, map, policy);
    await built(a, "RUNG_UP: context\nDone: x", false);
    const next = builder({ task: "go on", model: "fake/lower", reason: "small rest" });
    const { res } = await a.launch(next);
    assert.equal(res, undefined, res?.reason);
    assert.equal(next.model, "fake/lower");
    assert.deepEqual(refusals(a), []);
  });

  test(`RUNG_UP report, model "strong", map ${map} + ${policy}: still refused [rank_policy]`, async (t) => {
    const a = await rig(t, map, policy);
    await built(a, "RUNG_UP: context\nDone: x", false);
    const { res } = await a.launch(builder({ task: "go on", model: "strong" }));
    assert.equal(res?.block, true);
    assert.match(res?.reason ?? "", new RegExp(`rank_policy:${policy}`));
    assert.equal(refusals(a).length, 1);
  });

  test(`FAIL revision with model "strong", map ${map} + ${policy}: still refused [rank_policy]`, async (t) => {
    const a = await rig(t, map, policy);
    await built(a);
    const { res } = await a.launch(builder({ task: "fix it", model: "strong" }));
    assert.equal(res?.block, true);
    assert.match(res?.reason ?? "", new RegExp(`rank_policy:${policy}`));
  });
}

// map A + at-or-below: the strong rung is allowed, the climb happens
test("FAIL revision, bare launch, map A + at-or-below: climbs to the foreman's own model", async (t) => {
  const a = await rig(t, "A", "at-or-below");
  await built(a);
  const rev = builder({ task: "fix it" });
  const { id, res } = await a.launch(rev);
  assert.equal(res, undefined, res?.reason);
  assert.equal(rev.model, "fake/foreman");
  assert.deepEqual(a.events("rung_up").map((r) => [r.from, r.to, r.reason]), [["fake/builder", "fake/foreman", "review_fail"]]);
  assert.doesNotMatch(texts(await a.started(id, rev, "run-b2")), /was skipped/);
});

test("FAIL revision, explicit lower model, map A + at-or-below: still rises to the strong rung", async (t) => {
  const a = await rig(t, "A", "at-or-below");
  await built(a);
  const rev = builder({ task: "fix it", model: "fake/lower", reason: "a one-line fix" });
  assert.equal((await a.launch(rev)).res, undefined);
  assert.equal(rev.model, "fake/foreman");
  assert.deepEqual(a.events("rung_top"), []);
});

test("finish gate after FAIL, map A + at-or-below: the climb is still offered", async (t) => {
  const a = await rig(t, "A", "at-or-below");
  await built(a);
  await settle(a, 3);
  assert.ok(a.events("finish_refused").some((r) => r.climb_available === true));
});

// equalOnStrongRisk: the cap and the rank loop decide alike
test("equalOnStrongRisk on, map A + below, strong-risk tag: the loop allows the strong rung, so the climb is not capped", async (t) => {
  const a = await rig(t, "A", "below", true);
  await built(a);
  const rev = builder({ task: "fix it", risk: ["guard", "security"] });
  const { res } = await a.launch(rev);
  assert.equal(res, undefined, res?.reason);
  assert.equal(rev.model, "fake/foreman");
  assert.equal(a.events("rank_equal_model").length, 1);
  assert.deepEqual(a.events("rung_top").filter((r) => r.reason === RANK_CAPPED_REASON), []);
});

test("equalOnStrongRisk on, map A + below, no risk tag: capped like with the key off", async (t) => {
  const a = await rig(t, "A", "below", true);
  await built(a);
  const rev = builder({ task: "fix it" });
  assert.equal((await a.launch(rev)).res, undefined);
  assert.equal(rev.model, "fake/builder");
  assert.deepEqual(a.events("rank_equal_model"), []);
  assert.equal(a.events("rung_top").length, 1);
});

// a refused `strong` keyword names the next step; a refused explicit model does not
const NEXT = "Relaunch without a model to run on the default rung.";

for (const [map, policy] of [["A", "below"], ["B", "below"], ["B", "at-or-below"]] as [Map_, Policy][]) {
  test(`model "strong" refused, map ${map} + ${policy}: the refusal names the next step in one clause`, async (t) => {
    const a = await rig(t, map, policy);
    await built(a, "RUNG_UP: context\nDone: x", false);
    const { res } = await a.launch(builder({ task: "go on", model: "strong" }));
    assert.equal(res?.block, true);
    assert.match(res?.reason ?? "", new RegExp(`rank_policy:${policy}`));
    assert.ok(res?.reason?.includes(NEXT), res?.reason);
  });
}

test("explicit forbidden model refused, below: the refusal does not name the next step", async (t) => {
  // the builder's mapped model is the forbidden one, so the explicit model is kept as written and refused by the rank loop
  const a = await r11Rig(t, { default: "standard", revisionRounds: { standard: 1 } }, {
    ctx: { ...reviewAllowOpts().ctx, model: { provider: "fake", id: "foreman" } },
    config: { providers: { fake: { review: { model: "m" }, roles: { explorer: { model: "fake/explorer" }, reviewer: { model: "fake/reviewer" }, builder: { model: "fake/above" } }, ranks: RANKS } }, ladder: { childPolicy: "below" } },
  });
  const { res } = await a.launch({ agent: "builder", task: "build it", model: "fake/above" });
  assert.equal(res?.block, true);
  assert.match(res?.reason ?? "", /rank_policy:below/);
  assert.ok(!res?.reason?.includes(NEXT), res?.reason);
});

// the context climb: a builder run ends with `RUNG_UP: context`; the relaunch asks for the strong rung, or asks for nothing (the default rung)
const CONTEXT_REPORT = "RUNG_UP: context\nDone: x";
const HANDOFF_START = "[pi-foreman rung-up handoff] The previous builder run run-b stopped (context).";

test("RUNG_UP: context, relaunch with model strong, map A + below: refused [rank_policy:below] and the refusal names the default rung", async (t) => {
  const a = await rig(t, "A", "below");
  await built(a, CONTEXT_REPORT, false);
  const { res } = await a.launch(builder({ task: "go on", model: "strong" }));
  assert.equal(res?.block, true);
  assert.match(res?.reason ?? "", /rank_policy:below/);
  assert.ok(res?.reason?.includes(NEXT), res?.reason);
});

test("RUNG_UP: context, relaunch without a model, map A + below: launched on the builder's default bottom rung, not refused", async (t) => {
  const a = await rig(t, "A", "below");
  await built(a, CONTEXT_REPORT, false);
  const rel = builder({ task: "go on" });
  const { res } = await a.launch(rel);
  assert.equal(res, undefined, res?.reason);
  assert.equal(rel.model, "fake/builder");
  assert.deepEqual(refusals(a), []);
  assert.deepEqual(a.events("rung_up"), []);
  assert.deepEqual(a.events("rung_top"), []);
});

// Code path: ladder.ts plan() gives no climb for a keyword-less launch without preferStrong (the context climb sets none), so apply() never
// prepends the pending handoff (ladder.ts apply, index.ts `climbs.length > 0`); the handoff stays in LadderState.eligible for a later strong launch.
test("RUNG_UP: context, relaunch without a model on the default rung: the ended run's handoff is NOT prepended to the task", async (t) => {
  const a = await rig(t, "A", "below");
  await built(a, CONTEXT_REPORT, false);
  const rel = builder({ task: "go on" });
  assert.equal((await a.launch(rel)).res, undefined);
  assert.match(rel.task as string, /\ngo on\n/); // the task text is there (the adapter's own roots and scratch blocks wrap it)
  assert.doesNotMatch(rel.task as string, /rung-up handoff|Previous report/);
});

test("RUNG_UP: context, relaunch with model strong, map A + at-or-below: launched on the strong rung with the handoff prepended", async (t) => {
  const a = await rig(t, "A", "at-or-below");
  await built(a, CONTEXT_REPORT, false);
  const rel = builder({ task: "go on", model: "strong" });
  const { res } = await a.launch(rel);
  assert.equal(res, undefined, res?.reason);
  assert.equal(rel.model, "fake/foreman");
  assert.ok((rel.task as string).startsWith(HANDOFF_START), rel.task as string);
  assert.match(rel.task as string, /\[end of handoff\]\ngo on\n/);
  assert.deepEqual(a.events("rung_up").map((r) => [r.from, r.to, r.reason]), [["fake/builder", "fake/foreman", "context"]]);
});

// LadderState.plan units
const ROLES = { builder: { model: "fake/builder", strong: { model: "fake/foreman" } } };
const OPTS = { preferStrong: true, revisionReason: "review_fail" as const };

test("plan: strongAllowed false caps a bare launch; true or absent keeps the climb", () => {
  for (const reason of ["review_fail", "revision"] as const) {
    const l = new LadderState();
    l.noteLaunched({ agent: "builder", model: "fake/builder" });
    const bare: Record<string, unknown> = { agent: "builder", task: "t" };
    const p = l.plan(bare, ROLES, { preferStrong: true, revisionReason: reason, strongAllowed: () => false });
    assert.deepEqual(l.apply(p.climbs, () => []), [{ event: "rung_top", role: "builder", model: "fake/builder", reason: RANK_CAPPED_REASON }]);
    assert.equal(p.climbs[0].skipped, "fake/foreman");
    assert.equal(bare.model, "fake/builder");
    const up = l.plan({ agent: "builder", task: "t" }, ROLES, { preferStrong: true, revisionReason: reason, strongAllowed: () => true });
    assert.deepEqual(l.apply(up.climbs, () => []), [{ event: "rung_up", role: "builder", from: "fake/builder", to: "fake/foreman", reason }]);
  }
  const l = new LadderState();
  assert.equal(l.apply(l.plan({ agent: "builder", task: "t" }, ROLES, OPTS).climbs, () => [])[0].event, "rung_up");
});

test("plan: the strong keyword and strong_no_reason ignore strongAllowed", () => {
  const l = new LadderState();
  const kw: Record<string, unknown> = { agent: "builder", task: "t", model: "strong" };
  const p = l.plan(kw, ROLES, { ...OPTS, strongAllowed: () => false });
  assert.equal(p.block, undefined);
  assert.equal(kw.model, "strong");
  assert.equal(p.climbs[0].reason, "review_fail");
  assert.match(new LadderState().plan({ agent: "builder", task: "t", model: "strong" }, ROLES, { strongAllowed: () => false }).block ?? "", /strong_no_reason/);
});
