// A pass is not reported while a required check of the base branch has not reported on the head; without a readable required set it waits
// out the settle time (tools.prSettleSeconds). Failures stay immediate. The ready line also needs the forge's merge state not to be blocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { baselineOf, latestWatches, PRWATCH_ENTRY, pollWatch, prDelta, prMessage, PrWatches } from "../prwatch.ts";
import type { Bucket, Run, SettleGate, Timers, WatchSnapshot } from "../prwatch.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import { clearStoreCache, readStoreEntry, storeKey, trackedStateFile } from "../prstore.ts";
import type { PrKey } from "../prhost.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const SHA = "abcdef0123456789";
const SHA2 = "1234567abcdef000";
const SETTLE = 90_000;
const REQ = ["ci-ok", "pr-policy"];

const run = (name: string, bucket: Bucket): Run => ({ id: name, name, bucket, url: `https://h.invalid/${name}` });
const snap = (o: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: SHA, base: "main", updatedAt: "t0", runs: [], ...o });
const at = (now: number): SettleGate => ({ settleMs: SETTLE, now });
const FULL = (b: Bucket): Run[] => [run("pr-policy", "passed"), run("ci-ok", b), run("build", b)];

test("only the policy check present, required set readable: held, then the full list pending, then pass", () => {
  const early = snap({ runs: [run("pr-policy", "passed")], required: REQ });
  const base = baselineOf(early);
  assert.equal(base.ci, "", "armed inside the window: the early pass does not count as reported");
  const first = prDelta(base, early, false, undefined, "", undefined, true, at(0));
  assert.equal(first.delta, null);
  const pending = prDelta(first.state, snap({ runs: FULL("pending"), required: REQ }), false, undefined, "", undefined, true, at(1000));
  assert.equal(pending.delta, null);
  const done = prDelta(pending.state, snap({ runs: FULL("passed"), required: REQ }), false, undefined, "", undefined, true, at(2000));
  assert.deepEqual(done.delta?.events, ["checks finished: pass"], "required reported: no settle time");
});

test("required check pending: held; reported once it passed", () => {
  const base = baselineOf(snap({ runs: [run("pr-policy", "pending"), run("ci-ok", "pending")], required: REQ }));
  const held = prDelta(base, snap({ runs: [run("pr-policy", "passed"), run("ci-ok", "pending")], required: REQ }), false, undefined, "", undefined, true, at(0));
  assert.equal(held.delta, null);
  const done = prDelta(held.state, snap({ runs: [run("pr-policy", "passed"), run("ci-ok", "passed")], required: REQ }), false, undefined, "", undefined, true, at(1));
  assert.deepEqual(done.delta?.events, ["checks finished: pass"]);
});

test("required unreadable (null or absent): a pass is held for the settle time, then reported", () => {
  for (const required of [null, undefined]) {
    const base = baselineOf(snap({ runs: [run("a", "pending")], ...(required === null ? { required } : {}) }));
    const s = snap({ runs: [run("a", "passed")], ...(required === null ? { required } : {}) });
    const first = prDelta(base, s, false, undefined, "", undefined, true, at(0));
    assert.equal(first.delta, null);
    assert.deepEqual(first.state.passSince, { head: SHA, sig: "a#a", at: 0 });
    const inside = prDelta(first.state, s, false, undefined, "", undefined, true, at(SETTLE - 1));
    assert.equal(inside.delta, null);
    const after = prDelta(inside.state, s, false, undefined, "", undefined, true, at(SETTLE));
    assert.deepEqual(after.delta?.events, ["checks finished: pass"]);
    assert.equal(prDelta(after.state, s, false, undefined, "", undefined, true, at(SETTLE + 1)).state.passSince, undefined, "cleared once reported");
  }
});

