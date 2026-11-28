// The round state file carries the session's plan phase (round-state.json `planPhase`), so the parent's idle-at-plan notice is sent only
// for a child really in its plan phase: written at a plan-first start, rewritten when the phase ends (plan-review PASS below heavy,
// checkpoint approval, `/foreman plan off`).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROUND_STATE_FILE, planWait } from "../roundstate.ts";
import { world } from "./_r46world.ts";

const file = (w: ReturnType<typeof world>) => JSON.parse(fs.readFileSync(path.join(w.handoff, ROUND_STATE_FILE), "utf8")) as { planPhase?: boolean };
type A = Awaited<ReturnType<ReturnType<typeof world>["adapter"]>>;
const triage = (a: A, tier: string) => a.tool("foreman_triage")!.execute("tr", { tier, reason: "test" }, undefined, undefined, a.ctx);

async function ready(w: ReturnType<typeof world>, a: A): Promise<void> {
  fs.appendFileSync(w.planFile, "\n## Decisions and assumptions\nNone.\n\n## Open questions\nNone.\n");
  await a.writeLedger("# Ledger: x\n\n- [ ] 1. item\n");
}

test("a plan-first start writes planPhase true; the plan-review PASS below heavy rewrites it false", async (t) => {
  const w = world(t, { handoff: true, parent: true, ceremony: { default: "standard" } });
  process.env.PI_FOREMAN_PLAN_PHASE = "1";
  const a = await w.adapter("startup");
  assert.equal(file(w).planPhase, true, "written at the start");
  assert.equal(planWait(w.handoff).open, true);
  await ready(w, a);
  await triage(a, "standard");
  assert.equal(await a.review("PASS"), null);
  assert.equal(file(w).planPhase, false, "the exit is on file");
  assert.equal(planWait(w.handoff).open, false);
});

test("a heavy checkpoint approval rewrites planPhase false", async (t) => {
  const w = world(t, { handoff: true, parent: true, ceremony: { default: "heavy" } });
  process.env.PI_FOREMAN_PLAN_PHASE = "1";
  const a = await w.adapter("startup");
  assert.equal(file(w).planPhase, true);
  await ready(w, a);
  await triage(a, "heavy");
  assert.equal(await a.review("PASS"), null);
  assert.equal(file(w).planPhase, true, "heavy: a PASS alone does not end it");
  assert.equal((await a.checkpoint()).decision, "approve");
  assert.equal(file(w).planPhase, false);
});

test("a session not opened plan-first writes planPhase false", async (t) => {
  const w = world(t, { handoff: true, parent: true, ceremony: { default: "standard" } });
  delete process.env.PI_FOREMAN_PLAN_PHASE;
  const a = await w.adapter("startup");
  await a.ownerPrompt();
  assert.equal(file(w).planPhase, false);
  assert.equal(planWait(w.handoff).open, false);
});
