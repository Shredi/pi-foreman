// The child owns its plan (PR 4), below heavy: a plan phase a parent's launch started (PI_FOREMAN_PLAN_PHASE=1 with a handoff dir)
// ends with the session's own plan-review PASS on the current plan version, at a recorded tier below heavy. The origin is stored beside
// `planPhase` in the ceremony-state entry (a restart without the env still knows it; an entry without the field reads as the owner's).
// While such a phase lasts, foreman_checkpoint is refused with a pointer to the plan review (and to foreman_triage without a recorded
// tier); afterwards it is callable. The owner's own `/foreman plan` phase, with or without a parent, is never ended by a PASS. At heavy
// the PASS alone does not open the gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tick, world } from "./_r46world.ts";
import type { Block } from "./_r46world.ts";

const planPhase = (r: Block): boolean => r?.block === true && /\[launch_refused:plan_phase\]/.test(r.reason ?? "");
const byReview = (text: string): boolean => /\[plan_phase_review\]/.test(text) && /until your plan review passes/.test(text);
type A = Awaited<ReturnType<ReturnType<typeof world>["adapter"]>>;
const triage = (a: A, tier: string) => a.tool("foreman_triage")!.execute("tr", { tier, reason: "test" }, undefined, undefined, a.ctx);
const entry = (w: ReturnType<typeof world>) => w.ceremonyEntries().at(-1)!.data as { planPhase: boolean; planPhaseOrigin?: string };
/** The plan-first form (its two headings) and a ledger of this session, so the [plan-review] launch is not refused for either. */
async function ready(w: ReturnType<typeof world>, a: A, ledger = true): Promise<void> {
  if (!fs.readFileSync(w.planFile, "utf8").includes("## Open questions")) fs.appendFileSync(w.planFile, "\n## Decisions and assumptions\nNone.\n\n## Open questions\nNone.\n");
  if (ledger) await a.writeLedger("# Ledger: x\n\n- [ ] 1. item\n"); // a ledger records its tier (source ledger)
}

test("standard child opened plan-first: refused before a PASS, not by a PASS on an edited plan; a PASS on the current version ends the phase, persisted across a reload", async (t) => {
  const w = world(t, { handoff: true, parent: true, ceremony: { default: "standard" } });
  process.env.PI_FOREMAN_PLAN_PHASE = "1";
  const a = await w.adapter("startup");
  await ready(w, a, false);
  assert.equal(entry(w).planPhaseOrigin, "parent", "the origin is stored beside planPhase");
  // without a recorded tier: the checkpoint refusal names foreman_triage, and a PASS does not end the phase
  const untriaged = await a.checkpoint();
  assert.equal(untriaged.decision, "refused");
  assert.ok(byReview(untriaged.text), untriaged.text);
  assert.match(untriaged.text, /foreman_triage/);
  assert.equal(await a.review("PASS"), null);
  assert.ok(planPhase(await a.launch("builder")), "no recorded tier: the PASS leaves the phase on");
  await triage(a, "standard");
  await ready(w, a);
  // before a PASS on this version: builder refused with the plan-review wording, the checkpoint refused and no dialog opens
  fs.writeFileSync(w.planFile, fs.readFileSync(w.planFile, "utf8").replace("Ship it.", "Ship it soon."));
  const before = await a.launch("builder");
  assert.ok(planPhase(before));
  assert.match(before?.reason ?? "", /until your plan review passes/);
  const ctx = a.ctx as { ui: { select: (...x: unknown[]) => Promise<string | undefined> } };
  let asked = 0;
  ctx.ui.select = async () => (asked++, "approve");
  const refused = await a.checkpoint();
  assert.equal(refused.decision, "refused");
  assert.ok(byReview(refused.text));
  assert.doesNotMatch(refused.text, /foreman_triage/, "a recorded tier needs no triage pointer");
  assert.equal(asked, 0, "no owner dialog at standard");
  // the plan changes while the reviewer runs: its PASS is not on the current version
  const run = await a.reviewLaunch();
  assert.equal(run.blocked, null);
  fs.writeFileSync(w.planFile, fs.readFileSync(w.planFile, "utf8").replace("Ship it soon.", "Ship it later."));
  a.endRun(run.id, "Overall verdict: PASS");
  await tick();
  assert.ok(planPhase(await a.launch("builder")), "a PASS on an older version leaves the phase on");
  // a PASS on the current version ends it
  assert.equal(await a.review("PASS"), null);
  assert.equal(planPhase(await a.launch("builder")), false, "builders may launch after the PASS");
  assert.equal(entry(w).planPhase, false, "the exit is persisted");
  assert.ok((await w.traceEvents()).some((e) => e.event === "plan_phase" && e.decision === "off" && e.cause === "plan_review"));
  // after the phase the checkpoint is callable again
  assert.notEqual((await a.checkpoint()).decision, "refused");
  await a.down();
  const b = await w.adapter("reload");
  assert.equal(planPhase(await b.launch("builder")), false, "a reload does not put the phase back");
});

