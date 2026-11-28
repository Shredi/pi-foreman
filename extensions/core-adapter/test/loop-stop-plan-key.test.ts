// D226: a loop stop belongs to one plan. A plan-review launch for a new plan path in the same worktree starts clean;
// the same plan keeps the stop; the stop survives its persisted form with the plan path, and an old state without it loads.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { stopApplies, type LoopStop } from "../reviewloop.ts";
import { buildCeremonyState, latestCeremonyState } from "../planstate.ts";
import { PLAN, tick, world } from "./_r46world.ts";
import type { RecSpec } from "./_verdict-rig.ts";

const STOP: LoopStop = { rule: "repeat", kind: "plan", sig: ["txt:the goal is vague"], plan: "/ws/plan-a.html" };

test("stopApplies: same plan or no plan on either side applies; another plan does not", () => {
  assert.equal(stopApplies(STOP, "/ws/plan-a.html"), true);
  assert.equal(stopApplies(STOP, "/ws/plan-b.html"), false);
  assert.equal(stopApplies(STOP, null), true);
  const { plan: _plan, ...old } = STOP;
  assert.equal(stopApplies(old, "/ws/plan-b.html"), true, "a stop with no plan (an old state) applies as before");
});

test("the plan path of a stop is persisted and read back; a state without it loads as no plan", () => {
  const entry = buildCeremonyState({ plan: null, lineages: [], planPhase: false, loopStop: STOP });
  const saved = (e: unknown): unknown[] => [{ type: "custom", customType: "pi-foreman-ceremony-state", data: JSON.parse(JSON.stringify(e)) }];
  assert.deepEqual(latestCeremonyState(saved(entry))?.loopStop, STOP);
  const old = JSON.parse(JSON.stringify(entry));
  delete old.loopStop.plan;
  assert.equal(latestCeremonyState(saved(old))?.loopStop?.plan, undefined);
});

const FAIL1: RecSpec = { verdict: "fail", findings: [{ kind: "defect", text: "the goal is vague", file: "plan.md", line: 1, class: "off-by-one" }] };
const FAIL2: RecSpec = { verdict: "fail", findings: [{ kind: "defect", text: "the scope is unclear", file: "plan.md", line: 20, class: "off-by-one" }] };
const isLoop = (s: string | null): boolean => /\[review_loop\]/.test(s ?? "");

test("a plan-review launch for a new plan path is not refused by the stop of another plan; the same plan stays refused", async (t) => {
  const w = world(t, { handoff: true, parent: true });
  const a = await w.adapter("startup");
  let rounds = 0;
  const until = async (what: string, cond: () => Promise<boolean>): Promise<void> => {
    const end = Date.now() + 10_000;
    while (!(await cond())) {
      assert.ok(Date.now() < end, `${what} within 10 s`);
      await tick(25);
    }
  };
  const review = async (spec: RecSpec, task?: string): Promise<string | null> => {
    const r = await a.reviewLaunch(task);
    if (r.blocked) return r.blocked;
    const want = ++rounds;
    a.endRunRecord(r.id, spec);
    await until(`plan review ${want} was recorded`, async () => (await w.traceEvents()).filter((e) => e.event === "plan_review").length >= want);
    return null;
  };
  assert.equal(await review(FAIL1), null);
  assert.equal(await review(FAIL1), null);
  await until("the loop stop is set", async () => (await w.traceEvents()).some((e) => e.event === "review_loop"));
  assert.ok(isLoop(await review(FAIL1)), "the same plan is refused");
  const other = path.join(path.dirname(w.planFile), "plan-gadget.md");
  fs.writeFileSync(other, PLAN.replace("Widget", "Gadget"));
  assert.equal(await review(FAIL2, "[plan-review] review .workflow/scratch/plan-gadget.md"), null, "a new plan path starts clean");
  assert.ok(isLoop(await review(FAIL1)), "the first plan still has its stop");
});
