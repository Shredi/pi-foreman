// Shared setup of the loop-guard tests over the r46 world: drive a session into a `loopStop` (two FAIL code reviews with the same findings).
import assert from "node:assert/strict";
import { tick } from "./_r46world.ts";
import type { world } from "./_r46world.ts";
import type { r11Rig } from "./_r11rig.ts";

export type Adapter = Awaited<ReturnType<ReturnType<typeof world>["adapter"]>>;
type Res = { block?: boolean; reason?: string } | null | undefined;

export const FAIL_REPORT = "1. FAIL: the guard is missing\nOverall verdict: FAIL";
export const loopRefused = (r: Res | string): boolean => /\[review_loop\]/.test(typeof r === "string" ? r : (r && "reason" in r ? r.reason : "") ?? "");

/** One code review (no `[plan-review]` tag) that starts and ends with `report`; returns the refusal text, or null once it ran. */
export async function codeReview(a: Adapter, report: string, n = 1): Promise<string | null> {
  const r = await a.reviewLaunch(`review items ${n} of the diff`);
  if (r.blocked) return r.blocked;
  const before = await a.recordedReviews();
  a.endRun(r.id, report);
  // the review record is written after git reads of the checkout (slow on Windows): wait for it, loop check included
  const end = Date.now() + 10_000;
  while ((await a.recordedReviews()) <= before) {
    assert.ok(Date.now() < end, "the review round was not recorded within 10 s");
    await tick(25);
  }
  return null;
}

type Rig = Awaited<ReturnType<typeof r11Rig>>;
let runs = 0;
/** The same stop over an r11Rig session: two FAIL reviews with the same findings around a builder launch. */
export async function rigStop(a: Rig): Promise<void> {
  for (const [n, agent] of [[1, "reviewer"], [0, "builder"], [2, "reviewer"]] as const) {
    const input = agent === "builder" ? { agent, task: "fix item 1" } : { agent, task: `review items ${n}` };
    const l = await a.launch(input);
    assert.equal(l.res, undefined, `${agent} ${n}`);
    if (agent === "builder") continue;
    const runId = `loop-run-${++runs}`;
    await a.started(l.id, input, runId);
    a.end({ runId, agent, status: "completed", success: true, results: [{ agent, status: "completed", success: true, output: FAIL_REPORT }] });
    await tick(400);
  }
  assert.equal(a.events("review_loop").length, 1, "the stop is set");
}

/** FAIL, builder, FAIL with the same findings: the second FAIL sets the stop. */
export async function stopLoop(a: Adapter): Promise<void> {
  assert.equal(await codeReview(a, FAIL_REPORT, 1), null);
  assert.equal(await a.launch("builder"), undefined, "the builder is allowed before the stop");
  assert.equal(await codeReview(a, FAIL_REPORT, 2), null);
}
