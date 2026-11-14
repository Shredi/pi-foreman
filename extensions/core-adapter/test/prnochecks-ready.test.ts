// A pull request in a repository that has never run a check (zero runs, known-empty expected baseline, no required checks) through the whole watch
// (PrWatches over a fake store, like prexpect-watch.test.ts): reviewed on its head, mergeable, clean and out of draft it becomes ready (the no-checks ready line
// and the ready label); not reviewed on the head, or with checks expected but none reported, it does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrWatches } from "../prwatch.ts";
import type { StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import type { PrKey } from "../prhost.ts";
import type { SafeOpOutcome } from "../safeops.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const A = "a".repeat(40);
const snap = (o: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: A, base: "main", updatedAt: "t0", runs: [], required: null, comments: [], draft: false, mergeState: "clean", ...o });
const flush = () => new Promise((r) => setImmediate(r));

function harness(o: { child: boolean; facts: "ok" | "unreviewed"; start: WatchSnapshot }) {
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const sent: string[] = [];
  const labels: boolean[] = [];
  const h = { read: { kind: "entry", snap: o.start, okAt: 1000 } as StoreRead, okAt: 1000, clock: 0 };
  const watches = new PrWatches({
    storeEntry: () => h.read,
    githubHosts: () => ({ hosts: ["github.com"] }),
    reviewFacts: () => o.facts,
    draftFlow: () => true,
    draft: async (): Promise<SafeOpOutcome> => ({ kind: "ran", result: { ok: true } }),
    label: async (_k, _c, _l, on) => (labels.push(on), { kind: "ran", result: { changed: true } }),
    readyLabel: () => "ready",
    persist: () => {},
    cwd: () => "/work",
    child: () => o.child,
    send: (m) => void sent.push(m.content),
    idle: () => true,
    trace: () => {},
    intervalMs: () => 60_000,
    settleMs: () => 90_000,
    now: () => h.clock,
    timers,
  });
  const tick = async (s: WatchSnapshot, at: number) => {
    h.clock = at;
    h.okAt += 1000;
    h.read = { kind: "entry", snap: { ...s, updatedAt: `t${h.okAt}` }, okAt: h.okAt };
    fns.shift()?.();
    await flush();
    await flush();
  };
  watches.start(K, o.start, null, true);
  return { watches, sent, labels, tick };
}

const TICKS = [0, 60_000, 120_000, 180_000, 240_000];

for (const child of [true, false]) {
  const who = child ? "a child session" : "a session without a parent";

  test(`no CI, reviewed head, mergeable, clean, not a draft: ${who} sets the ready label${child ? " and sends the no-checks ready line" : ""}`, async () => {
    const x = harness({ child, facts: "ok", start: snap() });
    for (const at of TICKS) await x.tick(snap(), at);
    assert.deepEqual(x.labels, [true]);
    if (child) assert.equal(x.sent.filter((m) => m.includes("ready to merge, no checks")).length, 1);
    else assert.equal(x.sent.some((m) => m.includes("ready to merge")), false);
    assert.equal(x.watches.reviewLive()[0].noChecks, true);
  });

  test(`no CI, head not reviewed: ${who} sets no label and sends no ready line`, async () => {
    const x = harness({ child, facts: "unreviewed", start: snap() });
    for (const at of TICKS) await x.tick(snap(), at);
    assert.equal(x.labels.includes(true), false);
    assert.equal(x.sent.some((m) => m.includes("ready to merge")), false);
  });

  test(`checks expected but none reported, reviewed head: ${who} sets no label and sends no ready line`, async () => {
    const gap = snap({ expect: { missing: ["ci"] } });
    const x = harness({ child, facts: "ok", start: gap });
    for (const at of TICKS) await x.tick(gap, at);
    assert.deepEqual(x.labels, []);
    assert.equal(x.sent.some((m) => m.includes("ready to merge")), false);
  });

  test(`unknown expected baseline, no runs, reviewed head: ${who} sets no label and sends no ready line`, async () => {
    const gap = snap({ expect: { missing: [], unknown: true } });
    const x = harness({ child, facts: "ok", start: gap });
    for (const at of TICKS) await x.tick(gap, at);
    assert.deepEqual(x.labels, []);
    assert.equal(x.sent.some((m) => m.includes("ready to merge")), false);
  });
}
