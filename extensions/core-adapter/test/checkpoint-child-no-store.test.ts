// No approval travels from a parent to a child, also not through the approval store: a heavy child (handoff dir and parent set) that
// shares the parent's scratch dir finds there another plan file with an owner approval in the store. The store keeps no session or plan
// path, so a session with a handoff dir never restores from it; its own dialog approval comes back from its ceremony-state entry only,
// and only while its plan is unchanged. A session without a handoff dir restores from the store: checkpoint-reload.test.ts ("reload: a
// human approval comes back from the store, no second dialog; an edited plan needs a new one").
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { planVersionHash, saveStored } from "../checkpoint.ts";
import { PLAN, planChanged, planRequired, sharedWorld } from "./_r46world.ts";
import type { Block } from "./_r46world.ts";

const planPhase = (r: Block): boolean => r?.block === true && /\[launch_refused:plan_phase\]/.test(r.reason ?? "");

/** The parent's plan beside the child's in the shared scratch dir, approved by the owner (in the parent's session) in the store. */
const parentApproved = sharedWorld({ handoff: true, parent: true }, async (w) => {
  const other = path.join(path.dirname(w.planFile), "plan-parentwork.md");
  const bytes = PLAN.replace("# Widget", "# Parent work");
  fs.writeFileSync(other, bytes);
  assert.ok(saveStored(path.join(w.project, "..", "agent"), planVersionHash(Buffer.from(bytes)), "parentwork", { approval: { at: new Date().toISOString(), by: "user" } }));
});

test("heavy child without plan-first: the owner's approval of the parent's plan in the store opens no builder, not after a reload or a resume", async () => {
  const w = await parentApproved();
  const a = await w.adapter("startup");
  assert.ok(planRequired(await a.launch("builder")), "before the reload");
  await a.down();
  const b = await w.adapter("reload");
  assert.ok(planRequired(await b.launch("builder")), "after a reload");
  await b.down();
  const c = await w.adapter("resume");
  assert.ok(planRequired(await c.launch("builder")), "after a resume");
});

test("heavy child with plan-first: the same store approval stays out (builder refused by the plan phase, nothing restored)", async () => {
  const w = await parentApproved();
  process.env.PI_FOREMAN_PLAN_PHASE = "1";
  try {
    const a = await w.adapter("startup");
    assert.ok(planPhase(await a.launch("builder")), "before the reload");
    await a.down();
    const b = await w.adapter("reload");
    assert.ok(planPhase(await b.launch("builder")), "after a reload");
    await b.down();
    const c = await w.adapter("resume");
    assert.ok(planPhase(await c.launch("builder")), "after a resume");
    // the owner ends the phase: the heavy gate still wants the child's own approval, none came back from the store
    await c.command("foreman", "plan off");
    assert.ok(planRequired(await c.launch("builder")), "after /foreman plan off");
  } finally {
    delete process.env.PI_FOREMAN_PLAN_PHASE;
  }
});

test("heavy child: its own dialog approval survives a reload from its session entry, and is gone after an edit of its plan", async () => {
  const w = await parentApproved();
  const a = await w.adapter("startup");
  assert.equal(await a.review("PASS"), null);
  assert.equal((await a.checkpoint()).decision, "approve");
  assert.equal(await a.launch("builder"), undefined);
  await a.down();
  const b = await w.adapter("reload");
  assert.equal(await b.launch("builder"), undefined, "the own dialog approval came back");
  await b.down();
  fs.appendFileSync(w.planFile, "\nOne more step.\n");
  const c = await w.adapter("reload");
  const r = await c.launch("builder");
  assert.ok(planRequired(r) || planChanged(r), `the parent's approval does not fill in: ${JSON.stringify(r)}`);
});
