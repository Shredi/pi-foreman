// D101 through the whole watch (PrWatches over a fake store): the waiting pass is sent after the settle hold, the ready label is set, and a managed draft leaves draft.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrWatches } from "../prwatch.ts";
import type { Run, StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import type { PrKey } from "../prhost.ts";
import type { SafeOpOutcome } from "../safeops.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const A = "a".repeat(40);
const SETTLE = 90_000;
const run = (name: string, bucket: Run["bucket"]): Run => ({ id: name, name, bucket, url: "u" });
const snap = (o: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: A, base: "main", updatedAt: "t0", runs: [run("check", "passed")], required: ["check", "gate"], comments: [], draft: false, mergeState: "blocked", ...o });
const flush = () => new Promise((r) => setImmediate(r));

function harness(start: WatchSnapshot, o: { child?: boolean; owned?: boolean } = {}) {
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const sent: string[] = [];
  const drafts: boolean[] = [];
  const labels: boolean[] = [];
  const h = { read: { kind: "entry", snap: start, okAt: 1000 } as StoreRead, okAt: 1000, clock: 0 };
  const watches = new PrWatches({
    storeEntry: () => h.read,
    githubHosts: () => ({ hosts: ["github.com"] }),
    reviewFacts: () => "ok",
    draftFlow: () => true,
    draft: async (_k, _c, draft): Promise<SafeOpOutcome> => (drafts.push(draft), { kind: "ran", result: { ok: true } }),
    label: async (_k, _c, _l, on) => (labels.push(on), { kind: "ran", result: { changed: true } }),
    readyLabel: () => "ready",
    persist: () => {},
    cwd: () => "/work",
    child: () => o.child ?? false,
    send: (m) => void sent.push(m.content),
    idle: () => true,
    trace: () => {},
    intervalMs: () => 60_000,
    settleMs: () => SETTLE,
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
  watches.start(K, start, null, o.owned ?? false);
  return { sent, drafts, labels, tick };
}

test("a child watch: the waiting pass and the not-ready line after the hold, the ready label on, no ready line", async () => {
  const x = harness(snap({ runs: [run("check", "pending")] }), { child: true });
  await x.tick(snap(), 0);
  assert.deepEqual(x.sent, []);
  assert.deepEqual(x.labels, [], "inside the settle hold");
  await x.tick(snap(), SETTLE);
  assert.equal(x.sent.length, 1);
  assert.match(x.sent[0], /checks finished: pass, waiting on required checks/);
  assert.ok(x.sent[0].includes("- waiting gate"));
  assert.ok(x.sent[0].includes("checks passed, waiting on required checks (approval or merge queue)"));
  assert.equal(x.sent[0].includes("ready to merge"), false);
  assert.deepEqual(x.labels, [true]);
});

test("a managed draft whose only missing required check is a waiting one leaves draft once the hold is over", async () => {
  const d = (o: Partial<WatchSnapshot> = {}) => snap({ draft: true, mergeState: "draft", ...o });
  const x = harness(d({ runs: [run("check", "pending")] }), { owned: true });
  await x.tick(d(), 0);
  assert.deepEqual(x.drafts, []);
  await x.tick(d(), SETTLE);
  assert.deepEqual(x.drafts, [false]);
});
