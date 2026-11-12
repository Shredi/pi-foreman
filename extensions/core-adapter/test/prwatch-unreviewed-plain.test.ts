// A plain pr_watch (start from a stored snap) on a head the reviewer never passed reports it once, with the first tick that brings newer
// stored data. These cases were checked for a silent watch on this base: none is silent; the tests are the proof.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrWatches } from "../prwatch.ts";
import type { StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import type { PrKey } from "../prhost.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const A = "aaaaaaa111";
const OTHER = "ccccccc333";
const snap = (head: string): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head, base: "main", updatedAt: "t0", runs: [] });

function harness(passes: string[], gate: boolean | undefined) {
  const timers: { fn: () => void; live: boolean }[] = [];
  const fake: Timers = { set: (fn) => (timers.push({ fn, live: true }), timers.length - 1), clear: (h) => void (timers[h as number] && (timers[h as number].live = false)) };
  let read: StoreRead = { kind: "down" };
  const sent: string[] = [];
  const w = new PrWatches({
    storeEntry: async () => read,
    reviewedHeads: () => passes,
    ...(gate === undefined ? {} : { reviewGate: () => gate }),
    cwd: () => "/work",
    send: (m) => void sent.push(m.content),
    idle: () => true,
    trace: () => {},
    intervalMs: () => 5000,
    now: () => 0,
    timers: fake,
  });
  const tick = async (head: string, okAt: number): Promise<void> => {
    read = { kind: "entry", snap: snap(head), okAt };
    const t = [...timers].reverse().find((x) => x.live);
    if (t) (t.live = false), t.fn();
    await new Promise((r) => setImmediate(r));
  };
  return { w, sent, tick };
}
const unrev = (sent: string[]): string[] => sent.filter((c) => c.includes("not reviewed (no review record)"));

for (const [name, passes, gate] of [
  ["no review record at all", [], undefined],
  ["PASS records for other heads only", [OTHER], undefined],
  ["ceremony.reviewBeforePr on", [], true],
] as const) {
  test(`plain pr_watch, ${name}: the unreviewed head comes once, with the first tick on newer data`, async () => {
    const h = harness([...passes], gate);
    h.w.start(K, snap(A), 1);
    assert.deepEqual(h.sent, [], "arming sends nothing");
    await h.tick(A, 1); // the same stored data the watch was armed on: re-arm only
    assert.deepEqual(unrev(h.sent), []);
    await h.tick(A, 2);
    assert.equal(unrev(h.sent).length, 1);
    assert.ok(unrev(h.sent)[0].includes(`head ${A.slice(0, 7)} not reviewed (no review record)`));
    await h.tick(A, 3);
    assert.equal(unrev(h.sent).length, 1, "once per head");
    assert.deepEqual(h.w.unreviewed(), [K]);
  });
}
