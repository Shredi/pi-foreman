import { test } from "node:test";
import assert from "node:assert/strict";
import { DRAFT_FAIL_CAP, PrWatches, latestWatches, parseWatchRecord } from "../prwatch.ts";
import type { StoreRead, Timers, WatchRecord, WatchSnapshot } from "../prwatch.ts";
import type { ReviewFacts } from "../prready.ts";
import type { PrKey } from "../prhost.ts";
import type { SafeOpOutcome } from "../safeops.ts";

const K: PrKey = { host: "ghe.example.com", repo: "acme/app", n: 7 };
const A = "a".repeat(40);
const B = "b".repeat(40);
const snap = (o: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: A, base: "main", updatedAt: "t1", runs: [{ id: "1", name: "ci", bucket: "passed", url: "u" }], comments: [], draft: true, ...o });
const flush = () => new Promise((r) => setImmediate(r));
const ran: SafeOpOutcome = { kind: "ran", result: { ok: true } };

function harness(o: { owned?: boolean; flow?: boolean; child?: boolean } = {}) {
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const sent: string[] = [];
  const calls: { key: PrKey; cwd: string; draft: boolean }[] = [];
  const persisted: WatchRecord[][] = [];
  const h = { read: { kind: "entry", snap: snap(), okAt: 1000 } as StoreRead, clock: 0, facts: "ok" as ReviewFacts, flow: o.flow ?? true, answer: ran as SafeOpOutcome | (() => never), settle: 0 };
  const watches = new PrWatches({
    storeEntry: () => h.read,
    githubHosts: () => ({ hosts: ["ghe.example.com"] }),
    reviewFacts: () => h.facts,
    draftFlow: () => h.flow,
    draft: async (key, cwd, draft) => {
      calls.push({ key, cwd, draft });
      if (typeof h.answer === "function") return h.answer();
      return h.answer;
    },
    persist: (w) => void persisted.push(JSON.parse(JSON.stringify(w))),
    cwd: () => "/work/tree",
    child: () => o.child ?? false,
    send: (m) => void sent.push(m.content),
    idle: () => true,
    trace: () => {},
    intervalMs: () => 60_000,
    settleMs: () => h.settle,
    now: () => h.clock,
    timers,
  });
  const tick = async () => {
    fns.shift()?.();
    await flush();
  };
  const start = (owned = o.owned ?? true, s: WatchSnapshot = snap()) => watches.start(K, s, null, owned);
  return { watches, sent, calls, h, tick, start, persisted, pending: () => fns.length };
}

test("an owned draft PR whose rule holds leaves draft; the call carries the watch's repository, host and directory", async () => {
  const x = harness();
  x.start();
  await x.tick();
  assert.deepEqual(x.calls, [{ key: K, cwd: "/work/tree", draft: false }]);
});

test("no second host call while the store is stale; a newer store entry that still shows the old state asks again", async () => {
  const x = harness();
  x.start();
  await x.tick();
  await x.tick();
  await x.tick();
  assert.equal(x.calls.length, 1);
  x.h.read = { kind: "entry", snap: snap({ updatedAt: "t2" }), okAt: 2000 };
  await x.tick();
  assert.equal(x.calls.length, 2, "a poll that still shows a draft after the call is asked once more (the hand-set draft is overruled)");
  x.h.read = { kind: "entry", snap: snap({ draft: false, updatedAt: "t3" }), okAt: 3000 };
  await x.tick();
  assert.equal(x.calls.length, 2, "the store shows the target: nothing to do");
});

test("draft goes on at once at a builder launch or a project edit (reconcileOwned), also while the store does not move", async () => {
  const x = harness();
  x.h.read = { kind: "entry", snap: snap({ draft: false }), okAt: 1000 };
  x.start(true, snap({ draft: false }));
  x.h.facts = "wip";
  await x.watches.reconcileOwned();
  assert.deepEqual(x.calls.map((c) => c.draft), [true]);
  await x.watches.reconcileOwned();
  assert.equal(x.calls.length, 1, "the memo stops a repeat on the same store entry");
});

