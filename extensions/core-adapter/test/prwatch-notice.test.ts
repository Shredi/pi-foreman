import { test } from "node:test";
import assert from "node:assert/strict";
import { PrWatches } from "../prwatch.ts";
import type { StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import type { PrKey } from "../prhost.ts";

const A: PrKey = { host: "github.com", repo: "acme/app", n: 1 };
const B: PrKey = { host: "github.com", repo: "acme/app", n: 2 };
const DOWN = "no PR tracker running";
const flush = () => new Promise((r) => setImmediate(r));
const snap = (): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: "abc1234567", base: "main", updatedAt: "t1", runs: [{ id: "1", name: "ci", bucket: "passed", url: "u" }], comments: [] });

/** `reads[key]` is what the store says per key; `tracker` false makes every read `down`. */
function harness() {
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const sent: string[] = [];
  const retracked: string[] = [];
  const h = { tracker: true, reads: new Map<number, StoreRead>(), clock: 0 };
  const watches = new PrWatches({
    storeEntry: (key) => (h.tracker ? (h.reads.get(key.n) ?? { kind: "waiting" }) : { kind: "down" }),
    retrack: (key) => void retracked.push(`${key.repo}#${key.n}@${h.clock}`),
    send: (m) => void sent.push(m.content),
    idle: () => true,
    trace: () => {},
    intervalMs: () => 60_000,
    now: () => h.clock,
    timers,
  });
  /** One round: fire every pending timer and let the ticks settle. */
  const round = async () => {
    for (const f of fns.splice(0)) f();
    await flush();
  };
  const notices = () => sent.filter((s) => s.includes(DOWN)).length;
  return { watches, sent, retracked, h, round, notices, list: () => watches.list() };
}

test("one watch waiting beside a served one: no tracker-down notice while the tracker runs", async () => {
  const x = harness();
  x.watches.startPending(A); // never gets an entry
  x.watches.startPending(B);
  x.h.reads.set(2, { kind: "entry", snap: snap(), okAt: 1000 });
  x.h.clock = 11 * 60_000;
  for (let i = 0; i < 5; i++) await x.round();
  assert.equal(x.notices(), 0);
  assert.equal(x.list().find((w) => w.n === 1)?.event, "waiting for the tracker's first poll");
  assert.ok(!x.list().some((w) => w.event.includes(DOWN)));
  // the tracker goes down: exactly one notice for both watches, however many ticks
  x.h.tracker = false;
  for (let i = 0; i < 4; i++) await x.round();
  assert.equal(x.notices(), 1);
  assert.ok(x.list().every((w) => w.event.includes(DOWN)));
  // back up, then down again: one more
  x.h.tracker = true;
  await x.round();
  assert.ok(!x.list().some((w) => w.event.includes(DOWN)));
  x.h.tracker = false;
  for (let i = 0; i < 3; i++) await x.round();
  assert.equal(x.notices(), 2);
});

test("a restored watch asks for a re-add at once; a waiting watch asks again at most every 5 minutes", async () => {
  const x = harness();
  x.watches.restore({ status: "ok", bad: 0, watches: [{ key: A, cwd: "", startedAt: 0, state: { last: "arming" } as never }] });
  await flush();
  assert.deepEqual(x.retracked, ["acme/app#1@0"]);
  x.h.clock = 60_000;
  await x.round(); // waiting, tracker runs, but asked 1 min ago
  assert.equal(x.retracked.length, 1);
  x.h.clock = 5 * 60_000;
  await x.round();
  assert.equal(x.retracked.length, 2);
  x.h.clock = 5 * 60_000 + 60_000;
  await x.round();
  assert.equal(x.retracked.length, 2);
});

test("a served watch is never re-added; a watch armed while the tracker is down is re-added once it runs", async () => {
  const x = harness();
  x.watches.startPending(B);
  x.h.reads.set(2, { kind: "entry", snap: snap(), okAt: 1000 });
  x.h.tracker = false;
  await x.round();
  assert.equal(x.retracked.length, 0, "down: the list is not the problem");
  x.h.tracker = true;
  await x.round();
  assert.equal(x.retracked.length, 0, "an entry exists");
  const y = harness();
  y.watches.startPending(A);
  await y.round();
  assert.equal(y.retracked.length, 1, "no entry while the tracker runs");
});
