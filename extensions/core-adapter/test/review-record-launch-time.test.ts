// D117 revision: a review record's time is the reviewer's launch time, not the time its run ended.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewRecord } from "../reviews.ts";
import { tick, world } from "./_r46world.ts";

test("a review record carries the launch time of its reviewer", async (t) => {
  const w = world(t, { realSnapshot: true });
  const a = await w.adapter("startup");
  const before = Date.now();
  const r = await a.reviewLaunch("[pre-pr] review the branch");
  assert.ok(!r.blocked, r.blocked ?? "");
  await tick(400);
  const endedAfter = Date.now();
  a.endRun(r.id, "Overall verdict: PASS");
  for (let i = 0; i < 200 && (await a.recordedReviews()) < 1; i++) await tick(50);
  await tick(100);
  const recs = ((w.ceremonyEntries().at(-1)?.data ?? {}) as { reviews?: ReviewRecord[] }).reviews ?? [];
  const at = recs.at(-1)?.at;
  assert.ok(typeof at === "number" && at >= before && at < endedAfter - 300, `at ${at} is the launch time`);
});