test("no required checks at all (empty list): the settle time applies", () => {
  const base = baselineOf(snap({ runs: [run("a", "pending")], required: [] }));
  const s = snap({ runs: [run("a", "passed")], required: [] });
  const first = prDelta(base, s, false, undefined, "", undefined, true, at(0));
  assert.equal(first.delta, null);
  assert.deepEqual(prDelta(first.state, s, false, undefined, "", undefined, true, at(SETTLE)).delta?.events, ["checks finished: pass"]);
});

test("settle time off (0) or no gate: the pass is reported at once, as before", () => {
  const base = baselineOf(snap({ runs: [run("a", "pending")], required: null }));
  const s = snap({ runs: [run("a", "passed")], required: null });
  assert.deepEqual(prDelta(base, s, false).delta?.events, ["checks finished: pass"]);
  assert.deepEqual(prDelta(base, s, false, undefined, "", undefined, true, { settleMs: 0, now: 0 }).delta?.events, ["checks finished: pass"]);
});

test("head changes again inside the settle time: the time restarts on the new head", () => {
  const base = baselineOf(snap({ runs: [run("a", "pending")], required: [] }));
  const first = prDelta(base, snap({ runs: [run("a", "passed")], required: [] }), false, undefined, "", undefined, true, at(0));
  const pushed = prDelta(first.state, snap({ head: SHA2, runs: [run("a", "passed")], required: [] }), false, undefined, "", undefined, true, at(SETTLE - 10));
  assert.equal(pushed.delta, null);
  assert.deepEqual(pushed.state.passSince, { head: SHA2, sig: "a#a", at: SETTLE - 10 });
  const early = prDelta(pushed.state, snap({ head: SHA2, runs: [run("a", "passed")], required: [] }), false, undefined, "", undefined, true, at(SETTLE + 10));
  assert.equal(early.delta, null);
  const done = prDelta(early.state, snap({ head: SHA2, runs: [run("a", "passed")], required: [] }), false, undefined, "", undefined, true, at(SETTLE - 10 + SETTLE));
  assert.deepEqual(done.delta?.events, ["checks finished: pass"]);
});

test("run set changes inside the settle time: the time restarts", () => {
  const base = baselineOf(snap({ runs: [run("a", "pending")], required: [] }));
  const first = prDelta(base, snap({ runs: [run("a", "passed")], required: [] }), false, undefined, "", undefined, true, at(0));
  const grown = snap({ runs: [run("a", "passed"), run("b", "passed")], required: [] });
  const second = prDelta(first.state, grown, false, undefined, "", undefined, true, at(SETTLE - 10));
  assert.equal(second.delta, null);
  assert.equal(prDelta(second.state, grown, false, undefined, "", undefined, true, at(SETTLE + 10)).delta, null);
  assert.deepEqual(prDelta(second.state, grown, false, undefined, "", undefined, true, at(SETTLE - 10 + SETTLE)).delta?.events, ["checks finished: pass"]);
});

test("a rerun inside the settle time (a pending run between) restarts it even with the same names", () => {
  const base = baselineOf(snap({ runs: [run("a", "pending")], required: [] }));
  const first = prDelta(base, snap({ runs: [run("a", "passed")], required: [] }), false, undefined, "", undefined, true, at(0));
  const rerun = prDelta(first.state, snap({ runs: [run("a", "pending")], required: [] }), false, undefined, "", undefined, true, at(SETTLE - 10));
  const again = prDelta(rerun.state, snap({ runs: [run("a", "passed")], required: [] }), false, undefined, "", undefined, true, at(SETTLE + 10));
  assert.equal(again.delta, null);
});

