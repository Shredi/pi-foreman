// The PR watch (prwatch.ts) fed by the real wiring of index.ts: the review facts come from reviewFactsForHead and the send-back goes through sentBackMark / sentBackUnmark.
// Covers the second half of "the PR is drafted on the send-back pass" (the first half, the entry holding the marked head, is in rework-heads.test.ts), the draft
// handling, the child's ready line and the pill's facts when other work happens in the session. In-process, no child processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrWatches } from "../prwatch.ts";
import type { StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import { reviewFactsForHead } from "../prready.ts";
import { sentBackMark, sentBackUnmark } from "../planstate.ts";
import type { ReviewRecord } from "../reviews.ts";
import type { PrKey } from "../prhost.ts";
import type { SafeOpOutcome } from "../safeops.ts";

const K: PrKey = { host: "ghe.example.com", repo: "acme/app", n: 7 };
const A = "a".repeat(40);
const B = "b".repeat(40);
const snap = (o: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: A, base: "main", updatedAt: "t1", runs: [{ id: "1", name: "ci", bucket: "passed", url: "u" }], comments: [], draft: false, ...o });
const flush = () => new Promise((r) => setImmediate(r));
const ran: SafeOpOutcome = { kind: "ran", result: { ok: true } };
const pass = (head: string, o: Partial<ReviewRecord> = {}): ReviewRecord => ({ role: "reviewer", verdict: "pass", head, kind: "code", occasion: "pre-pr", ...o });

/** The session's view as index.ts keeps it; `record` is the review run's recording (with its un-marking), `scan` the send-back of reworkScan. */
function harness(o: { child?: boolean; owned?: boolean } = {}) {
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const calls: { draft: boolean }[] = [];
  const sent: string[] = [];
  const s = { reviews: [pass(A)], sentBackHeads: [] as string[], marker: false, seen: false, revised: false };
  const read = { v: { kind: "entry", snap: snap(), okAt: 1000 } as StoreRead };
  const watches: PrWatches = new PrWatches({
    storeEntry: () => read.v,
    githubHosts: () => ({ hosts: ["ghe.example.com"] }),
    reviewFacts: (head) => reviewFactsForHead(s.reviews, head, s.sentBackHeads),
    draftFlow: () => true,
    draft: async (_key, _cwd, draft) => (calls.push({ draft }), ran),
    tick: () => {
      if (s.marker && !s.seen) {
        s.seen = true;
        s.sentBackHeads = sentBackMark(s.sentBackHeads, s.reviews); // before reconcileOwned, as in index.ts reworkScan
        void watches.reconcileOwned();
      }
    },
    persist: () => {},
    cwd: () => "/work",
    child: () => o.child ?? false,
    send: (m) => void sent.push(m.content),
    idle: () => true,
    trace: () => {},
    intervalMs: () => 60_000,
    settleMs: () => 0,
    now: () => 0,
    timers,
  });
  const record = (rec: ReviewRecord) => {
    s.reviews.push(rec);
    s.sentBackHeads = sentBackUnmark(s.sentBackHeads, rec);
  };
  const tick = async () => {
    fns.shift()?.();
    await flush();
    await flush();
  };
  const store = (sn: WatchSnapshot, okAt: number) => (read.v = { kind: "entry", snap: sn, okAt });
  watches.start(K, snap(), null, o.owned ?? true);
  return { watches, calls, sent, s, tick, record, store };
}

test("the PR is drafted on the send-back pass: the tick marks the heads, then reconcileOwned reads facts from the helper and calls the host", async () => {
  const x = harness();
  await x.tick();
  assert.deepEqual(x.calls, [], "a reviewed PR waits out of draft");
  x.s.marker = true;
  await x.tick();
  assert.deepEqual(x.s.sentBackHeads, [A]);
  assert.deepEqual(x.calls, [{ draft: true }], "drafted on the same pass");
});

test("a sent-back head stays in draft after a [pre-pr] PASS on another head and leaves it only for its own newer PASS", async () => {
  const x = harness();
  x.s.marker = true;
  await x.tick();
  x.store(snap({ draft: true, updatedAt: "t2" }), 2000);
  x.record(pass(B)); // the reworked local head, or another PR
  await x.tick();
  await x.tick();
  assert.deepEqual(x.calls.map((c) => c.draft), [true], "still a draft");
  x.record(pass(A)); // the same head, re-reviewed after the send-back
  x.store(snap({ draft: true, updatedAt: "t3" }), 3000);
  await x.tick();
  assert.deepEqual(x.calls.map((c) => c.draft), [true, false], "leaves draft");
});

test("a builder launch or a project edit for other work (reconcileOwned, nothing recorded) leaves a waiting reviewed PR out of draft", async () => {
  const x = harness();
  await x.tick();
  x.s.revised = true; // the session-wide flag moves; it is no input of the facts
  await x.watches.reconcileOwned();
  await x.tick();
  assert.deepEqual(x.calls, []);
  assert.deepEqual(x.watches.reviewLive().map((e) => e.state), ["ok"]);
});

test("a new head without a [pre-pr] PASS still goes back to draft", async () => {
  const x = harness();
  await x.tick();
  x.store(snap({ head: B, updatedAt: "t2" }), 2000);
  await x.tick();
  assert.deepEqual(x.calls, [{ draft: true }]);
});

test("a rework mark still goes back to draft, an item PASS on the head does not take it out", async () => {
  const x = harness();
  x.s.marker = true;
  await x.tick();
  assert.deepEqual(x.calls, [{ draft: true }]);
  x.record(pass(A, { occasion: "item" }));
  x.store(snap({ draft: true, updatedAt: "t2" }), 2000);
  await x.tick();
  assert.deepEqual(x.calls, [{ draft: true }]);
});

test("a FAIL after the PASS on the same head sends the PR back to draft; the pill shows work in progress", async () => {
  const x = harness();
  await x.tick();
  x.record(pass(A, { verdict: "fail" }));
  await x.watches.reconcileOwned();
  assert.deepEqual(x.calls, [{ draft: true }]);
  assert.deepEqual(x.watches.reviewLive().map((e) => e.state), ["wip"]);
});

test("a child's ready line is not held back by a builder launch after the PASS on the pushed head", async () => {
  const x = harness({ child: true });
  x.store(snap({ runs: [{ id: "1", name: "ci", bucket: "pending", url: "u" }], updatedAt: "t2" }), 2000);
  await x.tick();
  x.s.revised = true; // a builder launch for other work, then the checks finish
  await x.watches.reconcileOwned();
  x.store(snap({ updatedAt: "t3" }), 3000);
  await x.tick();
  assert.equal(x.sent.filter((m) => m.includes("ready to merge")).length, 1);
  assert.deepEqual(x.calls, []);
});

test("the pill's facts stay ok through that work and a review of another PR; a sent-back head shows work in progress", async () => {
  const x = harness();
  await x.tick();
  x.s.revised = true;
  x.record(pass(B, { verdict: "fail" })); // a review of another PR
  assert.deepEqual(x.watches.reviewLive().map((e) => e.state), ["ok"]);
  x.s.marker = true;
  await x.tick();
  assert.deepEqual(x.watches.reviewLive().map((e) => e.state), ["wip"]);
});
