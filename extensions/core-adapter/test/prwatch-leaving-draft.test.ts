// The checks message of a draft PR the watch takes out of draft on the same tick (prwatch.ts settle, draftCall): `checks finished: pass, leaving draft`, one shared
// predicate for the call and the wording. In-process, no child processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DRAFT_FAIL_CAP, PrWatches } from "../prwatch.ts";
import type { StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import type { ReviewFacts } from "../prready.ts";
import type { PrKey } from "../prhost.ts";
import type { SafeOpOutcome } from "../safeops.ts";

const K: PrKey = { host: "ghe.example.com", repo: "acme/app", n: 7 };
const A = "a".repeat(40);
const pass = [{ id: "1", name: "ci", bucket: "passed" as const, url: "u" }];
const run = [{ id: "1", name: "ci", bucket: "pending" as const, url: "u" }];
const snap = (o: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: A, base: "main", updatedAt: "t1", runs: pass, comments: [], draft: true, mergeState: "draft", ...o });
const flush = () => new Promise((r) => setImmediate(r));
const ran: SafeOpOutcome = { kind: "ran", result: { ok: true } };

function harness(o: { child?: boolean; owned?: boolean; label?: string } = {}) {
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const sent: string[] = [];
  const drafts: boolean[] = [];
  const labels: boolean[] = [];
  const h = { read: { kind: "entry", snap: snap({ runs: run }), okAt: 1000 } as StoreRead, okAt: 1000, clock: 0, facts: "ok" as ReviewFacts, answer: (): SafeOpOutcome | Promise<SafeOpOutcome> => ran };
  const watches: PrWatches = new PrWatches({
    storeEntry: () => h.read,
    githubHosts: () => ({ hosts: ["ghe.example.com"] }),
    reviewFacts: () => h.facts,
    draftFlow: () => true,
    draft: async (_k, _c, draft) => (drafts.push(draft), h.answer()),
    label: async (_k, _c, _l, on) => (labels.push(on), { kind: "ran", result: { changed: true } }),
    readyLabel: () => o.label ?? "",
    persist: () => {},
    cwd: () => "/work",
    child: () => o.child ?? false,
    send: (m) => void sent.push(m.content),
    idle: () => true,
    trace: () => {},
    intervalMs: () => 60_000,
    settleMs: () => 0,
    now: () => h.clock,
    timers,
  });
  const tick = async () => {
    fns.shift()?.();
    await flush();
    await flush();
  };
  const set = (s: WatchSnapshot) => {
    h.okAt += 1000;
    h.read = { kind: "entry", snap: { ...s, updatedAt: `t${h.okAt}` }, okAt: h.okAt };
  };
  watches.start(K, snap({ runs: run }), null, o.owned ?? true);
  return { watches, sent, drafts, labels, h, tick, set, last: () => sent.at(-1) ?? "" };
}

const LEAVING = /checks finished: pass, leaving draft/;
const HOLD = /out of draft now; hold your report until the ready line follows/;
const ALONE = /out of draft now; confirm with pr_status before you tell the owner it is ready/;

test("a managed draft PR whose rule holds at the tick: `leaving draft` and exactly one host call", async () => {
  const x = harness();
  x.set(snap());
  await x.tick();
  assert.match(x.last(), LEAVING);
  assert.ok(!/pass, draft/.test(x.last()));
  assert.deepEqual(x.drafts, [false]);
  await x.tick();
  assert.deepEqual(x.drafts, [false], "the memo holds on the same store entry");
});

test("a child is told to hold its report: no ready line and no report line", async () => {
  const x = harness({ child: true });
  x.set(snap());
  await x.tick();
  assert.match(x.last(), LEAVING);
  assert.match(x.last(), HOLD);
  assert.ok(!x.last().includes("ready to merge"));
  assert.ok(!x.last().includes("report to the parent"));
});

test("a session without a parent is told to confirm with pr_status instead", async () => {
  const x = harness({ child: false });
  x.set(snap());
  await x.tick();
  assert.match(x.last(), LEAVING);
  assert.match(x.last(), ALONE);
  assert.ok(!HOLD.test(x.last()));
});