test("same names, a new run id inside the settle time: the time restarts", () => {
  const base = baselineOf(snap({ runs: [run("a", "pending")], required: [] }));
  const first = prDelta(base, snap({ runs: [run("a", "passed")], required: [] }), false, undefined, "", undefined, true, at(0));
  const rerun = snap({ runs: [{ ...run("a", "passed"), id: "a-2" }], required: [] });
  const second = prDelta(first.state, rerun, false, undefined, "", undefined, true, at(SETTLE - 10));
  assert.equal(second.delta, null);
  assert.deepEqual(second.state.passSince, { head: SHA, sig: "a#a-2", at: SETTLE - 10 });
  assert.equal(prDelta(second.state, rerun, false, undefined, "", undefined, true, at(SETTLE + 10)).delta, null);
  assert.deepEqual(prDelta(second.state, rerun, false, undefined, "", undefined, true, at(SETTLE - 10 + SETTLE)).delta?.events, ["checks finished: pass"]);
});

test("draft PR: 'checks finished: pass, draft' is held like any pass", () => {
  const base = baselineOf(snap({ runs: [run("a", "pending")], required: [], draft: true }));
  const s = snap({ runs: [run("a", "passed")], required: [], draft: true });
  const first = prDelta(base, s, true, undefined, "", undefined, true, at(0));
  assert.equal(first.delta, null);
  const done = prDelta(first.state, s, true, undefined, "", undefined, true, at(SETTLE));
  assert.deepEqual(done.delta?.events, ["checks finished: pass, draft", "green, still a draft"]);
  const held = prDelta(baselineOf(snap({ runs: [run("pr-policy", "passed")], required: REQ, draft: true })), snap({ runs: [run("pr-policy", "passed")], required: REQ, draft: true }), true, undefined, "", undefined, true, at(SETTLE * 5));
  assert.equal(held.delta, null);
});

test("a failure stays immediate: with a required check missing, and inside the settle time", () => {
  const base = baselineOf(snap({ runs: [run("pr-policy", "pending")], required: REQ }));
  const failed = prDelta(base, snap({ runs: [run("pr-policy", "failed")], required: REQ }), false, undefined, "", undefined, true, at(0));
  assert.deepEqual(failed.delta?.events, ["checks finished: fail"]);
  const base2 = baselineOf(snap({ runs: [run("a", "pending")], required: null }));
  const failed2 = prDelta(base2, snap({ runs: [run("a", "failed")], required: null }), false, undefined, "", undefined, true, at(0));
  assert.deepEqual(failed2.delta?.events, ["checks finished: fail"]);
});

test("blocked merge state holds the ready line; it is sent when the state clears", () => {
  const base = baselineOf(snap({ runs: [run("a", "pending")], required: ["a"], mergeState: "blocked" }));
  const blocked = prDelta(base, snap({ runs: [run("a", "passed")], required: ["a"], mergeState: "blocked" }), true);
  assert.deepEqual(blocked.delta?.events, ["checks finished: pass", "checks passed, merge state blocked (a review or a branch rule is still open)"]);
  assert.equal(blocked.delta?.ready, undefined);
  for (const mergeState of ["dirty", "draft", "unknown"]) {
    assert.equal(prDelta(blocked.state, snap({ runs: [run("a", "passed")], required: ["a"], mergeState }), true).delta, null, mergeState);
  }
  const clear = prDelta(blocked.state, snap({ runs: [run("a", "passed")], required: ["a"], mergeState: "clean" }), true);
  assert.deepEqual(clear.delta?.events, ["ready to merge"]);
  assert.equal(clear.delta?.ready, true);
  // no merge state reported: today's behaviour
  assert.deepEqual(prDelta(baselineOf(snap({ runs: [run("a", "pending")] })), snap({ runs: [run("a", "passed")] }), true).delta?.events, ["checks finished: pass", "ready to merge"]);
});

