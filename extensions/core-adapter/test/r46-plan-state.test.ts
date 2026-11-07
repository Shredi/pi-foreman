// R46 items 2 and 3: plan approval and the plan-review lineages persist in a `pi-foreman-ceremony-state` session entry
// (keyed on the plan version hash) and survive /reload and resume; a ruling-plan.md approval restores; an Addendum after
// approval does not void it; the plan-review loop has no count cap (the loop guard stops a repeated FAIL).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { planChanged, planRequired, tick, world } from "./_r46world.ts";

const ADDENDUM = "\n## Addendum 1: a ruling\nGo ahead.\n";

test("dialog approval survives /reload and resume; an Addendum after approval does not void it; a body edit after reload gives plan_changed", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  assert.ok(planRequired(await a.launch("builder")));
  assert.equal(await a.review("PASS"), null);
  assert.equal((await a.checkpoint()).decision, "approve");
  assert.equal(await a.launch("builder"), undefined);
  const entry = w.ceremonyEntries().at(-1)!.data as { plan: { status: string; hash: string; source: string } };
  assert.equal(entry.plan.status, "approved");
  assert.equal(entry.plan.hash, w.hash());
  assert.equal(entry.plan.source, "dialog");
  await a.down();
  fs.appendFileSync(w.planFile, ADDENDUM);
  assert.equal(w.hash(), entry.plan.hash, "an Addendum keeps the version");
  const b = await w.adapter("reload");
  assert.equal(await b.launch("builder"), undefined, "approval restored after /reload");
  assert.match((await b.checkpoint()).text, /already approved/);
  await b.down();
  const c = await w.adapter("resume");
  assert.equal(await c.launch("builder"), undefined, "and after resume");
  fs.appendFileSync(w.planFile, "\nOne more step.\n"); // the body above... after the Addendum is still appendix: edit the body instead
  fs.writeFileSync(w.planFile, fs.readFileSync(w.planFile, "utf8").replace("Ship it.", "Ship it twice."));
  assert.ok(planChanged(await c.launch("builder")), "a body edit after the reload");
});

test("a fork restores no approval; a body edit while the session was down restores none either", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  assert.equal(await a.review("PASS"), null);
  assert.equal((await a.checkpoint()).decision, "approve");
  await a.down();
  const f = await w.adapter("fork");
  assert.ok(planRequired(await f.launch("builder")));
  await f.down();
  fs.writeFileSync(w.planFile, fs.readFileSync(w.planFile, "utf8").replace("Ship it.", "Ship it twice."));
  const b = await w.adapter("reload");
  assert.ok(planRequired(await b.launch("builder")));
});

test("approval through ruling-plan.md restores without a ctime check, only while the file still reads APPROVED", async (t) => {
  const w = world(t, { handoff: true, parent: true });
  const a = await w.adapter("startup");
  assert.equal(await a.review("PASS"), null);
  w.rule("ruling-plan.md", "APPROVED\n");
  assert.equal((await a.checkpoint()).decision, "approve");
  assert.equal((w.ceremonyEntries().at(-1)!.data as { plan: { source: string } }).plan.source, "ruling-plan");
  await a.down();
  await tick();
  fs.appendFileSync(w.planFile, ADDENDUM); // newer than the verdict: the old ctime binding would void it
  const b = await w.adapter("reload");
  assert.equal(await b.launch("builder"), undefined);
  await b.down();
  w.rule("ruling-plan.md", "REVISE change the goal\n");
  const c = await w.adapter("reload");
  assert.ok(planRequired(await c.launch("builder")), "the verdict file no longer reads APPROVED");
});

test("round-state.json restore accepts ruling-plan.md when the session entry holds no approval", async (t) => {
  const w = world(t, { handoff: true, parent: true });
  const a = await w.adapter("startup");
  assert.equal(await a.review("PASS"), null);
  w.rule("ruling-plan.md", "APPROVED\n");
  assert.equal((await a.checkpoint()).decision, "approve");
  await a.down();
  w.entries.length = 0; // the entry is gone: only round-state.json is left
  const b = await w.adapter("reload");
  assert.equal(await b.launch("builder"), undefined);
});

test("plan-review lineages survive /reload: FAIL, reload, revised FAIL opens the checkpoint after 2 rounds", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  assert.equal(await a.review("FAIL"), null);
  const first = await a.checkpoint();
  assert.equal(first.decision, "refused");
  assert.match(first.text, /plan_revision_required/);
  assert.match(first.text, /body above the appendix/);
  await a.down();
  fs.writeFileSync(w.planFile, fs.readFileSync(w.planFile, "utf8").replace("Ship it.", "Ship it twice."));
  const b = await w.adapter("reload");
  assert.equal(await b.review("FAIL"), null);
  assert.equal((await b.checkpoint()).decision, "approve", "round 2 of 2: the checkpoint opens whatever the verdict (the dialog answers approve)");
  assert.ok(w.notes.some((m) => /Plan review: FAIL after 2 of 2 rounds/.test(m)));
});

test("an identical state appends no second entry", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  assert.equal(await a.review("PASS"), null);
  await a.checkpoint();
  const n = w.ceremonyEntries().length;
  await a.checkpoint();
  await a.checkpoint();
  assert.equal(w.ceremonyEntries().length, n);
  const last = w.ceremonyEntries().at(-1)!.data as Record<string, unknown>;
  assert.equal(last.v, 1);
  assert.equal(last.planPhase, false);
});

test("no count caps the plan reviews: six [plan-review] runs in a row, across a reload, are all launched", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  for (let i = 0; i < 4; i++) assert.equal(await a.review("PASS"), null, `review ${i + 1}`);
  await a.down();
  const b = await w.adapter("reload");
  for (let i = 4; i < 6; i++) assert.equal(await b.review("PASS"), null, `review ${i + 1}`);
  assert.equal((await b.checkpoint()).decision, "approve");
  assert.doesNotMatch(w.notes.join("\n"), /review cap/i);
});

test("a plan review that fails twice with the same findings on the same plan stops plan reviews with [review_loop]; an owner prompt lifts it", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  const failing = async (): Promise<string | null> => {
    const r = await a.reviewLaunch();
    if (r.blocked) return r.blocked;
    a.endRun(r.id, "1. FAIL: the goal is vague\nOverall verdict: FAIL");
    await tick(400);
    return null;
  };
  assert.equal(await failing(), null);
  assert.equal(await failing(), null);
  assert.match((await failing()) ?? "", /\[review_loop\]/);
  await a.ownerPrompt();
  assert.equal(await failing(), null);
});
