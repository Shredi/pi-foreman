import { test } from "node:test";
import assert from "node:assert/strict";
import { latestWatches, PRWATCH_ENTRY, PrWatches, baselineOf, prDelta, reviewFact, reviewStep } from "../prwatch.ts";
import type { StoreRead, Timers, WatchRecord, WatchSnapshot } from "../prwatch.ts";
import type { PrKey } from "../prhost.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const A = "aaaaaaa111";
const B = "bbbbbbb222";
const C = "ccccccc333";
const snap = (head: string): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head, base: "main", updatedAt: "t0", runs: [] });
const NOT = (head: string, last: string) => `head ${head.slice(0, 7)} not reviewed (last PASS on ${last.slice(0, 7)})`;

function harness(passes: string[], opts: { reviewedHeads?: boolean } = {}) {
  const timers: { fn: () => void; live: boolean }[] = [];
  const fake: Timers = { set: (fn) => (timers.push({ fn, live: true }), timers.length - 1), clear: (h) => void (timers[h as number] && (timers[h as number].live = false)) };
  let read: StoreRead = { kind: "down" };
  const sent: string[] = [];
  const persisted: WatchRecord[][] = [];
  const w = new PrWatches({
    storeEntry: async () => read,
    ...(opts.reviewedHeads === false ? {} : { reviewedHeads: () => passes }),
    cwd: () => "/work",
    persist: (x) => void persisted.push(JSON.parse(JSON.stringify(x))),
    send: (msg) => void sent.push(msg.content),
    idle: () => true,
    trace: () => {},
    intervalMs: () => 5000,
    now: () => 0,
    timers: fake,
  });
  const entry = (head: string, okAt: number): void => void (read = { kind: "entry", snap: snap(head), okAt });
  const tick = async (): Promise<void> => {
    const t = [...timers].reverse().find((x) => x.live);
    if (t) {
      t.live = false;
      t.fn();
    }
    await new Promise((r) => setImmediate(r));
  };
  return { w, sent, persisted, passes, entry, set: (r: StoreRead) => void (read = r), tick, last: () => persisted.at(-1)?.[0].state };
}
const drifts = (sent: string[]): string[] => sent.filter((c) => c.includes("not reviewed"));

test("alert once per head: several ticks on the same unreviewed head send one message", async () => {
  const h = harness([A]);
  h.w.start(K, snap(A), 1);
  for (const okAt of [2, 3, 4]) {
    h.entry(B, okAt);
    await h.tick();
  }
  assert.equal(drifts(h.sent).length, 1);
  assert.match(h.sent[0], new RegExp(`^pi-foreman-pr: PR #7 ${NOT(B, A).replace(/[()]/g, "\\$&")} `));
  assert.deepEqual(h.w.unreviewed(), [K]);
});

test("no alert when the new head already has a PASS; the PASS head becomes the last one", async () => {
  const h = harness([A, B]);
  h.w.start(K, snap(A), 1);
  h.entry(B, 2);
  await h.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.last()?.reviewedHead, B);
  assert.deepEqual(h.w.unreviewed(), []);
});

test("a PASS recorded later clears the state and the token without a store change", async () => {
  const h = harness([A]);
  h.w.start(K, snap(A), 1);
  h.entry(B, 2);
  await h.tick();
  assert.deepEqual(h.w.unreviewed(), [K]);
  h.passes.push(B);
  assert.deepEqual(h.w.unreviewed(), [], "the token is gone at once");
  await h.tick(); // the same okAt: the tick returns early on the store, the state is still cleared
  assert.equal(h.last()?.unreviewedHead ?? "", "");
  assert.equal(h.last()?.reviewedHead, B);
  assert.equal(drifts(h.sent).length, 1);
  // and a further unreviewed head alerts again, naming the new last PASS
  h.entry(C, 3);
  await h.tick();
  assert.equal(drifts(h.sent).length, 2);
  assert.match(drifts(h.sent)[1], new RegExp(NOT(C, B).replace(/[()]/g, "\\$&")));
});

test("a further unreviewed head alerts again, once", async () => {
  const h = harness([A]);
  h.w.start(K, snap(A), 1);
  h.entry(B, 2);
  await h.tick();
  h.entry(C, 3);
  await h.tick();
  h.entry(C, 4);
  await h.tick();
  const got = drifts(h.sent);
  assert.equal(got.length, 2);
  assert.match(got[1], new RegExp(NOT(C, A).replace(/[()]/g, "\\$&")));
});