test("PR watch end to end: policy check alone, then the full list pending, then pass; reported once, on the last snapshot", async () => {
  const timers: { fn: () => void; live: boolean }[] = [];
  const fake: Timers = { set: (fn) => (timers.push({ fn, live: true }), timers.length - 1), clear: (h) => void (timers[h as number] && (timers[h as number].live = false)) };
  let read: { snap: WatchSnapshot; okAt: number } = { snap: snap({ runs: [run("pr-policy", "passed")], required: REQ }), okAt: 1 };
  let clock = 0;
  const sent: string[] = [];
  const w = new PrWatches({ storeEntry: async () => ({ kind: "entry", ...read }), cwd: () => "/work", send: (m) => void sent.push(m.content), idle: () => true, trace: () => {}, intervalMs: () => 5000, settleMs: () => SETTLE, now: () => clock, timers: fake });
  w.start(K, read.snap, 1);
  const tick = async (s: WatchSnapshot, okAt: number): Promise<void> => {
    read = { snap: s, okAt };
    clock += 1000;
    const t = [...timers].reverse().find((x) => x.live);
    if (t) (t.live = false), t.fn();
    await new Promise((r) => setImmediate(r));
  };
  await tick(snap({ runs: [run("pr-policy", "passed")], required: REQ }), 2);
  assert.deepEqual(sent, []);
  await tick(snap({ runs: FULL("pending"), required: REQ }), 3);
  assert.deepEqual(sent, []);
  await tick(snap({ runs: FULL("passed"), required: REQ }), 4);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /checks finished: pass/);
});

test("passSince persists and restores; an old record without it restores too", () => {
  const state = { ...baselineOf(snap({ runs: [run("a", "pending")] })), passSince: { head: SHA, sig: "a", at: 5 } };
  const rec = { key: K, cwd: "/work", startedAt: 1, state };
  const entry = (r: unknown) => [{ type: "custom", customType: PRWATCH_ENTRY, data: { v: 2, piSessionId: "s", watches: [r] } }];
  const back = latestWatches(entry(JSON.parse(JSON.stringify(rec))), "s");
  assert.ok(back.status === "ok");
  if (back.status === "ok") assert.deepEqual(back.watches[0].state.passSince, { head: SHA, sig: "a", at: 5 });
  const { passSince: _drop, ...old } = state;
  const oldBack = latestWatches(entry({ ...rec, state: old }), "s");
  assert.ok(oldBack.status === "ok");
  if (oldBack.status === "ok") assert.equal(oldBack.watches[0].state.passSince, undefined);
  const bad = latestWatches(entry({ ...rec, state: { ...state, passSince: { head: 1 } } }), "s");
  assert.ok(bad.status === "ok");
  if (bad.status === "ok") assert.equal(bad.watches[0].state.passSince, undefined);
});

test("the stored snapshot carries required and mergeState; one without them reads as before", () => {
  const NOW = 10_000_000;
  const read = (extra: Record<string, unknown>) => {
    clearStoreCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-settle-"));
    fs.mkdirSync(path.dirname(trackedStateFile(dir)), { recursive: true });
    const s = { state: "open", mergeable: "mergeable", head: "abc", base: "main", updatedAt: "t1", runs: [{ id: "1", name: "ci", bucket: "passed", url: "u" }], ...extra };
    fs.writeFileSync(trackedStateFile(dir), JSON.stringify({ v: 1, trackedAt: NOW - 1000, prs: { [storeKey("acme/app", 7)]: { repo: "acme/app", number: 7, at: NOW, snap: s, okAt: NOW - 1000 } } }));
    const r = readStoreEntry(dir, K, NOW, true);
    assert.equal(r.kind, "entry");
    return r.kind === "entry" ? r.snap : null;
  };
  const a = read({ required: ["ci-ok", 3], mergeState: "blocked" });
  assert.deepEqual(a?.required, ["ci-ok"]);
  assert.equal(a?.mergeState, "blocked");
  assert.equal(read({ required: null })?.required, null);
  const none = read({});
  assert.equal("required" in (none ?? {}), false);
  assert.equal("mergeState" in (none ?? {}), false);
});

