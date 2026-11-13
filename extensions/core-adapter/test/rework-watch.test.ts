// A send-back reaches the PR watch (prwatch.ts): the `tick` dep runs at each watch tick (where index.ts reworkScan looks for a marker), the owned open PR is drafted at
// once through reconcileOwned, and a watched or followed PR (never owned) gets no draft call. In-process, no child processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrWatches } from "../prwatch.ts";
import type { StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import { reviewFactsOf } from "../prready.ts";
import type { ReviewRecord } from "../reviews.ts";
import type { PrKey } from "../prhost.ts";
import type { SafeOpOutcome } from "../safeops.ts";

const K: PrKey = { host: "ghe.example.com", repo: "acme/app", n: 7 };
const A = "a".repeat(40);
const snap = (o: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: A, base: "main", updatedAt: "t1", runs: [{ id: "1", name: "ci", bucket: "passed", url: "u" }], comments: [], draft: false, ...o });
const flush = () => new Promise((r) => setImmediate(r));
const ran: SafeOpOutcome = { kind: "ran", result: { ok: true } };
const pass: ReviewRecord = { role: "reviewer", verdict: "pass", head: A, kind: "code", occasion: "pre-pr" };

/** A session's view: the records and the sentBack flag the way index.ts feeds them; `scan` is what reworkScan does at a tick. */
function harness() {
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const calls: { key: PrKey; draft: boolean }[] = [];
  const s = { records: [pass], sentBack: false, marker: false, ticks: 0 };
  const read = { v: { kind: "entry", snap: snap(), okAt: 1000 } as StoreRead };
  const watches: PrWatches = new PrWatches({
    storeEntry: () => read.v,
    githubHosts: () => ({ hosts: ["ghe.example.com"] }),
    reviewFacts: (head) => reviewFactsOf(s.records, head, false, s.sentBack),
    draftFlow: () => true,
    draft: async (key, _cwd, draft) => (calls.push({ key, draft }), ran),
    tick: () => {
      s.ticks++;
      if (s.marker && !s.sentBack) {
        s.sentBack = true;
        void watches.reconcileOwned();
      }
    },
    persist: () => {},
    cwd: () => "/work",
    child: () => true,
    send: () => {},
    idle: () => true,
    trace: () => {},
    intervalMs: () => 60_000,
    settleMs: () => 0,
    now: () => 0,
    timers,
  });
  const tick = async () => {
    fns.shift()?.();
    await flush();
    await flush();
  };
  return { watches, calls, s, read, tick };
}

test("the tick dep runs at each tick; with no marker nothing changes", async () => {
  const x = harness();
  x.watches.start(K, snap(), null, true);
  await x.tick();
  await x.tick();
  assert.equal(x.s.ticks, 2);
  assert.deepEqual(x.calls, [], "a reviewed, ready, non-draft PR with no marker: no draft call");
});

test("a marker found at a tick drafts the owned PR at once", async () => {
  const x = harness();
  x.watches.start(K, snap(), null, true);
  await x.tick();
  x.s.marker = true;
  await x.tick();
  assert.deepEqual(x.calls, [{ key: K, draft: true }]);
});

test("the next tool call (reconcileOwned) drafts the owned PR while the store does not move", async () => {
  const x = harness();
  x.watches.start(K, snap(), null, true);
  await x.tick();
  x.s.sentBack = true; // reworkScan at the top of a tool call
  await x.watches.reconcileOwned();
  assert.deepEqual(x.calls, [{ key: K, draft: true }]);
});

test("a watched or followed PR (not owned) gets no draft call from a marker, at a tick or a tool call", async () => {
  const x = harness();
  x.watches.start(K, snap(), null, false);
  x.s.marker = true;
  await x.tick();
  await x.watches.reconcileOwned();
  await x.tick();
  assert.equal(x.s.sentBack, true, "the marker was seen");
  assert.deepEqual(x.calls, []);
});

test("a forged marker only moves the PR toward draft: once the PR is a draft, only a [pre-pr] PASS on the pushed head asks it out", async () => {
  const x = harness();
  x.watches.start(K, snap(), null, true);
  x.s.marker = true;
  await x.tick();
  assert.deepEqual(x.calls.map((c) => c.draft), [true]);
  x.read.v = { kind: "entry", snap: snap({ draft: true, updatedAt: "t2" }), okAt: 2000 };
  await x.tick();
  await x.tick();
  assert.deepEqual(x.calls.map((c) => c.draft), [true], "the stale marker never takes it out of draft");
  x.s.records = [{ ...pass, occasion: "item" }]; // an item review PASS
  x.read.v = { kind: "entry", snap: snap({ draft: true, updatedAt: "t3" }), okAt: 3000 };
  await x.tick();
  assert.deepEqual(x.calls.map((c) => c.draft), [true], "an item PASS does not take it out");
  x.s.records = [pass];
  x.s.sentBack = false; // the [pre-pr] PASS cleared it (index.ts)
  x.s.marker = false; // the handled marker is below the watermark: the scan does not see it again
  x.read.v = { kind: "entry", snap: snap({ draft: true, updatedAt: "t4" }), okAt: 4000 };
  await x.tick();
  assert.deepEqual(x.calls.map((c) => c.draft), [true, false], "a [pre-pr] PASS on the pushed head takes it out");
});

test("a throwing tick dep never stops the watch", async () => {
  const x = harness();
  let ran1 = false;
  const w = new PrWatches({
    storeEntry: () => x.read.v,
    githubHosts: () => ({ hosts: ["ghe.example.com"] }),
    tick: () => {
      throw new Error("boom");
    },
    persist: () => {},
    cwd: () => "/work",
    send: () => {},
    idle: () => true,
    trace: () => {},
    intervalMs: () => 60_000,
    now: () => 0,
    timers: { set: (fn) => (ran1 ? 1 : ((ran1 = true), void Promise.resolve().then(fn), 1)), clear: () => {} },
  });
  w.start(K, snap(), null, false);
  await flush();
  await flush();
  assert.equal(w.numbers().length, 1);
  assert.equal(ran1, true, "the tick ran and survived the throw");
});