test("a parent-started phase is recognised after a restart without PI_FOREMAN_PLAN_PHASE; an entry without the origin field reads as the owner's", async (t) => {
  const w = world(t, { handoff: true, parent: true, ceremony: { default: "standard" } });
  process.env.PI_FOREMAN_PLAN_PHASE = "1";
  const a = await w.adapter("startup");
  await ready(w, a);
  await triage(a, "standard");
  await a.down();
  delete process.env.PI_FOREMAN_PLAN_PHASE; // a Herdr restart does not bring the env back
  const b = await w.adapter("resume");
  assert.ok(byReview((await b.checkpoint()).text), "still refused after the restart");
  assert.equal(await b.review("PASS"), null);
  assert.equal(planPhase(await b.launch("builder")), false, "and a PASS ends it");
  await b.down();
  // an older entry: plan phase on, no origin field, even with the env set again -> the owner's origin, a PASS does not end it
  process.env.PI_FOREMAN_PLAN_PHASE = "1";
  const old: Record<string, unknown> = { ...(w.ceremonyEntries().at(-1)!.data as Record<string, unknown>), planPhase: true };
  delete old.planPhaseOrigin;
  w.entries.push({ type: "custom", customType: "pi-foreman-ceremony-state", data: old });
  const c = await w.adapter("reload");
  w.state.answer = undefined; // the owner does not answer: an approval would end the phase
  assert.equal(byReview((await c.checkpoint()).text), false, "the checkpoint is not refused for the review");
  assert.equal(await c.review("PASS"), null);
  assert.ok(planPhase(await c.launch("builder")), "a PASS does not end a phase of the owner's origin");
});

test("a PASS never ends the owner's /foreman plan phase: without a parent, and inside a child", async (t) => {
  for (const o of [{}, { handoff: true, parent: true }]) {
    const w = world(t, { ...o, ceremony: { default: "standard" } });
    delete process.env.PI_FOREMAN_PLAN_PHASE;
    const a = await w.adapter("startup");
    await triage(a, "standard");
    await a.command("foreman", "plan");
    await ready(w, a);
    assert.equal(entry(w).planPhaseOrigin, undefined, "the owner's origin");
    assert.equal(await a.review("PASS"), null);
    assert.ok(planPhase(await a.launch("builder")), `${JSON.stringify(o)}: the PASS leaves the owner's phase on`);
    const r = await a.checkpoint();
    assert.equal(byReview(r.text), false, "the checkpoint is callable in the owner's phase");
    await a.down();
  }
});

test("the owner's /foreman plan inside a parent-started phase makes the phase the owner's: a PASS on the current version then does not end it", async (t) => {
  const w = world(t, { handoff: true, parent: true, ceremony: { default: "standard" } });
  process.env.PI_FOREMAN_PLAN_PHASE = "1";
  const a = await w.adapter("startup");
  await ready(w, a);
  await triage(a, "standard");
  assert.equal(entry(w).planPhaseOrigin, "parent", "a parent's launch started the phase");
  await a.command("foreman", "plan");
  assert.equal(entry(w).planPhase, true);
  assert.equal(entry(w).planPhaseOrigin, undefined, "the owner's origin now");
  assert.equal(await a.review("PASS"), null);
  assert.ok(planPhase(await a.launch("builder")), "the PASS leaves the owner's phase on");
  assert.equal(entry(w).planPhase, true, "no exit is persisted");
});

test("heavy child opened plan-first: the PASS alone does not open the gate; the owner's checkpoint does", async (t) => {
  const w = world(t, { handoff: true, parent: true });
  process.env.PI_FOREMAN_PLAN_PHASE = "1";
  const a = await w.adapter("startup");
  await ready(w, a);
  await triage(a, "heavy");
  assert.equal(await a.review("PASS"), null);
  assert.ok(planPhase(await a.launch("builder")), "heavy: the PASS leaves the phase on");
  const r = await a.checkpoint();
  assert.equal(r.decision, "approve", r.text);
  assert.equal(await a.launch("builder"), undefined);
});