test("pollWatch: the pr_batch answer's required and mergeState reach the snapshot; null stays unreadable", async () => {
  const ran = (result: Record<string, unknown>): SafeOpOutcome => ({ kind: "ran", result: { ok: true, ...result } });
  const answer = (extra: Record<string, unknown>) => async () => ran({ prs: [{ repo: "acme/app", number: 7, state: "open", mergeable: "mergeable", headSha: SHA, baseRef: "main", updatedAt: "t0", runs: [], ...extra }], errors: [] });
  const a = (await pollWatch(answer({ required: ["ci-ok"], mergeState: "blocked" }) as never, K, { updatedAt: "t0" })) as { snap: WatchSnapshot };
  assert.deepEqual(a.snap.required, ["ci-ok"]);
  assert.equal(a.snap.mergeState, "blocked");
  const b = (await pollWatch(answer({ required: null, mergeState: null }) as never, K, { updatedAt: "t0" })) as { snap: WatchSnapshot };
  assert.equal(b.snap.required, null);
  assert.equal("mergeState" in b.snap, false);
});

// ---- merge state and the ready line (child sessions)
const BLOCKED = "checks passed, merge state blocked (a review or a branch rule is still open)";
const BEHIND = "checks passed, merge state behind the base";
const passing = (o: Partial<WatchSnapshot> = {}): WatchSnapshot => snap({ runs: [run("a", "passed")], required: ["a"], ...o });
const pendingBase = (): ReturnType<typeof baselineOf> => baselineOf(snap({ runs: [run("a", "pending")], required: ["a"] }));

test("armed with start inside the early window, required set empty or unreadable: the ready line waits out the settle time", () => {
  for (const required of [[], null]) {
    const early = snap({ runs: [run("a", "passed")], required });
    const base = baselineOf(early);
    assert.equal(base.ci, `${SHA}:pass`, "the baseline counts the early pass as reported");
    const first = prDelta(base, early, true, undefined, "", undefined, true, at(0));
    assert.equal(first.delta, null, "no ready line on the first tick");
    const pending = prDelta(first.state, snap({ runs: [run("a", "passed"), run("b", "pending")], required }), true, undefined, "", undefined, true, at(1000));
    assert.equal(pending.delta, null);
    const full = snap({ runs: [run("a", "passed"), run("b", "passed")], required });
    const settling = prDelta(pending.state, full, true, undefined, "", undefined, true, at(2000));
    assert.deepEqual(settling.delta?.events, undefined);
    assert.equal(prDelta(settling.state, full, true, undefined, "", undefined, true, at(2000 + SETTLE - 1)).delta, null);
    assert.deepEqual(prDelta(settling.state, full, true, undefined, "", undefined, true, at(2000 + SETTLE)).delta?.events, ["checks finished: pass", "ready to merge"]);
  }
  // the unchanged early set alone: held on the first ticks, the ready line after the settle time
  const early = snap({ runs: [run("a", "passed")], required: [] });
  const first = prDelta(baselineOf(early), early, true, undefined, "", undefined, true, at(0));
  assert.equal(first.delta, null);
  assert.deepEqual(prDelta(first.state, early, true, undefined, "", undefined, true, at(SETTLE)).delta?.events, ["ready to merge"]);
  assert.equal(prDelta(prDelta(first.state, early, true, undefined, "", undefined, true, at(SETTLE)).state, early, true, undefined, "", undefined, true, at(SETTLE + 5)).delta, null, "sent once");
});

test("merge state unknown: the ready line is held, then sent once the state settles", () => {
  const held = prDelta(pendingBase(), passing({ mergeState: "unknown" }), true);
  assert.deepEqual(held.delta?.events, ["checks finished: pass"]);
  assert.equal(prDelta(held.state, passing({ mergeState: "unknown" }), true).delta, null);
  const clear = prDelta(held.state, passing({ mergeState: "clean" }), true);
  assert.deepEqual(clear.delta?.events, ["ready to merge"]);
  assert.equal(clear.delta?.ready, true);
});

test("merge state dirty: no ready line and no new line", () => {
  const r = prDelta(pendingBase(), passing({ mergeState: "dirty" }), true);
  assert.deepEqual(r.delta?.events, ["checks finished: pass"]);
  assert.equal(prDelta(r.state, passing({ mergeState: "dirty" }), true).delta, null);
  assert.equal(r.delta?.ready, undefined);
});