test("watched PR with no PASS for any head of it: one alert per head and the token, also with PASS records for other heads", async () => {
  const h = harness(["9999999zzz"]);
  h.w.start(K, snap(A), 1);
  h.entry(B, 2);
  await h.tick();
  h.entry(C, 3);
  await h.tick();
  assert.equal(drifts(h.sent).length, 2);
  assert.ok(drifts(h.sent)[0].includes(`head ${B.slice(0, 7)} not reviewed (no review record)`));
  assert.ok(drifts(h.sent)[1].includes(`head ${C.slice(0, 7)} not reviewed (no review record)`));
  assert.deepEqual(h.w.unreviewed(), [K]);
  assert.equal(h.last()?.reviewedHead ?? "", "");
});

test("a watch armed pending (no snap yet) takes the first stored head with a PASS as the last PASS", async () => {
  const h = harness([A]);
  h.w.startPending(K);
  h.entry(A, 1);
  await h.tick();
  h.entry(B, 2);
  await h.tick();
  assert.deepEqual(drifts(h.sent).length, 1);
});

test("a stale, errored or missing store never fires it", async () => {
  const h = harness([A]);
  h.w.start(K, snap(A), 1);
  for (const r of [{ kind: "stale" }, { kind: "error", error: "boom" }, { kind: "waiting" }, { kind: "down" }] as StoreRead[]) {
    h.set(r);
    await h.tick();
  }
  assert.deepEqual(drifts(h.sent), []);
  assert.deepEqual(h.w.unreviewed(), []);
});

test("a watch without the reviewedHeads dependency does not judge reviews", async () => {
  const h = harness([A], { reviewedHeads: false });
  h.w.start(K, snap(A), 1);
  h.entry(B, 2);
  await h.tick();
  assert.equal(h.sent.length, 0);
});

test("restore: an old record without the new fields parses and restores, and judges from then on", async () => {
  const old = { key: K, cwd: "/work", startedAt: 1, state: { head: A, failedIds: [], ci: "", mergeable: "mergeable", commentIds: [], updatedAt: "t0", noCi: 1, noCiHead: "", readyHead: "", last: "watching" } };
  const parsed = latestWatches([{ type: "custom", customType: PRWATCH_ENTRY, data: { v: 2, piSessionId: "s", watches: [old] } }], "s");
  assert.equal(parsed.status === "ok" && parsed.watches.length, 1);
  const h = harness([A]);
  h.w.restore(parsed);
  h.entry(B, 2);
  await h.tick();
  assert.equal(h.w.has(K), true);
  assert.equal(drifts(h.sent).length, 0, "no PASS was seen for this PR yet: silent");
  h.entry(A, 3);
  await h.tick();
  h.entry(C, 4);
  await h.tick();
  assert.equal(drifts(h.sent).length, 1);
});

test("restore: the stored state survives and the same head does not alert again", async () => {
  const a = harness([A]);
  a.w.start(K, snap(A), 1);
  a.entry(B, 2);
  await a.tick();
  assert.equal(drifts(a.sent).length, 1);
  const stored = JSON.parse(JSON.stringify(a.persisted.at(-1)));
  assert.equal(stored[0].state.unreviewedHead, B);
  const b = harness([A]);
  b.entry(B, 5);
  b.w.restore(latestWatches([{ type: "custom", customType: PRWATCH_ENTRY, data: { v: 2, piSessionId: "s", watches: stored } }], "s"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(drifts(b.sent), []);
  assert.deepEqual(b.w.unreviewed(), [K]);
});

test("prDelta: the event is pure state plus the PASS set; without the set nothing changes", () => {
  const base = { ...baselineOf(snap(A)), reviewedHead: A };
  assert.equal(prDelta(base, snap(B), false).delta, null);
  const got = prDelta(base, snap(B), false, undefined, "", new Set([A]));
  assert.deepEqual(got.delta?.events, [NOT(B, A)]);
  assert.equal(got.state.unreviewedHead, B);
  assert.equal(base.unreviewedHead, undefined, "the previous state is not mutated");
});

test("reviewStep and reviewFact: reviewed, drifted, no record", () => {
  const st = baselineOf(snap(A));
  assert.equal(reviewStep(st, B, new Set([A])), `head ${B.slice(0, 7)} not reviewed (no review record)`);
  assert.equal(st.reviewedHead, undefined);
  assert.equal(reviewStep(st, A, new Set([A])), null);
  assert.equal(st.reviewedHead, A);
  assert.equal(reviewFact(A, new Set([A]), ""), `head ${A.slice(0, 7)} reviewed`);
  assert.equal(reviewFact(B, new Set([A]), A), NOT(B, A));
  assert.equal(reviewFact(B, new Set([A]), ""), "no review record");
  assert.equal(reviewFact("", new Set([A]), A), "");
});
