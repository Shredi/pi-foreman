// The watch reports a head with no reviewer PASS even when the PR has no review record at all (a PR opened from the shell).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrWatches } from "../prwatch.ts";
import type { StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import type { PrKey } from "../prhost.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const OTHER: PrKey = { host: "github.com", repo: "acme/app", n: 8 };
const A = "aaaaaaa111";
const B = "bbbbbbb222";
const snap = (head: string): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head, base: "main", updatedAt: "t0", runs: [] });
const NO_RECORD = (head: string) => `head ${head.slice(0, 7)} not reviewed (no review record)`;

function harness(passes: string[], opts: { gate?: boolean } = {}) {
  const timers: { fn: () => void; live: boolean }[] = [];
  const fake: Timers = { set: (fn) => (timers.push({ fn, live: true }), timers.length - 1), clear: (h) => void (timers[h as number] && (timers[h as number].live = false)) };
  let read: StoreRead = { kind: "down" };
  const sent: string[] = [];
  const w = new PrWatches({
    storeEntry: async () => read,
    reviewedHeads: () => passes,
    ...(opts.gate === undefined ? {} : { reviewGate: () => opts.gate as boolean }),
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
    if (t) {
      t.live = false;
      t.fn();
    }
    await new Promise((r) => setImmediate(r));
  };
  return { w, sent, tick };
}
const unrev = (sent: string[]): string[] => sent.filter((c) => c.includes("not reviewed"));

// fails without the change: the watch stayed silent without a review record
test("no review record: one message per head, none on the next tick for the same head, one again after a new head", async () => {
  const h = harness([]);
  h.w.startPending(K);
  await h.tick(A, 1);
  assert.equal(unrev(h.sent).length, 1);
  assert.ok(unrev(h.sent)[0].includes(NO_RECORD(A)));
  await h.tick(A, 2);
  assert.equal(unrev(h.sent).length, 1);
  await h.tick(B, 3);
  assert.equal(unrev(h.sent).length, 2);
  assert.ok(unrev(h.sent)[1].includes(NO_RECORD(B)));
});

// fails without the change; also guards against the arming step swallowing the message
test("watch armed from a stored snapshot with no review record: the message for that head is not lost", async () => {
  const h = harness([]);
  h.w.start(K, snap(A), 1);
  await h.tick(A, 2);
  assert.equal(unrev(h.sent).length, 1);
  assert.ok(unrev(h.sent)[0].includes(NO_RECORD(A)));
});

// passes without the change too: pins that a PASS stays silent
test("a head with a reviewer PASS: no message and no token", async () => {
  const h = harness([A]);
  h.w.start(K, snap(A), 1);
  await h.tick(A, 2);
  assert.deepEqual(unrev(h.sent), []);
  assert.deepEqual(h.w.unreviewed(), []);
});

// passes without the change too: pins that the review gate switch silences it
test("ceremony.reviewBeforePr off: no message for a head with no record", async () => {
  const h = harness([], { gate: false });
  h.w.start(K, snap(A), 1);
  await h.tick(A, 2);
  await h.tick(B, 3);
  assert.deepEqual(unrev(h.sent), []);
  assert.deepEqual(h.w.unreviewed(), []);
});

// passes without the change too: pins that a PR with no watch stays silent
test("a PR with no watch: no message", async () => {
  const h = harness([]);
  h.w.start(K, snap(A), 1);
  await h.tick(B, 2);
  assert.equal(unrev(h.sent).length, 1);
  assert.equal(h.w.reviewOf(OTHER), null);
  assert.equal(h.w.unreviewed().some((k) => k.n === OTHER.n), false);
});

// fails without the change: the list held only PRs that drifted after a PASS
test("the live file's unreviewed list holds a PR with no review record", async () => {
  const h = harness([]);
  h.w.start(K, snap(A), 1);
  await h.tick(A, 2);
  assert.deepEqual(h.w.unreviewed(), [K]);
});

// passes without the change too: the earlier-PASS wording is kept
test("an earlier head passed, this one did not: the message names the last PASS", async () => {
  const h = harness([A]);
  h.w.start(K, snap(A), 1);
  await h.tick(B, 2);
  assert.equal(unrev(h.sent).length, 1);
  assert.ok(unrev(h.sent)[0].includes(`head ${B.slice(0, 7)} not reviewed (last PASS on ${A.slice(0, 7)})`));
});