test("merge state draft: no ready line and no new line", () => {
  const r = prDelta(pendingBase(), passing({ mergeState: "draft" }), true);
  assert.deepEqual(r.delta?.events, ["checks finished: pass"]);
  assert.equal(r.delta?.ready, undefined);
  assert.equal(prDelta(r.state, passing({ mergeState: "draft" }), true).delta, null);
});

test("merge state blocked: no ready line, one line naming the state", () => {
  const r = prDelta(pendingBase(), passing({ mergeState: "blocked" }), true);
  assert.deepEqual(r.delta?.events, ["checks finished: pass", BLOCKED]);
  assert.equal(r.delta?.ready, undefined);
  assert.equal(r.delta?.notReady, BLOCKED);
  assert.match(prMessage(7, r.delta as NonNullable<typeof r.delta>).content, /report to the parent: PR #7 checks passed, merge state blocked/);
});

test("merge state behind: no ready line, one line naming the state", () => {
  const r = prDelta(pendingBase(), passing({ mergeState: "behind" }), true);
  assert.deepEqual(r.delta?.events, ["checks finished: pass", BEHIND]);
  assert.equal(r.delta?.ready, undefined);
});

test("blocked and behind are sent once per head and state; a new head or a changed state reports again", () => {
  const first = prDelta(pendingBase(), passing({ mergeState: "blocked" }), true);
  assert.equal(prDelta(first.state, passing({ mergeState: "blocked" }), true).delta, null);
  assert.deepEqual(prDelta(first.state, passing({ mergeState: "behind" }), true).delta?.events, [BEHIND]);
  const pushed = prDelta(first.state, passing({ head: SHA2, mergeState: "blocked" }), true);
  assert.deepEqual(pushed.delta?.events, ["checks finished: pass", BLOCKED]);
  assert.equal(prDelta(pushed.state, passing({ head: SHA2, mergeState: "blocked" }), true).delta, null);
  // a parent session (not a child) gets none of it
  assert.deepEqual(prDelta(pendingBase(), passing({ mergeState: "blocked" }), false).delta?.events, ["checks finished: pass"]);
});

test("blocked, then clean on the same head: the ready line is sent then", () => {
  const blocked = prDelta(pendingBase(), passing({ mergeState: "blocked" }), true);
  const clean = prDelta(blocked.state, passing({ mergeState: "clean" }), true);
  assert.deepEqual(clean.delta?.events, ["ready to merge"]);
  assert.equal(prDelta(clean.state, passing({ mergeState: "blocked" }), true).delta, null, "blocked again on the same head: already reported");
});

test("no merge state reported: the ready line as before", () => {
  const r = prDelta(pendingBase(), passing(), true);
  assert.deepEqual(r.delta?.events, ["checks finished: pass", "ready to merge"]);
});

test("notReadyKey persists and restores; an old record without it restores too", () => {
  const state = { ...baselineOf(snap({ runs: [run("a", "pending")] })), notReadyKey: `${SHA}:blocked` };
  const rec = { key: K, cwd: "/work", startedAt: 1, state };
  const entry = (r: unknown) => [{ type: "custom", customType: PRWATCH_ENTRY, data: { v: 2, piSessionId: "s", watches: [r] } }];
  const back = latestWatches(entry(JSON.parse(JSON.stringify(rec))), "s");
  assert.ok(back.status === "ok");
  if (back.status === "ok") assert.equal(back.watches[0].state.notReadyKey, `${SHA}:blocked`);
  const { notReadyKey: _drop, ...old } = state;
  const oldBack = latestWatches(entry({ ...rec, state: old }), "s");
  assert.ok(oldBack.status === "ok");
  if (oldBack.status === "ok") assert.equal(oldBack.watches[0].state.notReadyKey, undefined);
});
