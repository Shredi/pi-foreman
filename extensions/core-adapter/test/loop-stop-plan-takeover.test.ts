// D226: a resume or takeover of the same work keeps the loop stop: a second adapter over the same session entries
// still refuses a plan-review launch for the same plan path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tick, world } from "./_r46world.ts";
import type { RecSpec } from "./_verdict-rig.ts";

const FAIL1: RecSpec = { verdict: "fail", findings: [{ kind: "defect", text: "the goal is vague", file: "plan.md", line: 1, class: "off-by-one" }] };
const isLoop = (s: string | null): boolean => /\[review_loop\]/.test(s ?? "");

test("after a takeover (a new adapter over the same session entries) the same plan keeps its loop stop", async (t) => {
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
  const review = async (rig: typeof a, spec: RecSpec): Promise<string | null> => {
    const r = await rig.reviewLaunch();
    if (r.blocked) return r.blocked;
    const want = ++rounds;
    rig.endRunRecord(r.id, spec);
    await until(`plan review ${want} was recorded`, async () => (await w.traceEvents()).filter((e) => e.event === "plan_review").length >= want);
    return null;
  };
  assert.equal(await review(a, FAIL1), null);
  assert.equal(await review(a, FAIL1), null);
  await until("the loop stop is set", async () => (await w.traceEvents()).some((e) => e.event === "review_loop"));
  assert.ok(isLoop(await review(a, FAIL1)), "the stop applies before the takeover");
  await a.down();
  const taken = await w.adapter("resume");
  assert.ok(isLoop(await review(taken, FAIL1)), "the same plan path keeps the stop after the takeover");
});
