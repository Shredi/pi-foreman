// Review drift, round 2: a pending watch seeded by pr_create, and a reviewedHead that outlives its PASS record.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrWatches, reviewStep } from "../prwatch.ts";
import type { StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import type { PrKey } from "../prhost.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const A = "aaaaaaa111";
const B = "bbbbbbb222";
const snap = (head: string): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head, base: "main", updatedAt: "t0", runs: [] });

function harness(passes: string[]) {
  const timers: { fn: () => void; live: boolean }[] = [];
  const fake: Timers = { set: (fn) => (timers.push({ fn, live: true }), timers.length - 1), clear: (h) => void (timers[h as number] && (timers[h as number].live = false)) };
  let read: StoreRead = { kind: "down" };
  const sent: string[] = [];
  const w = new PrWatches({ storeEntry: async () => read, reviewedHeads: () => passes, cwd: () => "/work", send: (m) => void sent.push(m.content), idle: () => true, trace: () => {}, intervalMs: () => 5000, now: () => 0, timers: fake });
  const tick = async (head: string, okAt: number): Promise<void> => {
    read = { kind: "entry", snap: snap(head), okAt };
    const t = [...timers].reverse().find((x) => x.live);
    if (t) {
      t.live = false;
      t.fn();
    }
    await new Promise((r) => setImmediate(r));
  };
  return { w, sent, tick };
}
const drifts = (sent: string[]): string[] => sent.filter((c) => c.includes("not reviewed"));

test("pending watch seeded by the created head: a first snap on another head alerts once, naming both heads", async () => {
  const h = harness([A]);
  h.w.startPending(K, undefined, A);
  await h.tick(B, 1);
  assert.equal(drifts(h.sent).length, 1);
  assert.ok(drifts(h.sent)[0].includes(`head ${B.slice(0, 7)} not reviewed (last PASS on ${A.slice(0, 7)})`));
});

test("pending watch seeded by the created head: a first snap on the same head is silent", async () => {
  const h = harness([A]);
  h.w.startPending(K, undefined, A);
  await h.tick(A, 1);
  assert.deepEqual(drifts(h.sent), []);
  assert.equal(h.w.reviewOf(K), A);
});

test("pending watch without the seed (plain pr_watch): a first snap on an unreviewed head is silent", async () => {
  const h = harness([A]);
  h.w.startPending(K);
  await h.tick(B, 1);
  assert.deepEqual(drifts(h.sent), []);
  assert.deepEqual(h.w.unreviewed(), []);
});

test("reviewStep: a head equal to reviewedHead counts as reviewed with an empty PASS set", () => {
  const st = { reviewedHead: A, unreviewedHead: "" } as never;
  assert.equal(reviewStep(st, A, new Set()), null);
  assert.equal((st as { unreviewedHead: string }).unreviewedHead, "");
  assert.match(reviewStep(st, B, new Set()) ?? "", /not reviewed/);
});
