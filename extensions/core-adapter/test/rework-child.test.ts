// The child's receipt of the send-back marker (index.ts reworkScan) in the real adapter, in-process: a marker above the watermark sets sentBack and counts as a
// revision at the next tool call; it is handled once; an item review PASS does not clear it, a [pre-pr] PASS does; a handled marker left on disk never
// sets it again; a reload keeps it and the watermark. The rule side (a forged or stale marker only moves toward draft) is checked on the pure rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeRework } from "../session.ts";
import { reviewFactsOf, readiness } from "../prready.ts";
import type { ReviewRecord } from "../reviews.ts";
import { tick, world } from "./_r46world.ts";

type W = ReturnType<typeof world>;
type State = { sentBack?: boolean; reworkSeen?: number; gate?: { reviewGate: { revised: boolean } } };
const state = (w: W): State => (w.ceremonyEntries().at(-1)?.data ?? {}) as State;
const read = (a: { call: (t: string, i: Record<string, unknown>) => Promise<unknown> }) => a.call("read", { path: "x.txt" });

async function waitReviews(a: { recordedReviews: () => Promise<number> }, n: number): Promise<void> {
  for (let i = 0; i < 100 && (await a.recordedReviews()) < n; i++) await tick(50);
  assert.equal(await a.recordedReviews(), n);
}

test("no marker: no change; a marker sets sentBack and a revision at the next tool call, once", async (t) => {
  const w = world(t, { handoff: true });
  const a = await w.adapter("startup");
  await read(a);
  assert.equal(state(w).sentBack, undefined);
  assert.equal(state(w).reworkSeen, undefined);
  const before = w.ceremonyEntries().length;
  await read(a);
  assert.equal(w.ceremonyEntries().length, before, "nothing recorded without a marker");

  writeRework(w.handoff);
  await read(a);
  assert.equal(state(w).sentBack, true);
  assert.equal(state(w).reworkSeen, 1);
  const after = w.ceremonyEntries().length;
  await read(a);
  await read(a);
  assert.equal(w.ceremonyEntries().length, after, "a handled marker is not handled again");
});

test("markers are their own sequence: a second send-back (a ruling after a higher-numbered brief) is not lost", async (t) => {
  const w = world(t, { handoff: true });
  const a = await w.adapter("startup");
  fs.writeFileSync(path.join(w.handoff, "brief-9.md"), "x");
  writeRework(w.handoff); // rework-1, delivered with brief-9
  await read(a);
  assert.equal(state(w).reworkSeen, 1);
  fs.writeFileSync(path.join(w.handoff, "ruling-2.md"), "x");
  writeRework(w.handoff); // rework-2, delivered with ruling-2
  await read(a);
  assert.equal(state(w).reworkSeen, 2);
  assert.equal(state(w).sentBack, true);
});

test("an item review PASS does not clear it, a [pre-pr] PASS does; a handled marker on disk does not set it again; a reload keeps both", async (t) => {
  const w = world(t, { handoff: true });
  const a = await w.adapter("startup");
  await a.writeLedger("# Ledger\n- [ ] 1. item\n- [ ] V. Verified by a reviewer\n");
  writeRework(w.handoff);
  await read(a);
  assert.equal(state(w).sentBack, true);

  const item = await a.reviewLaunch("review items 1 of the diff");
  assert.ok(!item.blocked, item.blocked ?? "");
  a.endRun(item.id, "Overall verdict: PASS");
  await waitReviews(a, 1);
  await tick(100);
  assert.equal(state(w).sentBack, true, "a review that is not [pre-pr] leaves the send-back");

  await a.down();
  const reload = await w.adapter("reload");
  await read(reload);
  assert.equal(state(w).sentBack, true, "a reload keeps sentBack");
  assert.equal(state(w).reworkSeen, 1, "and the watermark");

  const pre = await reload.reviewLaunch("[pre-pr] review the branch");
  assert.ok(!pre.blocked, pre.blocked ?? "");
  reload.endRun(pre.id, "Overall verdict: PASS");
  await waitReviews(reload, 2); // the trace is the world's: the first review counts too
  await tick(100);
  assert.equal(state(w).sentBack, undefined, "a [pre-pr] PASS clears it");
  assert.equal(state(w).reworkSeen, 1, "the watermark stays");

  await read(reload);
  assert.equal(state(w).sentBack, undefined, "the handled marker still on disk does not set it again");
  await reload.down();
  const again = await w.adapter("reload");
  await read(again);
  assert.equal(state(w).sentBack, undefined, "nor after a reload");

  writeRework(w.handoff); // a new send-back
  await read(again);
  assert.equal(state(w).sentBack, true);
  assert.equal(state(w).reworkSeen, 2);
});

test("the send-back counts as a revision of a reviewed session", async (t) => {
  const w = world(t, { handoff: true });
  const a = await w.adapter("startup");
  await a.writeLedger("# Ledger\n- [ ] 1. item\n- [ ] V. Verified by a reviewer\n");
  const r = await a.reviewLaunch("review items 1 of the diff");
  assert.ok(!r.blocked, r.blocked ?? "");
  a.endRun(r.id, "Overall verdict: PASS");
  await waitReviews(a, 1);
  await tick(100);
  await read(a);
  assert.equal(state(w).gate?.reviewGate.revised, false);
  writeRework(w.handoff);
  await read(a);
  assert.equal(state(w).gate?.reviewGate.revised, true);
});

const rec = (o: Partial<ReviewRecord> = {}): ReviewRecord => ({ role: "reviewer", verdict: "pass", head: "a".repeat(40), kind: "code", occasion: "pre-pr", ...o });
const ruleFor = (facts: ReturnType<typeof reviewFactsOf>) => readiness({ facts, checks: "green", mergeable: true, mergeState: "clean", draft: false });

test("a forged or stale marker only moves toward draft; only a [pre-pr] PASS on the pushed head takes the PR out", () => {
  const head = "a".repeat(40);
  const forged = reviewFactsOf([rec()], head, false, true);
  assert.deepEqual(ruleFor(forged), { result: "wip", draft: true }, "a marker over a PASS: back to draft");
  assert.deepEqual(ruleFor(reviewFactsOf([rec({ occasion: "item" })], head, false, true)), { result: "wip", draft: true }, "an item PASS does not take it out");
  assert.deepEqual(ruleFor(reviewFactsOf([rec({ head: "b".repeat(40) })], head, false, false)), { result: "unreviewed", draft: true }, "a [pre-pr] PASS on another head does not");
  assert.deepEqual(ruleFor(reviewFactsOf([rec({ occasion: "item" })], head, false, false)), { result: "unreviewed", draft: true });
  assert.deepEqual(ruleFor(reviewFactsOf([rec()], head, false, false)), { result: "ready", draft: false }, "the [pre-pr] PASS on the pushed head does");
});
