// The reviews line of the body of a PR the session opened (prwatch.ts bodyStep/bodyOpened, prbody.ts): the watch writes it through the host op `pr_body` when a
// new PASS lands on the head the host shows, once per (head, run id) pair, whether or not it handles the draft state. In-process, no child processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrWatches, latestWatches, parseWatchRecord, PRWATCH_ENTRY } from "../prwatch.ts";
import type { StoreRead, Timers, WatchRecord, WatchSnapshot } from "../prwatch.ts";
import { reviewsBlock } from "../prbody.ts";
import type { ReviewPass } from "../prbody.ts";
import type { PrKey } from "../prhost.ts";
import type { SafeOpOutcome } from "../safeops.ts";

const K: PrKey = { host: "ghe.example.com", repo: "acme/app", n: 7 };
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const snap = (o: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: A, base: "main", updatedAt: "t1", runs: [{ id: "1", name: "ci", bucket: "passed", url: "u" }], comments: [], draft: false, mergeState: "clean", ...o });
const flush = () => new Promise((r) => setImmediate(r));
const pass = (head: string, run: string): ReviewPass => ({ head, occasion: "pre-pr", run, suites: [{ command: "npm test", result: "pass" }] });

function harness(o: { noBody?: boolean } = {}) {
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const sent: string[] = [];
  const calls: { key: PrKey; cwd: string; block: string }[] = [];
  const traces: string[] = [];
  const persisted: WatchRecord[][] = [];
  const h = {
    read: { kind: "entry", snap: snap(), okAt: 1000 } as StoreRead,
    okAt: 1000,
    facts: new Map<string, ReviewPass>(),
    answer: null as null | (() => SafeOpOutcome),
  };
  const watches = new PrWatches({
    storeEntry: () => h.read,
    githubHosts: () => ({ hosts: ["ghe.example.com"] }),
    ...(o.noBody
      ? {}
      : {
          body: async (key: PrKey, cwd: string, block: string): Promise<SafeOpOutcome> => {
            calls.push({ key, cwd, block });
            return h.answer ? h.answer() : { kind: "ran", result: { ok: true, changed: true } };
          },
        }),
    bodyFacts: (head: string) => h.facts.get(head) ?? null,
    persist: (w) => void persisted.push(JSON.parse(JSON.stringify(w))),
    cwd: () => "/work/tree",
    send: (m) => void sent.push(m.content),
    idle: () => true,
    trace: (r) => void traces.push(String(r.outcome)),
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
  /** A newer store entry (the tracker polled again). */
  const set = (s: WatchSnapshot) => {
    h.okAt += 1000;
    h.read = { kind: "entry", snap: { ...s, updatedAt: `t${h.okAt}` }, okAt: h.okAt };
  };
  return { watches, sent, calls, traces, persisted, h, tick, set };
}

const mark = (head: string, run: string) => ({ head, run });

test("a new PASS on the head the host shows: one write with the block, none on the next tick", async () => {
  const x = harness();
  x.h.facts.set(A, pass(A, "r1"));
  x.watches.start(K, snap(), null, false, true, mark(A, "r1"));
  await x.tick();
  assert.deepEqual<typeof x.calls>(x.calls, [], "the seeded pair: nothing to write on the first tick");
  x.h.facts.set(B, pass(B, "r2"));
  x.set(snap({ head: B }));
  await x.tick();
  assert.equal(x.calls.length, 1);
  assert.deepEqual(x.calls[0].key, K);
  assert.equal(x.calls[0].cwd, "/work/tree");
  assert.equal(x.calls[0].block, reviewsBlock(pass(B, "r2")));
  assert.match(x.calls[0].block, /run r2/);
  assert.deepEqual(x.watches.records()[0].bodyMark, mark(B, "r2"));
  x.set(snap({ head: B }));
  await x.tick();
  await x.tick();
  assert.equal(x.calls.length, 1, "the pair is written");
});

test("a same-tree alias keeps the run id and has a new head: the line is written again", async () => {
  const x = harness();
  x.h.facts.set(A, pass(A, "r1"));
  x.watches.start(K, snap(), null, false, true, mark(A, "r1"));
  x.h.facts.set(C, pass(C, "r1"));
  x.set(snap({ head: C }));
  await x.tick();
  assert.equal(x.calls.length, 1);
  assert.match(x.calls[0].block, new RegExp(`on ${C.slice(0, 7)}`));
  assert.deepEqual(x.watches.records()[0].bodyMark, mark(C, "r1"));
});

test("a new run on the same head is written too (the pair, not the head, is the key)", async () => {
  const x = harness();
  x.h.facts.set(A, pass(A, "r1"));
  x.watches.start(K, snap(), null, false, true, mark(A, "r1"));
  x.h.facts.set(A, pass(A, "r2"));
  await x.tick();
  assert.equal(x.calls.length, 1);
  assert.match(x.calls[0].block, /run r2/);
});

test("draft handling off (opened without owned): the line is still written", async () => {
  const x = harness();
  x.watches.start(K, snap(), null, false, true);
  assert.equal(x.watches.records()[0].owned, undefined);
  x.h.facts.set(A, pass(A, "r1"));
  await x.tick();
  assert.equal(x.calls.length, 1);
});

test("a pr_watch or pr_follow watch (not created by pr_create) never gets a write", async () => {
  const x = harness();
  x.h.facts.set(A, pass(A, "r1"));
  x.watches.start(K, snap(), null, false, false);
  await x.tick();
  await x.watches.bodyOpened();
  assert.deepEqual<typeof x.calls>(x.calls, []);
  assert.equal(x.watches.records()[0].opened, undefined);
});

test("a PASS on another head than the host's writes nothing", async () => {
  const x = harness();
  x.watches.start(K, snap(), null, false, true, mark(A, "r1"));
  x.h.facts.set(B, pass(B, "r2"));
  await x.tick();
  assert.deepEqual<typeof x.calls>(x.calls, []);
});

test("a PASS recorded between ticks is written at once by the PASS hook (bodyOpened)", async () => {
  const x = harness();
  x.watches.start(K, snap(), null, false, true, mark(A, "r1"));
  x.h.facts.set(A, pass(A, "r2"));
  await x.watches.bodyOpened();
  assert.equal(x.calls.length, 1);
  await x.watches.bodyOpened();
  await x.tick();
  assert.equal(x.calls.length, 1, "the hook and the tick write one pair once");
});

test("a pending watch (no stored data yet) writes nothing until the host head is known", async () => {
  const x = harness();
  x.h.read = { kind: "waiting" } as StoreRead;
  x.watches.startPending(K, undefined, undefined, false, true, mark(A, "r1"));
  x.h.facts.set(A, pass(A, "r2"));
  await x.watches.bodyOpened();
  assert.deepEqual<typeof x.calls>(x.calls, []);
});

test("opened and the written pair survive a reload; the first tick after it writes nothing", async () => {
  const x = harness();
  x.h.facts.set(A, pass(A, "r1"));
  x.watches.start(K, snap(), null, false, true, mark(A, "r1"));
  const stored = x.persisted.at(-1)!;
  assert.equal(stored[0].opened, true);
  assert.deepEqual(stored[0].bodyMark, mark(A, "r1"));
  const back = latestWatches([{ type: "custom", customType: PRWATCH_ENTRY, data: { v: 2, piSessionId: "s1", watches: stored } }], "s1");
  assert.equal(back.status, "ok");
  const y = harness();
  y.h.facts.set(A, pass(A, "r1"));
  y.watches.restore(back);
  await flush();
  await flush();
  assert.equal(y.watches.records()[0].opened, true);
  assert.deepEqual(y.watches.records()[0].bodyMark, mark(A, "r1"));
  await y.tick();
  assert.deepEqual(y.calls, []);
  y.h.facts.set(A, pass(A, "r2"));
  await y.tick();
  assert.equal(y.calls.length, 1, "a restored opened watch still follows a new PASS");
});

test("a malformed bodyMark is dropped on parse", () => {
  const base = { head: A, failedIds: [], ci: "", mergeable: "", commentIds: [], updatedAt: "", noCi: 0, noCiHead: "", readyHead: "", last: "watching" };
  const rec = (extra: Record<string, unknown>) => parseWatchRecord({ key: K, cwd: "/w", startedAt: 1, state: base, ...extra });
  assert.deepEqual(rec({ opened: true, bodyMark: { head: A, run: "r" } })?.bodyMark, mark(A, "r"));
  assert.equal(rec({ opened: true, bodyMark: { head: "", run: "r" } })?.bodyMark, undefined);
  assert.equal(rec({ opened: true, bodyMark: "x" })?.bodyMark, undefined);
  assert.equal(rec({ opened: "yes" })?.opened, undefined);
});

test("a host without pr_body (GitLab, template): no notice, no further calls", async () => {
  const x = harness();
  x.h.answer = () => ({ kind: "precondition", precondition: "pr_unsupported", message: "pr_body needs gh" }) as SafeOpOutcome;
  x.watches.start(K, snap(), null, false, true);
  x.h.facts.set(A, pass(A, "r1"));
  await x.tick();
  await x.tick();
  x.h.facts.set(B, pass(B, "r2"));
  x.set(snap({ head: B }));
  await x.tick();
  assert.equal(x.calls.length, 1);
  assert.deepEqual(x.sent.filter((m) => /PR body/.test(m)), []);
  assert.equal(x.watches.records()[0].opened, undefined);
});

test("a failed edit: one notice, one retry on the next tick, then the pair is left; a new pair tries again", async () => {
  const x = harness();
  x.h.answer = () => ({ kind: "error", message: "HTTP 502" });
  x.watches.start(K, snap(), null, false, true);
  x.h.facts.set(A, pass(A, "r1"));
  await x.tick();
  assert.equal(x.calls.length, 1);
  assert.equal(x.sent.length, 1);
  assert.match(x.sent[0], /reviews line of the PR body was not updated/);
  assert.match(x.sent[0], /HTTP 502/);
  x.set(snap());
  await x.tick();
  assert.equal(x.calls.length, 2, "one retry");
  assert.equal(x.sent.length, 1, "no second notice");
  x.set(snap());
  await x.tick();
  await x.tick();
  assert.equal(x.calls.length, 2, "the pair is left");
  assert.equal(x.watches.records()[0].bodyMark, undefined);
  x.h.answer = null;
  x.h.facts.set(A, pass(A, "r2"));
  await x.tick();
  assert.equal(x.calls.length, 3, "a new pair is tried");
  assert.deepEqual(x.watches.records()[0].bodyMark, mark(A, "r2"));
});

test("a retry that works clears the failure and stores the pair", async () => {
  const x = harness();
  let n = 0;
  x.h.answer = () => (++n === 1 ? { kind: "error", message: "busy" } : { kind: "ran", result: { ok: true, changed: true } });
  x.watches.start(K, snap(), null, false, true);
  x.h.facts.set(A, pass(A, "r1"));
  await x.tick();
  x.set(snap());
  await x.tick();
  assert.deepEqual(x.watches.records()[0].bodyMark, mark(A, "r1"));
  assert.equal(x.sent.length, 1);
});

test("a watch without the body op or the facts source does nothing", async () => {
  const x = harness({ noBody: true });
  x.watches.start(K, snap(), null, false, true);
  x.h.facts.set(A, pass(A, "r1"));
  await x.tick();
  await x.watches.bodyOpened();
  assert.deepEqual<typeof x.calls>(x.calls, []);
  assert.deepEqual(x.sent, []);
});