test("the store refresh with the PR out of draft: a child gets the ready line with the report line once, and the label goes on", async () => {
  const x = harness({ child: true, label: "ready" });
  x.set(snap());
  await x.tick();
  assert.deepEqual(x.labels, [], "a draft is not labelled");
  x.set(snap({ draft: false, mergeState: "clean" }));
  await x.tick();
  assert.match(x.last(), /ready to merge/);
  assert.match(x.last(), /\nreport to the parent: PR #7 green on aaaaaaa, mergeable, ready to merge$/);
  assert.deepEqual(x.labels, [true]);
  const count = x.sent.length;
  x.set(snap({ draft: false, mergeState: "clean" }));
  await x.tick();
  assert.equal(x.sent.length, count, "once per head");
});

test("the store refresh with the PR out of draft in a session without a parent: no ready line, the label goes on", async () => {
  const x = harness({ child: false, label: "ready" });
  x.set(snap());
  await x.tick();
  const count = x.sent.length;
  x.set(snap({ draft: false, mergeState: "clean" }));
  await x.tick();
  assert.equal(x.sent.length, count);
  assert.deepEqual(x.labels, [true]);
});

test("a leave-draft call already in flight when the message is built: `, draft` as today", async () => {
  const x = harness({ child: true });
  let release: () => void = () => {};
  x.h.answer = () => new Promise<SafeOpOutcome>((r) => (release = () => r(ran)));
  x.set(snap({ runs: [] }));
  await x.tick();
  x.set(snap({ runs: [] }));
  await x.tick();
  assert.deepEqual(x.drafts, [false], "the no-checks path made the call, it is still on its way");
  x.set(snap());
  await x.tick();
  assert.match(x.last(), /checks finished: pass, draft/);
  assert.ok(!LEAVING.test(x.last()));
  assert.ok(x.last().includes("report to the parent") === false);
  release();
  await flush();
});

test("a call already memoised for this store entry when the message is built: `, draft` as today", async () => {
  const x = harness();
  x.set(snap());
  // the memo of a call made on this very entry (the tick that follows it still builds the message)
  const records = x.watches.records();
  records[0].state = { ...records[0].state, draftAsk: { head: A, draft: false, okAt: x.h.okAt } };
  const y = new PrWatches({
    storeEntry: () => x.h.read,
    githubHosts: () => ({ hosts: ["ghe.example.com"] }),
    reviewFacts: () => "ok",
    draftFlow: () => true,
    draft: async () => (x.drafts.push(false), ran),
    persist: () => {},
    cwd: () => "/work",
    send: (m) => void x.sent.push(m.content),
    idle: () => true,
    trace: () => {},
    intervalMs: () => 60_000,
    settleMs: () => 0,
    now: () => 0,
    timers: { set: () => 1, clear: () => {} },
  });
  x.sent.length = 0;
  y.restore({ status: "ok", watches: [{ ...records[0], state: { ...records[0].state, ci: "" } }], bad: 0 });
  await flush();
  await flush();
  assert.equal(x.sent.length, 1);
  assert.match(x.last(), /checks finished: pass, draft/);
  assert.ok(!LEAVING.test(x.last()));
  assert.deepEqual(x.drafts, [], "no second call");
});

test("a managed draft PR whose rule does not hold (head not reviewed): `, draft` as today and no call", async () => {
  const x = harness();
  x.h.facts = "unreviewed";
  x.set(snap());
  await x.tick();
  assert.match(x.last(), /checks finished: pass, draft/);
  assert.ok(!LEAVING.test(x.last()));
  assert.deepEqual(x.drafts, []);
});

test("an unmanaged draft PR: as today, `, draft` and the `still a draft` line", async () => {
  const x = harness({ child: true, owned: false });
  x.set(snap());
  await x.tick();
  assert.match(x.last(), /checks finished: pass, draft/);
  assert.ok(!LEAVING.test(x.last()));
  assert.match(x.last(), /\nreport to the parent: PR #7 green on aaaaaaa, mergeable, still a draft$/);
  assert.deepEqual(x.drafts, []);
});

test("the draft step paused after a failure, or at the cap: `, draft`", async () => {
  const paused = harness();
  paused.h.answer = () => ({ kind: "error", message: "boom" });
  paused.set(snap({ runs: [] }));
  await paused.tick();
  paused.set(snap({ runs: [] }));
  await paused.tick();
  assert.deepEqual(paused.drafts, [false], "the call failed");
  paused.set(snap());
  await paused.tick();
  assert.match(paused.last(), /checks finished: pass, draft/);
  assert.ok(!LEAVING.test(paused.last()));
  assert.deepEqual(paused.drafts, [false], "inside the pause: no call");

  const capped = harness();
  capped.h.answer = () => ({ kind: "error", message: "boom" });
  for (let i = 0; i < DRAFT_FAIL_CAP + 1; i++) {
    capped.h.clock += 10_000_000;
    capped.set(snap({ runs: [] }));
    await capped.tick();
  }
  assert.equal(capped.drafts.length, DRAFT_FAIL_CAP);
  capped.h.clock += 10_000_000;
  capped.set(snap());
  await capped.tick();
  assert.match(capped.last(), /checks finished: pass, draft/);
  assert.ok(!LEAVING.test(capped.last()));
  assert.equal(capped.drafts.length, DRAFT_FAIL_CAP, "no call at the cap");
});

test("failing checks on a draft: unchanged", async () => {
  const x = harness({ child: true });
  x.set(snap({ runs: [{ id: "1", name: "ci", bucket: "failed", url: "u" }] }));
  await x.tick();
  assert.match(x.last(), /checks finished: fail, draft/);
  assert.ok(!LEAVING.test(x.last()));
  assert.deepEqual(x.drafts, []);
});

test("a PASS recorded after the checks message: no new message on the tick that makes the call, the ready line after the refresh", async () => {
  const x = harness({ child: true });
  x.h.facts = "unreviewed";
  x.set(snap());
  await x.tick();
  assert.match(x.last(), /checks finished: pass, draft/);
  const count = x.sent.length;
  x.h.facts = "ok";
  await x.tick(); // the store did not move: the call is made, no message
  assert.deepEqual(x.drafts, [false]);
  assert.equal(x.sent.length, count);
  x.set(snap({ draft: false, mergeState: "clean" }));
  await x.tick();
  assert.match(x.last(), /ready to merge/);
  assert.equal(x.sent.length, count + 1);
});
