import { test } from "node:test";
import assert from "node:assert/strict";
import { registerPrPack } from "../gitpack.ts";
import type { PrPackSession, PrTracker } from "../gitpack.ts";
import { PrWatches, TRACKER_DOWN } from "../prwatch.ts";
import type { StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import type { PrKey } from "../prhost.ts";
import type { Spawner } from "../spawn.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 5 };
const DOWN_TEXT = "no PR tracker running: start herdr-app or run `foreman prs poll`";

const snap = (over: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: "abc1234567", base: "main", updatedAt: "t1", runs: [{ id: "1", name: "ci", bucket: "passed", url: "u" }], comments: [], ...over });
const flush = () => new Promise((r) => setImmediate(r));

function harness() {
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const sent: string[] = [];
  const h = { read: { kind: "down" } as StoreRead, clock: 0, reads: 0 };
  const watches = new PrWatches({
    storeEntry: () => {
      h.reads += 1;
      return h.read;
    },
    send: (m) => void sent.push(m.content),
    idle: () => true,
    trace: () => {},
    intervalMs: () => 60_000,
    now: () => h.clock,
    timers,
  });
  /** Fire the pending timer and let the tick settle. */
  const tick = async () => {
    fns.shift()?.();
    await flush();
  };
  return { watches, sent, h, tick, pending: () => fns.length, list: () => watches.list() };
}

