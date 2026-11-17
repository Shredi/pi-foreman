// A child session with several watched PRs closes at the last merge (or when, after a merge, the last watch is closed unmerged): the index.ts wiring of
// onMerged / onLastEnded over the real PrWatches and mergeCloseRequest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CloseFlow, mergeCloseRequest, mergeCloseStarter } from "../close.ts";
import type { CloseDeps, CloseRequest } from "../close.ts";
import { PrWatches } from "../prwatch.ts";
import type { Timers, WatchSnapshot } from "../prwatch.ts";
import type { PrKey } from "../prhost.ts";
import { storeFromPoll } from "./_storefake.ts";

const HANDOFF = "/tmp/handoff/20260101-120000-phase-two";
const key = (n: number): PrKey => ({ host: "github.com", repo: "acme/app", n });
const snap = (state: WatchSnapshot["state"]): WatchSnapshot => ({ state, mergeable: "mergeable", head: "abcdef0123456789", base: "main", updatedAt: "t0", runs: [] });

function rig() {
  const states = new Map<number, WatchSnapshot["state"]>();
  const timers: { fn: () => void; live: boolean }[] = [];
  const fake: Timers = { set: (fn) => (timers.push({ fn, live: true }), timers.length - 1), clear: (h) => void (timers[h as number] && (timers[h as number].live = false)) };
  const started: CloseRequest[] = [];
  // the real index.ts helper over an async start that only becomes active (closing) a few ticks later, as close.start does after awaiting the session
  let closing = false;
  const startMerge = mergeCloseStarter(async (_ctx, req) => {
    started.push(req);
    await new Promise((r) => setTimeout(r, 20));
    closing = true;
  }, () => closing);
  const mergeClose = (n: number | null): void => {
    const req = mergeCloseRequest({ handoff: HANDOFF, watched: w.numbers(), n, parent: "parent-1" });
    if (!req) return;
    startMerge({} as never, req);
  };
  const w: PrWatches = new PrWatches({
    storeEntry: storeFromPoll(async (k) => ({ snap: snap(states.get(k.n) ?? "open") })),
    send: () => undefined,
    idle: () => true,
    trace: () => undefined,
    intervalMs: () => 5000,
    now: () => 0,
    timers: fake,
    child: () => true,
    rememberMerged: () => true,
    onMerged: (info) => mergeClose(info.key.n),
    onLastEnded: () => mergeClose(w.mergedPrs().at(-1)?.n ?? null),
  });
  /** One tick of every live watch at once. */
  const fireAll = async (): Promise<void> => {
    for (const t of timers.filter((x) => x.live)) {
      t.live = false;
      t.fn();
    }
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
  return { w, states, started, fireAll };
}

test("two watches: the first merge starts no close, the second (last) merge starts it naming that PR", async () => {
  const r = rig();
  r.w.start(key(7), snap("open"));
  r.w.start(key(8), snap("open"));
  r.states.set(7, "merged");
  await r.fireAll();
  assert.deepEqual(r.started, []);
  assert.deepEqual(r.w.numbers(), [8]);
  r.states.set(8, "merged");
  await r.fireAll();
  assert.equal(r.started.length, 1);
  assert.equal(r.started[0].pr?.n, 8);
  assert.match(r.started[0].prompt ?? "", /PR #8 was merged/);
  assert.match(r.started[0].prompt ?? "", /the PR numbers/);
  assert.equal(r.started[0].pr?.parent, "parent-1");
  assert.equal(r.started[0].pr?.label, "phase-two");
});

test("two merges on one tick (both watches already removed when the hooks run) give one close", async () => {
  const r = rig();
  r.w.start(key(7), snap("open"));
  r.w.start(key(8), snap("open"));
  r.states.set(7, "merged");
  r.states.set(8, "merged");
  await r.fireAll();
  assert.equal(r.started.length, 1);
});

test("a second start while the close runs is refused to its requester only: the parent hears nothing", async () => {
  const log: string[] = [];
  const deps = {
    activeWaits: () => [],
    activeRuns: () => 0,
    sendUserMessage: () => undefined,
    runSync: async () => ({ text: "sync", ok: true }),
    retro: async () => "",
    reply: (to: string, t: string) => void log.push(`reply:${to}:${t}`),
    notify: () => undefined,
    trace: () => undefined,
    markCause: () => undefined,
    writeStub: () => undefined,
    exists: () => true,
    setTimer: () => () => undefined,
  } as unknown as CloseDeps;
  const flow = new CloseFlow(deps);
  const req = mergeCloseRequest({ handoff: HANDOFF, watched: [], n: 8, parent: "parent-1" })!;
  await flow.request(req, { isIdle: () => true });
  assert.equal(flow.active, true);
  await flow.request(req, { isIdle: () => true });
  assert.deepEqual(log, []);
});

test("first PR merged, then the second closed unmerged by the host: the close starts for the merged PR", async () => {
  const r = rig();
  r.w.start(key(7), snap("open"));
  r.w.start(key(8), snap("open"));
  r.states.set(7, "merged");
  await r.fireAll();
  assert.deepEqual(r.started, []);
  r.states.set(8, "closed");
  await r.fireAll();
  assert.equal(r.started.length, 1);
  assert.equal(r.started[0].pr?.n, 7);
});

test("first PR merged, then the second pr_unwatch-ed: no close starts", async () => {
  const r = rig();
  r.w.start(key(7), snap("open"));
  r.w.start(key(8), snap("open"));
  r.states.set(7, "merged");
  await r.fireAll();
  assert.equal(r.w.unwatch(8), 1);
  await r.fireAll();
  assert.deepEqual(r.started, []);
});

test("the last watch closed unmerged with no merge remembered starts no close", async () => {
  const r = rig();
  r.w.start(key(7), snap("open"));
  r.states.set(7, "closed");
  await r.fireAll();
  assert.deepEqual(r.started, []);
});

test("mergeCloseRequest: null while a watch remains, without a handoff dir or without a merged PR", () => {
  assert.equal(mergeCloseRequest({ handoff: HANDOFF, watched: [8], n: 7, parent: undefined }), null);
  assert.equal(mergeCloseRequest({ handoff: "  ", watched: [], n: 7, parent: undefined }), null);
  assert.equal(mergeCloseRequest({ handoff: undefined, watched: [], n: 7, parent: undefined }), null);
  assert.equal(mergeCloseRequest({ handoff: HANDOFF, watched: [], n: null, parent: undefined }), null);
});