test("a new unreviewed head at a tick sends the PR back to draft; checks running or red do not", async () => {
  const x = harness();
  x.h.read = { kind: "entry", snap: snap({ draft: false }), okAt: 1000 };
  x.start(true, snap({ draft: false }));
  x.h.read = { kind: "entry", snap: snap({ draft: false, runs: [{ id: "1", name: "ci", bucket: "failed", url: "u" }], updatedAt: "t2" }), okAt: 2000 };
  await x.tick();
  x.h.read = { kind: "entry", snap: snap({ draft: false, runs: [{ id: "2", name: "ci", bucket: "pending", url: "u" }], updatedAt: "t3" }), okAt: 3000 };
  await x.tick();
  assert.deepEqual(x.calls, []);
  x.h.facts = "unreviewed";
  x.h.read = { kind: "entry", snap: snap({ draft: false, head: B, updatedAt: "t4" }), okAt: 4000 };
  await x.tick();
  assert.deepEqual(x.calls.map((c) => c.draft), [true]);
});

test("a watched PR (pr_watch), a followed PR and another session's PR never get a draft call", async () => {
  const x = harness({ owned: false });
  x.start(false);
  x.h.facts = "wip";
  await x.tick();
  await x.watches.reconcileOwned();
  assert.deepEqual(x.calls, [], "a watch pr_create did not arm");
  // a followed PR has no watch at all
  const f = harness();
  await f.watches.reconcileOwned();
  assert.deepEqual(f.calls, []);
  // another session's entry (or a fork's new session id) restores nothing
  const rec: WatchRecord = { key: K, cwd: "/w", startedAt: 1, state: f.watches.records()[0]?.state ?? { head: "", failedIds: [], ci: "", mergeable: "", commentIds: [], updatedAt: "", noCi: 0, noCiHead: "", readyHead: "", last: "watching" }, owned: true };
  const entry = [{ type: "custom", customType: "pi-foreman-prwatch", data: { v: 2, piSessionId: "other", watches: [JSON.parse(JSON.stringify(rec))] } }];
  const r = latestWatches(entry, "mine");
  assert.equal(r.status, "other_session");
  f.watches.restore(r);
  await f.tick();
  await f.watches.reconcileOwned();
  assert.deepEqual(f.calls, []);
});

test("flow off (tools.prDraft false, review gate off, PR feed off): no draft call, no managed watch", async () => {
  const x = harness({ flow: false });
  x.start();
  x.h.facts = "wip";
  x.h.read = { kind: "entry", snap: snap({ draft: false }), okAt: 2000 };
  await x.tick();
  await x.watches.reconcileOwned();
  assert.deepEqual(x.calls, []);
});

test("a failing host is retried with a growing pause and a cap, with one notice; it never throws into the session", async () => {
  const x = harness();
  x.h.answer = { kind: "error", message: "pr_host_failed: gh: unknown flag" };
  x.start();
  let okAt = 1000;
  const next = async () => {
    okAt += 1000;
    x.h.read = { kind: "entry", snap: snap({ updatedAt: `t${okAt}` }), okAt };
    await x.tick();
  };
  await x.tick();
  assert.equal(x.calls.length, 1);
  await next();
  assert.equal(x.calls.length, 1, "inside the pause");
  x.h.clock += 30_000;
  await next();
  assert.equal(x.calls.length, 2);
  x.h.clock += 30_000;
  await next();
  assert.equal(x.calls.length, 2, "the pause doubled");
  x.h.clock += 60_000;
  await next();
  assert.equal(x.calls.length, 3);
  x.h.clock += 120_000;
  await next();
  assert.equal(x.calls.length, DRAFT_FAIL_CAP);
  assert.equal(x.sent.filter((m) => m.includes("draft state not changed")).length, 1);
  x.h.clock += 10_000_000;
  await next();
  await next();
  assert.equal(x.calls.length, DRAFT_FAIL_CAP, "no more calls for the head at the cap");
  assert.equal(x.sent.filter((m) => m.includes("draft state not changed")).length, 1, "one notice");
  // a throwing host op is a failure too
  const t = harness();
  t.h.answer = () => {
    throw new Error("boom");
  };
  t.start();
  await t.tick();
  assert.equal(t.calls.length, 1);
});

test("an unsupported host answer ends the draft handling of the watch", async () => {
  const x = harness();
  x.h.answer = { kind: "precondition", precondition: "pr_unsupported", message: "pr_draft needs gh" };
  x.start();
  await x.tick();
  x.h.read = { kind: "entry", snap: snap({ updatedAt: "t2" }), okAt: 2000 };
  await x.tick();
  assert.equal(x.calls.length, 1);
  assert.equal(x.watches.records()[0].owned, undefined);
});

