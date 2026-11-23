// D101 (plan v2) through the whole watch (PrWatches over a fake store): case 1 (learned merge-time check) passes at once and sets the ready label; case 2 (a name that ran before
// the merge) never passes; case 3 (not learnable) sends the fallback line after the hold, no pass and no label, and a managed draft leaves draft once a pre-pr PASS stands on the head.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXPECT_BOUND_MS, PrWatches } from "../prwatch.ts";
import type { Run, StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import type { PrKey } from "../prhost.ts";
import type { SafeOpOutcome } from "../safeops.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const A = "a".repeat(40);
const SETTLE = 90_000;
const BOUND = EXPECT_BOUND_MS;
const FALLBACK = "checks passed, waiting on required checks";
const REPORT = `report to the parent: PR #7 ${FALLBACK} (not learned yet, no ready label)`;
const run = (name: string, bucket: Run["bucket"]): Run => ({ id: name, name, bucket, url: "u" });
const base = (o: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: A, base: "main", updatedAt: "t0", runs: [run("check", "passed")], required: ["check", "gate"], comments: [], draft: false, mergeState: "blocked", ...o });
const caseOne = (o: Partial<WatchSnapshot> = {}) => base({ learn: "merge-time", ...o });
const caseTwo = (o: Partial<WatchSnapshot> & { overdue?: true } = {}) => { const { overdue, ...rest } = o; return base({ learn: "pre-merge", expect: { missing: ["gate"], ...(overdue ? { overdue } : {}) }, ...rest }); };
const caseThree = (o: Partial<WatchSnapshot> & { overdue?: true } = {}) => { const { overdue, ...rest } = o; return base({ expect: { missing: ["gate"], ...(overdue ? { overdue } : {}) }, ...rest }); };
const flush = () => new Promise((r) => setImmediate(r));

function harness(start: WatchSnapshot, o: { child?: boolean; owned?: boolean; settleMs?: number } = {}) {
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
    settleMs: () => o.settleMs ?? SETTLE,
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

test("case 1, a child watch: the pass comes at once with the name below, the blocked line follows the merge state, the ready label is on", async () => {
  const x = harness(base({ runs: [run("check", "pending")] }), { child: true });
  await x.tick(caseOne(), 0);
  assert.equal(x.sent.length, 1);
  assert.match(x.sent[0], /checks finished: pass/);
  assert.ok(x.sent[0].includes("- waiting gate"));
  assert.ok(!x.sent[0].split("\n")[0].includes("gate"));
  assert.ok(x.sent[0].includes("checks passed, merge state blocked"));
  assert.equal(x.sent[0].includes("ready to merge"), false);
  assert.deepEqual(x.labels, [true]);
});

test("case 1, a clean merge state: the child's ready line runs", async () => {
  const x = harness(base({ runs: [run("check", "pending")], mergeState: "clean" }), { child: true });
  await x.tick(caseOne({ mergeState: "clean" }), 0);
  assert.ok(x.sent[0].includes("ready to merge"));
  assert.deepEqual(x.labels, [true]);
});

test("case 2: no pass, no label, no fallback line however long; the overdue line names the pre-merge name; a managed draft leaves draft on the PASS", async () => {
  const d = (o: Partial<WatchSnapshot> & { overdue?: true } = {}) => caseTwo({ draft: true, mergeState: "draft", ...o });
  const x = harness(d(), { child: true, owned: true });
  await x.tick(d(), 0);
  await x.tick(d(), SETTLE * 3);
  assert.deepEqual<string[]>(x.sent, []);
  assert.ok(x.drafts.length > 0 && x.drafts.every((t) => t === false), "a PASS stands on the head: the draft leaves at once");
  await x.tick(d({ overdue: true }), BOUND);
  assert.ok(x.drafts.every((t) => t === false));
  await x.tick(caseTwo({ overdue: true }), BOUND * 2);
  assert.equal(x.sent.length, 1);
  assert.ok(x.sent[0].includes("expected checks not reported"));
  assert.ok(x.sent[0].includes("- not reported gate"));
  assert.equal(x.sent[0].includes(FALLBACK), false);
  assert.deepEqual(x.labels, []);
});

test("case 3, a child: the fallback line and the report line after the hold, no pass, no ready line, no label", async () => {
  const x = harness(caseThree({ runs: [run("check", "pending")] }), { child: true });
  await x.tick(caseThree(), 0);
  assert.deepEqual<string[]>(x.sent, []);
  await x.tick(caseThree(), SETTLE);
  assert.equal(x.sent.length, 1);
  assert.ok(x.sent[0].split("\n")[0].includes(FALLBACK));
  assert.ok(x.sent[0].includes("- waiting gate"));
  assert.ok(x.sent[0].includes(REPORT));
  assert.equal(x.sent[0].includes("checks finished"), false);
  assert.equal(x.sent[0].includes("ready to merge"), false);
  await x.tick(caseThree(), SETTLE * 4);
  assert.equal(x.sent.length, 1, "once per head");
  assert.deepEqual(x.labels, []);
});

test("case 3, settle time 0: the fallback line comes at once", async () => {
  const x = harness(caseThree({ runs: [run("check", "pending")] }), { child: true, settleMs: 0 });
  await x.tick(caseThree(), 0);
  assert.equal(x.sent.length, 1);
  assert.ok(x.sent[0].includes(REPORT));
});

test("case 3, a managed draft: the event without a report line, the leave on the PASS without a green pass, then the report line once on the non-draft PR", async () => {
  const d = (o: Partial<WatchSnapshot> & { overdue?: true } = {}) => caseThree({ draft: true, mergeState: "draft", ...o });
  const x = harness(d({ runs: [run("check", "pending")] }), { child: true, owned: true });
  await x.tick(d(), 0);
  await x.tick(d(), SETTLE);
  assert.equal(x.sent.length, 1);
  assert.ok(x.sent[0].split("\n")[0].includes(`${FALLBACK}, draft`));
  assert.equal(x.sent[0].includes("report to the parent"), false, "a draft gets no report line");
  assert.ok(x.drafts.every((t) => t === false), "a PASS stands on the head: the leave path runs before the bound");
  await x.tick(d(), BOUND - 1000);
  await x.tick(d({ overdue: true }), BOUND);
  assert.ok(x.drafts.length > 0 && x.drafts.every((t) => t === false), "left through the real leave path");
  assert.equal(x.sent.length, 1);
  await x.tick(caseThree({ overdue: true }), BOUND + 1000);
  assert.equal(x.sent.length, 2);
  assert.ok(x.sent[1].includes(REPORT));
  assert.equal(x.sent.some((m) => m.includes("checks finished") || m.includes("expected checks not reported")), false);
  await x.tick(caseThree({ overdue: true }), BOUND + 2000);
  assert.equal(x.sent.length, 2, "once");
  assert.deepEqual(x.labels, []);
});

test("case 3, a person marks the draft ready: the report line follows once", async () => {
  const x = harness(caseThree({ draft: true, mergeState: "draft", runs: [run("check", "pending")] }), { child: true });
  await x.tick(caseThree({ draft: true, mergeState: "draft" }), 0);
  await x.tick(caseThree({ draft: true, mergeState: "draft" }), SETTLE);
  assert.equal(x.sent.length, 1);
  assert.equal(x.sent[0].includes("report to the parent"), false);
  await x.tick(caseThree(), SETTLE * 2);
  assert.equal(x.sent.length, 2);
  assert.ok(x.sent[1].includes(REPORT));
  await x.tick(caseThree(), SETTLE * 3);
  assert.equal(x.sent.length, 2);
});
