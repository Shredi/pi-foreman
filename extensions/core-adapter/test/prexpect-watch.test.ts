// The expected-checks veto through the whole watch (PrWatches over a fake store, like prwatch-leaving-draft.test.ts): the early pass in the gap before the CI run exists, a watch
// armed in the gap, a managed draft whose checks never start in draft, and a readable required list with no runs. The facts are given as the tracker stores them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXPECT_BOUND_MS, PrWatches, checksOf } from "../prwatch.ts";
import type { Run, StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import type { PrKey } from "../prhost.ts";
import type { SafeOpOutcome } from "../safeops.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const A = "a".repeat(40);
const SETTLE = 90_000;
const BOUND = EXPECT_BOUND_MS;
const OVERDUE = `expected checks not reported for ${A.slice(0, 7)} after 10 min; not counted as passed`;
const run = (name: string, bucket: Run["bucket"]): Run => ({ id: name, name, bucket, url: "u", expected: true });
const snap = (o: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: A, base: "main", updatedAt: "t0", runs: [], required: null, comments: [], draft: false, mergeState: "clean", ...o });
const flush = () => new Promise((r) => setImmediate(r));

function harness(o: { child?: boolean; owned?: boolean; label?: boolean; start: WatchSnapshot }) {
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const sent: string[] = [];
  const drafts: boolean[] = [];
  const labels: boolean[] = [];
  const h = { read: { kind: "entry", snap: o.start, okAt: 1000 } as StoreRead, okAt: 1000, clock: 0 };
  const watches: PrWatches = new PrWatches({
    storeEntry: () => h.read,
    githubHosts: () => ({ hosts: ["github.com"] }),
    reviewFacts: () => "ok",
    draftFlow: () => true,
    draft: async (_k, _c, draft): Promise<SafeOpOutcome> => (drafts.push(draft), { kind: "ran", result: { ok: true } }),
    label: async (_k, _c, _l, on) => (labels.push(on), { kind: "ran", result: { changed: true } }),
    readyLabel: () => (o.label ? "ready" : ""),
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
  // one tick: the store entry changes (a new poll answer) and the clock moves to `at`
  const tick = async (s: WatchSnapshot, at: number) => {
    h.clock = at;
    h.okAt += 1000;
    h.read = { kind: "entry", snap: { ...s, updatedAt: `t${h.okAt}` }, okAt: h.okAt };
    fns.shift()?.();
    await flush();
    await flush();
  };
  watches.start(K, o.start, null, o.owned ?? false);
  return { watches, sent, drafts, labels, tick, h };
}

const finished = (sent: string[]): string[] => sent.filter((m) => m.includes("checks finished"));

test("a watch armed on a pending snapshot in the gap: the early pass is not sent however late; the expected checks arrive and the real pass is sent", async () => {
  const gap = { missing: ["ci-build", "ci-test"] };
  const x = harness({ start: snap({ runs: [run("quick", "pending")], expect: gap }) });
  // the quick check finishes, the CI run is not there yet: on the code before this change this sends "checks finished: pass" once the settle time has stood
  for (const at of [0, SETTLE, SETTLE * 3, BOUND - 1000]) await x.tick(snap({ runs: [run("quick", "passed")], expect: gap }), at);
  assert.deepEqual(finished(x.sent), []);
  assert.equal(x.sent.some((m) => m.includes("ready to merge")), false);
  const all = snap({ runs: [run("quick", "passed"), run("ci-build", "passed"), run("ci-test", "passed")] });
  await x.tick(all, BOUND);
  assert.deepEqual(finished(x.sent), [], "the settle hold starts when the expected checks have reported");
  await x.tick(all, BOUND + SETTLE);
  assert.equal(finished(x.sent).length, 1);
  assert.match(finished(x.sent)[0], /checks finished: pass/);
});

test("a watch armed during the gap later reports the real pass, and the ready label waits for it", async () => {
  const gap = { missing: ["ci"] };
  const x = harness({ child: true, owned: true, label: true, start: snap({ runs: [run("quick", "passed")], expect: gap }) });
  for (const at of [0, SETTLE * 2, BOUND - 1000]) await x.tick(snap({ runs: [run("quick", "passed")], expect: gap }), at);
  assert.deepEqual(x.sent, []);
  assert.deepEqual(x.labels, []);
  const all = snap({ runs: [run("quick", "passed"), run("ci", "passed")] });
  await x.tick(all, BOUND);
  assert.deepEqual(x.labels, [], "inside the settle hold of the real result");
  await x.tick(all, BOUND + SETTLE);
  assert.equal(finished(x.sent).length, 1);
  assert.ok(x.sent.at(-1)?.includes("ready to merge"));
  assert.deepEqual(x.labels, [true]);
});

const variants: [string, Partial<WatchSnapshot>, Run[]][] = [
  ["zero runs", { runs: [], expect: { missing: ["ci"] } }, [run("quick", "passed"), run("ci", "passed")]],
  ["one passed quick check", { runs: [run("quick", "passed")], expect: { missing: ["ci"] } }, [run("quick", "passed"), run("ci", "passed")]],
  ["a readable required list", { runs: [run("lint", "passed")], required: ["ci-ok"], expect: { missing: ["ci-ok"] } }, [run("lint", "passed"), run("ci-ok", "passed")]],
];
for (const [title, part, done] of variants) {
  test(`a managed draft whose expected checks never start in draft leaves draft at the bound, then gets the real result: ${title}`, async () => {
    const draft = (overdue: boolean) => snap({ ...part, draft: true, mergeState: "draft", expect: { ...part.expect!, ...(overdue ? { overdue: true as const } : {}) } });
    const x = harness({ child: false, owned: true, start: draft(false) });
    await x.tick(draft(false), 0);
    await x.tick(draft(false), BOUND - 1000);
    assert.deepEqual(x.drafts, [], "still inside the bound: the leave step waits");
    await x.tick(draft(true), BOUND);
    assert.deepEqual(x.drafts, [false], "at the bound it leaves draft through the real leave path");
    assert.deepEqual(x.sent, [], "no line and no pass at that point");
    const open = snap({ ...part, draft: false, expect: { ...part.expect!, overdue: true } });
    await x.tick(open, BOUND * 2);
    assert.deepEqual(x.sent.filter((m) => m.includes(OVERDUE)).length, 1, "the line follows on the non-draft PR");
    assert.deepEqual(finished(x.sent), []);
    await x.tick(snap({ ...part, runs: done, expect: undefined, draft: false }), BOUND * 3);
    await x.tick(snap({ ...part, runs: done, expect: undefined, draft: false }), BOUND * 3 + SETTLE);
    assert.equal(finished(x.sent).length, 1, "the real result on the non-draft PR");
    assert.match(finished(x.sent)[0], /checks finished: pass/);
  });
}

test("a readable required list with zero runs: no no-checks line, the label rule says running, the leave-draft step waits, the pill's no-checks input stays false", async () => {
  const facts = { missing: ["ci-ok"] };
  const s = snap({ runs: [], required: ["ci-ok"], expect: facts, draft: true, mergeState: "draft" });
  const x = harness({ child: true, owned: true, label: true, start: s });
  for (const at of [0, SETTLE, SETTLE * 3, BOUND - 1000]) await x.tick(s, at);
  assert.deepEqual(x.sent, [], "no no-checks line and no ready line");
  assert.deepEqual(x.drafts, [], "the leave-draft step waits");
  assert.deepEqual(x.labels, []);
  const live = x.watches.reviewLive();
  assert.equal(live.length, 1);
  assert.equal(live[0].noChecks, undefined);
  const base = { head: A, failedIds: [], ci: "", mergeable: "mergeable" as const, commentIds: [], updatedAt: "t", noCi: 5, noCiHead: "", readyHead: "", last: "x" };
  assert.equal(checksOf({ ...base, noCi: 0 }, s, BOUND * 5, SETTLE), "running");
});