test("reload keeps ownership, the draft memo and the draft state seen; a ready PR stays ready and gets no second line or call", async () => {
  const x = harness({ child: true });
  x.h.read = { kind: "entry", snap: snap({ draft: false }), okAt: 1000 };
  x.start(true, snap({ draft: false }));
  x.h.read = { kind: "entry", snap: snap({ draft: false, runs: [{ id: "2", name: "ci", bucket: "pending", url: "u" }], updatedAt: "t2" }), okAt: 2000 };
  await x.tick();
  x.h.read = { kind: "entry", snap: snap({ draft: false, updatedAt: "t3" }), okAt: 3000 };
  await x.tick();
  assert.ok(x.sent.some((m) => m.includes("ready to merge")), "ready line sent");
  const [rec] = x.watches.records();
  assert.equal(rec.owned, true);
  assert.ok(rec.state.draftSeen === false);
  const stored = JSON.parse(JSON.stringify({ v: 2, piSessionId: "mine", watches: [rec] }));
  const parsed = parseWatchRecord(stored.watches[0]);
  assert.equal(parsed?.owned, true);
  assert.deepEqual(parsed?.state.draftAsk, rec.state.draftAsk);
  assert.equal(parsed?.state.draftSeen, false);
  const y = harness({ child: true });
  y.h.read = { kind: "entry", snap: snap({ draft: false, updatedAt: "t3" }), okAt: 3000 };
  y.watches.restore(latestWatches([{ type: "custom", customType: "pi-foreman-prwatch", data: stored }], "mine"));
  await flush();
  assert.equal(y.watches.records()[0].owned, true);
  assert.deepEqual(y.calls, []);
  assert.ok(!y.sent.some((m) => m.includes("ready to merge")), "no second ready line after the reload");
});

test("a PR adopted with pr_watch gets no ready line without the rule, and one once it holds", async () => {
  const x = harness({ owned: false, child: true });
  x.h.facts = "unreviewed";
  x.h.read = { kind: "entry", snap: snap({ draft: false, runs: [{ id: "1", name: "ci", bucket: "pending", url: "u" }] }), okAt: 1000 };
  x.start(false, snap({ draft: false, runs: [{ id: "1", name: "ci", bucket: "pending", url: "u" }] }));
  x.h.read = { kind: "entry", snap: snap({ draft: false, updatedAt: "t2" }), okAt: 2000 };
  await x.tick();
  assert.ok(!x.sent.some((m) => m.includes("ready to merge")));
  x.h.facts = "ok";
  x.h.read = { kind: "entry", snap: snap({ draft: false, updatedAt: "t3" }), okAt: 3000 };
  await x.tick();
  assert.equal(x.sent.filter((m) => m.includes("ready to merge")).length, 1);
  await x.tick();
  assert.equal(x.sent.filter((m) => m.includes("ready to merge")).length, 1);
  assert.deepEqual(x.calls, []);
});

test("no checks: draft confirmed, no ready line before the non-draft confirmation, then the no-checks line once", async () => {
  const x = harness({ child: true });
  const none = (o: Partial<WatchSnapshot>) => snap({ runs: [], ...o });
  x.h.read = { kind: "entry", snap: none({ draft: true }), okAt: 1000 };
  x.start(true, none({ draft: true }));
  let at = 1000;
  const feed = async (o: Partial<WatchSnapshot>) => {
    at += 1000;
    x.h.read = { kind: "entry", snap: none({ updatedAt: `t${at}`, ...o }), okAt: at };
    await x.tick();
  };
  await feed({ draft: true });
  assert.deepEqual(x.calls.map((c) => c.draft), [false], "no checks confirmed on the draft: it leaves draft");
  assert.ok(!x.sent.some((m) => m.includes("ready to merge")));
  await feed({ draft: false });
  assert.ok(!x.sent.some((m) => m.includes("ready to merge")), "the count restarted with the draft change");
  await feed({ draft: false });
  assert.equal(x.sent.filter((m) => m.includes("no checks on aaaaaaa, mergeable, ready to merge")).length, 1);
  await feed({ draft: false });
  assert.equal(x.sent.filter((m) => m.includes("ready to merge")).length, 1);
  assert.equal(x.calls.length, 1);
});
