// An automatic climb (review_fail / revision relaunch) to a strong rung the rank policy refuses is skipped, not refused: the launch keeps its
// model, the trace is rung_top with RANK_CAPPED_REASON and the launch result says so. An explicit `strong` keyword is still refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { LadderState, RANK_CAPPED_REASON } from "../ladder.ts";
import { applyLaunchModels } from "../launchmodel.ts";
import { planSizing, takeSizing } from "../sizing.ts";
import { ranksOf, rankRefusalFor } from "../ranks.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
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

async function rig(t: Parameters<typeof r11Rig>[0], map: Map_, policy: Policy, key?: boolean, providerRevision?: boolean): Promise<Rig> {
  const roles = { explorer: { model: "fake/explorer" }, reviewer: { model: "fake/reviewer" }, builder: { model: "fake/builder", strong: { model: MAPS[map] } } };
  const base = reviewAllowOpts();
  return r11Rig(t, { default: "standard", revisionRounds: { standard: 1 } }, {
    piExtra: { registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => void commands.set(name, def) },
    ctx: { ...base.ctx, model: { provider: "fake", id: "foreman" } },
    config: { providers: { fake: { review: { model: "m" }, roles, ranks: RANKS, ...(providerRevision ? { strongOnRevision: true } : {}) } }, ladder: { childPolicy: policy, strongOnRevision: true, ...(key === undefined ? {} : { equalOnStrongRisk: key }) } },
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
}

// one config for the cases the plan unit tests below decide per entry (a lower model, the gate, a RUNG_UP report)
test("FAIL revision, explicit lower model + reason, map A + below: launched on that model, not refused", async (t) => {
  const a = await rig(t, "A", "below");
  await built(a);
  const rev = builder({ task: "fix it", model: "fake/lower", reason: "a one-line fix" });
  const { id, res } = await a.launch(rev);
  assert.equal(res, undefined, res?.reason);
  assert.equal(rev.model, "fake/lower");
  assert.deepEqual(refusals(a), []);
  assert.deepEqual(a.events("rung_top").map((r) => [r.model, r.reason]), [["fake/lower", RANK_CAPPED_REASON]]);
  assert.match(texts(await a.started(id, rev, "run-b2")), SKIP);
});

test("finish gate after FAIL, map A + below: no climb_available refusal", async (t) => {
  const a = await rig(t, "A", "below");
  await built(a);
  await settle(a, 3);
  const refused = a.events("finish_refused");
  assert.ok(refused.length > 0);
  assert.deepEqual(refused.filter((r) => r.climb_available === true), []);
});

test("RUNG_UP report, explicit lower model + reason, map B + below: honoured", async (t) => {
  const a = await rig(t, "B", "below");
  await built(a, "RUNG_UP: context\nDone: x", false);
  const next = builder({ task: "go on", model: "fake/lower", reason: "small rest" });
  const { res } = await a.launch(next);
  assert.equal(res, undefined, res?.reason);
  assert.equal(next.model, "fake/lower");
  assert.deepEqual(refusals(a), []);
});

test("FAIL revision with model strong, map B + below: still refused [rank_policy] with the next step", async (t) => {
  const a = await rig(t, "B", "below");
  await built(a);
  const { res } = await a.launch(builder({ task: "fix it", model: "strong" }));
  assert.equal(res?.block, true);
  assert.match(res?.reason ?? "", /rank_policy:below/);
  assert.ok(res?.reason?.includes(NEXT), res?.reason);
});

// no live rung (the first builder launch of a session, or after a reload): the bare FAIL case is the launchPlanned unit below; a chain has no live rung either
test("chain builder -> reviewer -> builder as the first launch of the session, map A + below: both builders on the bottom rung, not refused", async (t) => {
  const a = await rig(t, "A", "below", undefined, true);
  const chain = { chain: [builder(), { agent: "reviewer", task: "review items 1" }, builder({ task: "fix it" })] };
  const { id, res } = await a.launch(chain);
  assert.equal(res, undefined, res?.reason);
  const ch = chain.chain as Record<string, unknown>[];
  assert.deepEqual([ch[0].model, ch[2].model], ["fake/builder", "fake/builder"]);
  assert.deepEqual(refusals(a), []);
  assert.ok(a.events("rung_top").some((r) => r.reason === RANK_CAPPED_REASON));
  assert.match(texts(await a.started(id, chain, "run-c")), SKIP);
});

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
const NEXT = "Relaunch with model \"default\" and a reason to run on the default rung.";
// the context climb: a builder run ends with `RUNG_UP: context`; the relaunch asks for the strong rung, or asks for nothing (the default rung)
const CONTEXT_REPORT = "RUNG_UP: context\nDone: x";
const HANDOFF_START = "[pi-foreman rung-up handoff] The previous builder run run-b stopped (context).";

for (const [map, policy] of CAPPED) {
  test(`RUNG_UP: context, relaunch with model strong, map ${map} + ${policy}: refused [rank_policy:${policy}] and the refusal names the default rung`, async (t) => {
    const a = await rig(t, map, policy);
    await built(a, CONTEXT_REPORT, false);
    const { res } = await a.launch(builder({ task: "go on", model: "strong" }));
    assert.equal(res?.block, true);
    assert.match(res?.reason ?? "", new RegExp(`rank_policy:${policy}`));
    assert.equal(refusals(a).length, 1);
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

// The strong rung is refused by the rank policy, so ladder.ts plan() gives the pending handoff to the default-rung launch (handoffFor); apply() uses it up.
test("RUNG_UP: context, relaunch with model default and a reason, map A + below: launched on the default bottom rung, not refused, the handoff IS prepended once", async (t) => {
  const a = await rig(t, "A", "below");
  await built(a, CONTEXT_REPORT, false);
  const rel = builder({ task: "go on", model: "default", reason: "small rest" });
  const { id, res } = await a.launch(rel);
  assert.equal(res, undefined, res?.reason);
  assert.equal(rel.model, "fake/builder");
  assert.deepEqual(refusals(a), []);
  assert.deepEqual(a.events("rung_up"), []);
  assert.deepEqual(a.events("rung_top").map((r) => [r.role, r.model, r.reason]), [["builder", "fake/builder", RANK_CAPPED_REASON]]);
  assert.match(rel.task as string, /\[end of handoff\]\ngo on\n/);
  assert.ok((rel.task as string).includes(HANDOFF_START), rel.task as string);
  assert.match(texts(await a.started(id, rel, "run-b2")), /the earlier report of the builder run run-b \(context\) was prepended to this launch because the strong rung fake\/foreman is not allowed by the rank policy/);
  // used up: the next relaunch gets none
  const again = builder({ task: "more", model: "default", reason: "small rest" });
  assert.equal((await a.launch(again)).res, undefined);
  assert.doesNotMatch(again.task as string, /rung-up handoff/);
  assert.equal(a.events("rung_top").length, 1);
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
const OPTS = { preferStrong: true, revisionReason: "review_fail" as const, ranks: ranksOf({ providers: { fake: { ranks: RANKS } } }) };

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

test("plan: an explicit lower model is capped too when the strong rung is forbidden, and rises when it is allowed", () => {
  for (const [allowed, event] of [[false, "rung_top"], [true, "rung_up"]] as const) {
    const l = new LadderState();
    const e: Record<string, unknown> = { agent: "builder", task: "t", model: "fake/lower", reason: "small" };
    const p = l.plan(e, ROLES, { ...OPTS, strongAllowed: () => allowed });
    assert.equal(p.block, undefined);
    assert.equal(l.apply(p.climbs, () => [])[0].event, event);
    assert.equal(e.model, allowed ? "strong" : "fake/lower");
  }
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

// plan units (no spawn): the pending handoff and a refused strong rung
const pendingRoles = (): LadderState => {
  const l = new LadderState();
  l.noteLaunched({ agent: "builder", model: "fake/builder" });
  l.eligible.set("builder", { role: "builder", runId: "run-b", cause: "context", summary: "Done: x", resultPath: null } as never);
  return l;
};

test("plan: strong rung refused, a default-rung launch gets the handoff once, a refused launch keeps it", () => {
  const l = pendingRoles();
  const e: Record<string, unknown> = { agent: "builder", task: "go on" };
  const p = l.plan(e, ROLES, { strongAllowed: () => false });
  assert.equal(p.climbs.length, 1);
  assert.equal(p.climbs[0].handoffFor, "fake/foreman");
  assert.ok(l.eligible.has("builder")); // nothing used up before apply: a launch refused by a later check keeps it
  assert.deepEqual(l.apply(p.climbs, () => []), [{ event: "rung_top", role: "builder", model: "fake/builder", reason: RANK_CAPPED_REASON }]);
  assert.match(e.task as string, /^\[pi-foreman rung-up handoff\]/);
  assert.match(e.task as string, /\ngo on$/);
  assert.ok(!l.eligible.has("builder"));
  const next: Record<string, unknown> = { agent: "builder", task: "again" };
  assert.deepEqual(l.plan(next, ROLES, { strongAllowed: () => false }).climbs, []);
  assert.equal(next.task, "again");
});

test("plan: strong rung allowed, a default-rung launch gets no handoff and it stays pending; so with no strong rung mapped", () => {
  const l = pendingRoles();
  const e: Record<string, unknown> = { agent: "builder", task: "go on", model: "default", reason: "small" };
  assert.deepEqual(l.plan(e, ROLES, { strongAllowed: () => true }).climbs, []);
  assert.equal(e.task, "go on");
  assert.ok(l.eligible.has("builder"));
  const none = pendingRoles();
  assert.deepEqual(none.plan({ agent: "builder", task: "t" }, { builder: { model: "fake/builder" } }, { strongAllowed: () => false }).climbs, []);
  assert.ok(none.eligible.has("builder"));
  // the strong launch still takes it
  const s: Record<string, unknown> = { agent: "builder", task: "go on", model: "strong" };
  const p = l.plan(s, ROLES, { strongAllowed: () => true });
  l.apply(p.climbs, () => []);
  assert.match(s.task as string, /^\[pi-foreman rung-up handoff\]/);
});

test("plan: a capped FAIL climb carries the handoff in its own climb, one trace event; several builder entries all get it", () => {
  const l = pendingRoles();
  const e: Record<string, unknown> = { agent: "builder", task: "fix" };
  const p = l.plan(e, ROLES, { ...OPTS, strongAllowed: () => false });
  assert.equal(p.climbs.length, 1);
  assert.equal(p.climbs[0].skipped, "fake/foreman");
  assert.equal(p.climbs[0].handoffFor, "fake/foreman");
  assert.equal(l.apply(p.climbs, () => []).length, 1);
  assert.match(e.task as string, /^\[pi-foreman rung-up handoff\]/);
  const m = pendingRoles();
  const list = [{ agent: "builder", task: "a" }, { agent: "builder", task: "b" }] as Record<string, unknown>[];
  m.apply(m.plan({ tasks: list }, ROLES, { strongAllowed: () => false }).climbs, () => []);
  assert.deepEqual(list.map((x) => (x.task as string).startsWith("[pi-foreman rung-up handoff]")), [true, true]); // as a strong launch does today
});

// plan + applyLaunchModels: a capped entry never gets the strong rung or its thinking level (no spawn)
const TROLES = { builder: { model: "fake/builder", strong: { model: "fake/foreman", thinking: "high" } } };

/** plan() then applyLaunchModels() the way index.ts runs them; `live` is the builder's live model, `allowed` the rank decision per entry. */
function launchPlanned(input: Record<string, unknown>, live: string | null, allowed: (e: Record<string, unknown>) => boolean): void {
  const l = new LadderState();
  if (live) l.noteLaunched({ agent: "builder", model: live });
  const p = l.plan(input, TROLES, { ...OPTS, strongAllowed: allowed });
  applyLaunchModels(input, TROLES, undefined, { ...OPTS, capped: new Set(p.climbs.filter((c) => c.skipped).map((c) => c.entry)), explicit: () => true });
}

test("capped bare launch with no live rung: the bottom rung, not the strong one", () => {
  const capped: Record<string, unknown> = { agent: "builder", task: "t" };
  launchPlanned(capped, null, () => false);
  assert.equal(capped.model, "fake/builder");
  const open: Record<string, unknown> = { agent: "builder", task: "t" };
  launchPlanned(open, null, () => true);
  assert.equal(open.model, "fake/foreman:high");
});

test("capped bare launch keeps the live rung's thinking level, not the strong rung's", () => {
  const capped: Record<string, unknown> = { agent: "builder", task: "t" };
  launchPlanned(capped, "fake/builder:low", () => false);
  assert.equal(capped.model, "fake/builder:low");
});

test("capped explicit model keeps the level it would get without a climb", () => {
  const capped: Record<string, unknown> = { agent: "builder", task: "t", model: "fake/lower:medium", reason: "small" };
  launchPlanned(capped, "fake/builder", () => false);
  assert.equal(capped.model, "fake/lower:medium");
});

test("tasks and chain: only the capped entries stay below the strong rung", () => {
  const entries = (): Record<string, unknown>[] => [{ agent: "builder", task: "a" }, { agent: "builder", task: "b" }, { agent: "builder", task: "c", model: "strong", reason: "hard" }];
  for (const key of ["tasks", "chain"] as const) {
    const list = entries();
    launchPlanned({ [key]: list }, null, (e) => e.task !== "a");
    assert.deepEqual(list.map((e) => e.model), ["fake/builder", "fake/foreman:high", "fake/foreman:high"]);
  }
  const par = entries();
  launchPlanned({ chain: [{ parallel: par }] }, null, (e) => e.task === "b");
  assert.deepEqual(par.map((e) => e.model), ["fake/builder", "fake/foreman:high", "fake/foreman:high"]);
});

// model "default" on a heavy tier after a FAIL: the keyword keeps the bottom rung (heavy would otherwise pick strong); no spawn
test("heavy tier, FAIL revision, model default with a reason: plan and applyLaunchModels keep the bottom rung", () => {
  const l = new LadderState();
  l.noteLaunched({ agent: "builder", model: "fake/builder" });
  const e: Record<string, unknown> = { agent: "builder", task: "t", model: "default", reason: "small rest" };
  const p = l.plan(e, TROLES, { ...OPTS, tier: "heavy", strongAllowed: () => true });
  assert.equal(p.block, undefined);
  applyLaunchModels(e, TROLES, undefined, { ...OPTS, tier: "heavy", capped: new Set(), explicit: () => true });
  assert.equal(e.model, "fake/builder");
  assert.deepEqual(p.climbs, []);
});

// sizing: model "default" with a reason is an override, not refused, even when the sizing target is the strong rung; the rung stays the bottom one
test("sizing target strong, model default with a reason: not refused, no climb, the bottom rung kept", (t) => {
  const root = fs.realpathSync(mkTestTmp("pf-relaunch-rank-"));
  t.after(() => rmTestTmp(root));
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, "big.py"), "x\n".repeat(1700));
  const roles = { builder: { model: "fake/builder", strong: { model: "fake/foreman" } } };
  const e: Record<string, unknown> = { agent: "builder", task: "t", model: "default", reason: "tiny edit", size: { files: ["big.py"] } };
  const t1 = takeSizing(e);
  const p = planSizing(e, t1.entries, t1.carried, { config: undefined, roles, ranks: OPTS.ranks, cwd: root, tier: "standard", revisionClimb: true, top: null });
  assert.equal(p.block, undefined);
  assert.equal(p.plans[0].target, "strong");
  assert.deepEqual(p.plans[0].combo.note, ["explicit", "override"]);
  assert.equal(p.climbs.size, 0);
  assert.equal(e.model, "default");
});

// The shipped claude-bridge presets under an Opus foreman: what a builder launch does with ladder.equalOnStrongRisk on
const PRESET = (name: string): Record<string, any> => JSON.parse(fs.readFileSync(new URL(`../../../config/presets/${name}.json`, import.meta.url), "utf8"));
const OPUS = "claude-bridge/claude-opus-5-5";
const SONNET = "claude-bridge/claude-sonnet-5-5";
const bridgeRig = (t: Parameters<typeof r11Rig>[0], name: string): Promise<Rig> =>
  r11Rig(t, { default: "standard", revisionRounds: { standard: 1 } }, { ctx: { ...reviewAllowOpts().ctx, model: { provider: "claude-bridge", id: "claude-opus-5-5" } }, config: PRESET(name) });

for (const name of ["claude-bridge", "claude-bridge-sonnet-reviewer"]) {
  test(`${name}: sets ladder.equalOnStrongRisk true`, () => {
    assert.equal(PRESET(name).ladder.equalOnStrongRisk, true);
  });
}

test("claude-bridge preset, Opus foreman: a launch without a model and with a strong-risk tag runs on Opus (rank_equal_model)", async (t) => {
  const a = await bridgeRig(t, "claude-bridge");
  const input = builder({ risk: ["security"] });
  const { id, res } = await a.launch(input);
  assert.equal(res, undefined, res?.reason);
  assert.equal(String(input.model).split(":")[0], OPUS);
  assert.equal(a.events("rank_equal_model").length, 1);
  assert.match(texts(await a.started(id, input, "run-1")), /builder runs on the foreman's own model claude-bridge\/claude-opus-5-5 \(ladder\.equalOnStrongRisk, risk: security\)\./);
});

test("claude-bridge preset, Opus foreman, tier heavy, no model and no risk tag: the bare launch picks Opus and the rank policy refuses it", () => {
  const preset = PRESET("claude-bridge");
  const roles = preset.providers["claude-bridge"].roles;
  const input: Record<string, unknown> = builder();
  applyLaunchModels(input, roles, undefined, { tier: "heavy", provider: "claude-bridge", explicit: () => false });
  assert.equal(String(input.model).split(":")[0], OPUS);
  const no = rankRefusalFor(preset, OPUS, String(input.model).split(":")[0], ["builder"]);
  // pinned, not changed: no risk tag means the equalOnStrongRisk tie does not apply, so the heavy-tier default (the strong rung) is refused
  assert.equal(no?.message, 'pi-foreman: launch refused [rank_policy:below]: child model claude-bridge/claude-opus-5-5 (tier 1) is not below the foreman model claude-bridge/claude-opus-5-5 (tier 1). Add a ranks entry for it, map the role to a lower-ranked model, or set ladder.childPolicy to "any" in the user or overlay config.');
});

test("claude-bridge preset, Opus foreman, after a reviewer FAIL: a bare relaunch is capped on Sonnet, one with a strong-risk tag climbs to Opus", async (t) => {
  const a = await bridgeRig(t, "claude-bridge");
  await built(a);
  const plain = builder({ task: "fix it" });
  const { id, res } = await a.launch(plain);
  assert.equal(res, undefined, res?.reason);
  assert.equal(plain.model, `${SONNET}:medium`);
  assert.deepEqual(a.events("rung_top").map((r) => [r.model, r.reason]), [[SONNET, RANK_CAPPED_REASON]]);
  assert.match(texts(await a.started(id, plain, "run-b2")), /the climb of builder to its strong rung claude-bridge\/claude-opus-5-5 was skipped: the rank policy \(below\)/);
  // pinned, not changed: the risk tag lets the climb run on the foreman's own model
  assert.deepEqual(refusals(a), []);
  const risky = builder({ task: "fix it", risk: ["security"] });
  const r4 = await a.launch(risky);
  assert.equal(r4.res, undefined, r4.res?.reason);
  assert.equal(risky.model, `${OPUS}:medium`);
  assert.equal(a.events("rank_equal_model").length, 1);
  assert.deepEqual(a.events("rung_up").map((r) => [r.from, r.to, r.reason]), [[SONNET, OPUS, "review_fail"]]);
  assert.equal(a.events("rung_top").length, 1); // only the plain relaunch's
});