test("no tracker: the watch stays armed, says so in its status and sends the notice once per outage", async () => {
  const x = harness();
  x.watches.startPending(K);
  await x.tick();
  assert.equal(x.list()[0].event, DOWN_TEXT);
  assert.equal(x.sent.length, 1);
  assert.match(x.sent[0], new RegExp(DOWN_TEXT.replace(/[`.]/g, "\\$&")));
  await x.tick();
  await x.tick();
  assert.equal(x.sent.length, 1);
  assert.equal(x.pending(), 1);
  // the tracker comes back, then goes away again: a second notice
  x.h.read = { kind: "entry", snap: snap(), okAt: 1000 };
  await x.tick();
  assert.notEqual(x.list()[0].event, DOWN_TEXT);
  x.h.read = { kind: "down" };
  await x.tick();
  assert.equal(x.sent.filter((s) => s.includes("no PR tracker running")).length, 2);
});

test("TRACKER_DOWN is the R1 text", () => {
  assert.equal(TRACKER_DOWN, DOWN_TEXT);
});

test("waiting for the tracker's first poll stays a status text after 10 minutes (the tracker runs; no tracker-down text)", async () => {
  const x = harness();
  x.watches.startPending(K);
  x.h.read = { kind: "waiting" };
  x.h.clock = 599_999;
  await x.tick();
  assert.equal(x.list()[0].event, "waiting for the tracker's first poll");
  assert.equal(x.sent.length, 0);
  x.h.clock = 600_000;
  await x.tick();
  assert.equal(x.list()[0].event, "waiting for the tracker's first poll");
  assert.equal(x.sent.length, 0);
});

test("a stale entry and a tracker error keep the watch armed with a status", async () => {
  const x = harness();
  x.watches.startPending(K);
  x.h.read = { kind: "stale" };
  await x.tick();
  assert.match(x.list()[0].event, /more than 10 minutes old/);
  x.h.read = { kind: "error", error: "boom" };
  await x.tick();
  assert.equal(x.list()[0].event, "the tracker's last poll failed: boom");
  x.h.read = { kind: "error", error: "gone", gone: true };
  await x.tick();
  assert.match(x.list()[0].event, /^not found/);
  assert.equal(x.pending(), 1);
  assert.equal(x.sent.length, 0);
});

test("a throwing store reader counts as no tracker", async () => {
  const sent: string[] = [];
  const fns: (() => void)[] = [];
  const w = new PrWatches({ storeEntry: () => { throw new Error("disk"); }, send: (m) => void sent.push(m.content), idle: () => true, trace: () => {}, intervalMs: () => 1, now: () => 0, timers: { set: (f) => (fns.push(f), 1), clear: () => {} } });
  w.startPending(K);
  fns.shift()!();
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(w.list()[0].event, DOWN_TEXT);
});

test("a merged snap from the store ends the watch with the merged message and onMerged", async () => {
  const x = harness();
  const merged: PrKey[] = [];
  x.watches.start(K, snap(), 1000);
  (x.watches as unknown as { deps: { onMerged: (i: { key: PrKey }) => void } }).deps.onMerged = (i) => void merged.push(i.key);
  x.h.read = { kind: "entry", snap: snap({ state: "merged" }), okAt: 2000 };
  await x.tick();
  assert.equal(x.watches.size(), 0);
  assert.equal(x.sent.length, 1);
  assert.match(x.sent[0], /merged/);
  assert.equal(merged.length, 1);
});

test("an unchanged okAt only re-arms: no news, no ticks growing noCi", async () => {
  const x = harness();
  x.watches.start(K, snap({ runs: [] }), 1000);
  x.h.read = { kind: "entry", snap: snap({ runs: [] }), okAt: 1000 };
  for (let i = 0; i < 6; i++) await x.tick();
  assert.equal(x.sent.length, 0);
  assert.equal(x.pending(), 1);
  assert.equal(x.watches.size(), 1);
});

test("a newer entry is settled once; the same okAt again is not", async () => {
  const x = harness();
  x.watches.start(K, snap({ runs: [{ id: "1", name: "ci", bucket: "pending", url: "u" }] }), 1000);
  x.h.read = { kind: "entry", snap: snap({ runs: [{ id: "1", name: "ci", bucket: "failed", url: "u" }] }), okAt: 2000 };
  await x.tick();
  assert.equal(x.sent.length, 1);
  await x.tick();
  assert.equal(x.sent.length, 1);
});

// ---- the tools: no GitHub call from an arm or a tick

type Tool = { execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };

function toolSetup(host: string, read: StoreRead) {
  const tools = new Map<string, Tool>();
  const fns: (() => void)[] = [];
  const calls: string[] = [];
  const spawner: Spawner = async (_c, _a, o) => {
    calls.push(JSON.parse(o.input ?? "{}").op ?? "?");
    throw new Error("a GitHub or pr_ops call is not allowed here");
  };
  const watches = new PrWatches({ storeEntry: () => read, send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => 0, timers: { set: (f) => (fns.push(f), fns.length), clear: () => {} } });
  const tracker: PrTracker = { hostAllowed: async () => true, repoFor: async () => ({ host, repo: "acme/app" }) };
  const session: PrPackSession = { python: "/py", isChild: false, packOn: true, config: {}, gateOn: false, reviewed: async () => [], watches, trace: () => {}, tracker };
  registerPrPack({ registerTool: (t: unknown) => void tools.set((t as { name: string }).name, t as Tool) } as never, { isChild: false, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null });
  const call = (name: string, params: Record<string, unknown> = {}) => tools.get(name)!.execute("id1", params, undefined, undefined, { cwd: process.cwd() });
  return { call, watches, fns, calls };
}

test("pr_watch arms from the store with no host call, and its ticks make none either", async () => {
  const t = toolSetup("github.com", { kind: "entry", snap: snap(), okAt: 1000 });
  const r = await t.call("pr_watch", { number: 5 });
  assert.equal(r.isError, undefined);
  assert.equal(t.watches.size(), 1);
  for (let i = 0; i < 3; i++) {
    t.fns.shift()?.();
    await flush();
  }
  assert.deepEqual(t.calls, []);
});

test("pr_watch with no tracker arms the watch and says so, with no host call", async () => {
  const t = toolSetup("github.com", { kind: "down" });
  const r = await t.call("pr_watch", { number: 5 });
  assert.equal(t.watches.size(), 1);
  assert.ok(r.content[0].text.includes(DOWN_TEXT));
  assert.deepEqual(t.calls, []);
});

test("pr_watch on a non-github.com host is refused with host_unsupported", async () => {
  const t = toolSetup("gitlab.com", { kind: "down" });
  const r = await t.call("pr_watch", { number: 5 });
  assert.equal(r.details.decision, "host_unsupported");
  assert.match(r.content[0].text, /pr_watch: only github\.com PRs can be watched \(the PR tracker covers github\.com\); nothing was done\./);
  assert.equal(t.watches.size(), 0);
  assert.deepEqual(t.calls, []);
});
