// The ready label of the PR watch (prwatch.ts labelStep, prready.ts labelTarget): the label goes on when the PR is ready and comes off when it is not, and a
// human's change is never undone. A fake host holds the PR's labels and answers like the pr_label op (changed true or false). In-process, no child processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DRAFT_FAIL_CAP, PrWatches, latestWatches, parseWatchRecord, pollWatch, pollWatchBatch } from "../prwatch.ts";
import type { RunOp, StoreRead, Timers, WatchRecord, WatchSnapshot } from "../prwatch.ts";
import { PR_TOOL_NAMES } from "../gitpack.ts";
import { labelTarget, reviewFactsForHead } from "../prready.ts";
import type { ReviewFacts } from "../prready.ts";
import { clearStoreCache, readStoreEntry, storeKey, trackedStateFile } from "../prstore.ts";
import type { ReviewRecord } from "../reviews.ts";
import type { PrKey } from "../prhost.ts";
import type { SafeOpOutcome } from "../safeops.ts";

const K: PrKey = { host: "ghe.example.com", repo: "acme/app", n: 7 };
const A = "a".repeat(40);
const B = "b".repeat(40);
const snap = (o: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: A, base: "main", updatedAt: "t1", runs: [{ id: "1", name: "ci", bucket: "passed", url: "u" }], comments: [], draft: false, mergeState: "clean", ...o });
const failing = [{ id: "1", name: "ci", bucket: "failed" as const, url: "u" }];
const pending = [{ id: "1", name: "ci", bucket: "pending" as const, url: "u" }];
const flush = () => new Promise((r) => setImmediate(r));

interface Opts {
  child?: boolean;
  owned?: boolean;
  label?: string;
  noFacts?: boolean;
  noOp?: boolean;
  flow?: boolean;
  gate?: boolean;
  start?: WatchSnapshot;
}

function harness(o: Opts = {}) {
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const sent: string[] = [];
  const calls: { key: PrKey; cwd: string; label: string; on: boolean }[] = [];
  const draftCalls: boolean[] = [];
  const traces: string[] = [];
  const persisted: WatchRecord[][] = [];
  const host = { labels: new Set<string>() };
  const h = {
    read: { kind: "entry", snap: o.start ?? snap(), okAt: 1000 } as StoreRead,
    clock: 0,
    label: o.label ?? "ready",
    facts: (_head: string): ReviewFacts => "ok",
    gate: o.gate ?? true,
    answer: null as null | (() => SafeOpOutcome),
    hold: null as null | Promise<void>,
    okAt: 1000,
  };
  const has = (label: string) => [...host.labels].some((l) => l.toLowerCase() === label.toLowerCase());
  const watches: PrWatches = new PrWatches({
    storeEntry: () => h.read,
    githubHosts: () => ({ hosts: ["ghe.example.com"] }),
    ...(o.noFacts ? {} : { reviewFacts: (head: string) => h.facts(head) }),
    reviewGate: () => h.gate,
    draftFlow: () => o.flow ?? true,
    draft: async (_k, _c, draft) => (draftCalls.push(draft), { kind: "ran", result: { ok: true } }),
    ...(o.noOp
      ? {}
      : {
          label: async (key: PrKey, cwd: string, label: string, on: boolean): Promise<SafeOpOutcome> => {
            calls.push({ key, cwd, label, on });
            if (h.hold) await h.hold;
            if (h.answer) return h.answer();
            if (has(label) === on) return { kind: "ran", result: { changed: false } };
            if (on) host.labels.add(label);
            else for (const l of [...host.labels]) if (l.toLowerCase() === label.toLowerCase()) host.labels.delete(l);
            return { kind: "ran", result: { changed: true } };
          },
        }),
    readyLabel: () => h.label,
    persist: (w) => void persisted.push(JSON.parse(JSON.stringify(w))),
    cwd: () => "/work/tree",
    child: () => o.child ?? false,
    send: (m) => void sent.push(m.content),
    idle: () => true,
    trace: (r) => void traces.push(String(r.outcome)),
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
  /** A newer store entry (the tracker polled again). */
  const set = (s: WatchSnapshot) => {
    h.okAt += 1000;
    h.read = { kind: "entry", snap: { ...s, updatedAt: `t${h.okAt}` }, okAt: h.okAt };
  };
  const start = (s: WatchSnapshot = o.start ?? snap(), owned = o.owned ?? false) => watches.start(K, s, null, owned);
  const ops = () => calls.map((c) => `${c.on ? "+" : "-"}${c.label}`);
  return { watches, sent, calls, draftCalls, traces, persisted, host, h, tick, set, start, ops, pending: () => fns.length, has };
}

// ---------------------------------------------------------------- the target

test("labelTarget: on at ready, with no checks confirmed, while blocked, and while a required review is open", () => {
  const ready = { facts: "ok" as ReviewFacts, checks: "green" as const, mergeable: "mergeable" as const, mergeState: "clean", draft: false };
  assert.equal(labelTarget(ready), true);
  assert.equal(labelTarget({ ...ready, mergeState: "" }), true);
  assert.equal(labelTarget({ ...ready, mergeState: "blocked" }), true);
  assert.equal(labelTarget({ ...ready, mergeState: "blocked", reviewDecision: "review_required" }), true);
  assert.equal(labelTarget({ ...ready, reviewDecision: "approved" }), true);
});

test("labelTarget: off for head not reviewed, rework, draft, failing checks, conflict and changes requested", () => {
  const ready = { facts: "ok" as ReviewFacts, checks: "green" as const, mergeable: "mergeable" as const, mergeState: "clean", draft: false };
  assert.equal(labelTarget({ ...ready, facts: "unreviewed" }), false);
  assert.equal(labelTarget({ ...ready, facts: "wip" }), false);
  assert.equal(labelTarget({ ...ready, draft: true }), false);
  assert.equal(labelTarget({ ...ready, checks: "red" }), false);
  assert.equal(labelTarget({ ...ready, mergeable: "conflicting" }), false);
  assert.equal(labelTarget({ ...ready, mergeState: "dirty" }), false);
  assert.equal(labelTarget({ ...ready, reviewDecision: "changes_requested" }), false);
});

test("labelTarget: no change while checks run, mergeable or merge state is unknown, or the PR is behind", () => {
  const ready = { facts: "ok" as ReviewFacts, checks: "green" as const, mergeable: "mergeable" as const, mergeState: "clean", draft: false };
  assert.equal(labelTarget({ ...ready, checks: "running" }), null);
  assert.equal(labelTarget({ ...ready, mergeable: "unknown" }), null);
  assert.equal(labelTarget({ ...ready, mergeState: "unknown" }), null);
  assert.equal(labelTarget({ ...ready, mergeState: "behind" }), null);
});

// ---------------------------------------------------------------- the watch puts the label on and takes it off

test("on at ready: one add with the watch's repository, host and directory", async () => {
  const x = harness();
  x.start();
  await x.tick();
  assert.deepEqual(x.calls, [{ key: K, cwd: "/work/tree", label: "ready", on: true }]);
  assert.ok(x.has("ready"));
  assert.deepEqual(x.traces.filter((t) => t.startsWith("label")), ["label_on"]);
});

test("on with checks confirmed none (the second tick without checks)", async () => {
  const x = harness({ start: snap({ runs: [] }) });
  x.start();
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready"]);
});

test("on while the merge state is blocked, also with review required", async () => {
  const x = harness();
  x.start(snap({ mergeState: "blocked", reviewDecision: "review_required" }));
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready"]);
});

test("off on a new head without a PASS", async () => {
  const x = harness();
  x.h.facts = (head) => (head === A ? "ok" : "unreviewed");
  x.start();
  await x.tick();
  x.set(snap({ head: B }));
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready", "-ready"]);
  assert.ok(!x.has("ready"));
});

test("off on a PR sent back by rework", async () => {
  const x = harness();
  x.start();
  await x.tick();
  x.h.facts = () => "wip";
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready", "-ready"]);
});

test("off on draft", async () => {
  const x = harness();
  x.start();
  await x.tick();
  x.set(snap({ draft: true, mergeState: "draft" }));
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready", "-ready"]);
});

test("off while changes are requested; on again on the same head when that decision goes away", async () => {
  const x = harness();
  x.start();
  await x.tick();
  x.set(snap({ reviewDecision: "changes_requested" }));
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready", "-ready"]);
  x.set(snap({ reviewDecision: "approved" }));
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready", "-ready", "+ready"], "the watch's own removal is followed by an add on the same head");
  assert.ok(x.has("ready"));
});

test("an absent review decision has no effect", async () => {
  const x = harness();
  x.start(snap());
  await x.tick();
  x.set(snap({ mergeState: "blocked" }));
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready"]);
});

test("off on failing checks and on a conflict", async () => {
  const x = harness();
  x.start();
  await x.tick();
  x.set(snap({ runs: failing }));
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready", "-ready"]);
  const y = harness();
  y.start();
  await y.tick();
  y.set(snap({ mergeable: "conflicting", mergeState: "dirty" }));
  await y.tick();
  assert.deepEqual(y.ops(), ["+ready", "-ready"]);
});

test("no change while checks run, mergeable is unknown, the merge state is unknown or behind", async () => {
  for (const change of [{ runs: pending }, { mergeable: "unknown" as const }, { mergeState: "unknown" }, { mergeState: "behind" }]) {
    const x = harness();
    x.start();
    await x.tick();
    x.set(snap(change));
    await x.tick();
    await x.tick();
    assert.deepEqual(x.ops(), ["+ready"], JSON.stringify(change));
  }
  // nothing was put on either: no call while the PR is not yet ready
  const y = harness({ start: snap({ runs: pending }) });
  y.start();
  await y.tick();
  await y.tick();
  assert.deepEqual(y.ops(), []);
});

test("not added twice for one head, and a PR that is not ready and not labelled makes no call", async () => {
  const x = harness();
  x.start();
  for (let i = 0; i < 4; i++) await x.tick();
  assert.deepEqual(x.ops(), ["+ready"]);
  const y = harness();
  y.h.facts = () => "unreviewed";
  y.start();
  for (let i = 0; i < 3; i++) await y.tick();
  assert.deepEqual(y.ops(), []);
});

// ---------------------------------------------------------------- never fight a human

test("a label a human removed is not re-added on the same head", async () => {
  const x = harness();
  x.start();
  await x.tick();
  x.host.labels.delete("ready");
  await x.tick();
  x.set(snap({ mergeState: "blocked" }));
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready"]);
});

test("a human put the label on, then removed it on the same head: not re-added, and never removed by the watch", async () => {
  const x = harness();
  x.host.labels.add("ready");
  x.start();
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready"], "the add found the human's label (changed false)");
  x.host.labels.delete("ready");
  await x.tick();
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready"]);
  const rec = x.watches.records()[0].state.label;
  assert.deepEqual(rec, { name: "ready", own: false, onHead: A, selfOff: "" });
});

test("the watch added, a human removed it, a check fails then passes on the same head: not re-added", async () => {
  const x = harness();
  x.start();
  await x.tick();
  x.host.labels.delete("ready");
  x.set(snap({ runs: failing }));
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready", "-ready"], "the remove found nothing");
  x.set(snap());
  await x.tick();
  x.set(snap({ mergeState: "blocked" }));
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready", "-ready"], "no re-add on the same head, no repeated remove");
  assert.equal(x.watches.records()[0].state.label?.selfOff, "", "a remove that changed nothing sets no selfOff");
});

test("re-added on the same head after the watch's own removal", async () => {
  const x = harness();
  x.start();
  await x.tick();
  x.set(snap({ runs: failing }));
  await x.tick();
  assert.deepEqual(x.watches.records()[0].state.label, { name: "ready", own: false, onHead: A, selfOff: A });
  x.set(snap());
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready", "-ready", "+ready"]);
  assert.deepEqual(x.watches.records()[0].state.label, { name: "ready", own: true, onHead: A, selfOff: "" });
});

test("the label carried from an earlier head to a new ready head is still the watch's: removed when that head fails", async () => {
  const x = harness();
  x.start();
  await x.tick();
  x.set(snap({ head: B }));
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready", "+ready"], "the add for the new head found the label already there");
  assert.equal(x.watches.records()[0].state.label?.own, true);
  x.set(snap({ head: B, runs: failing }));
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready", "+ready", "-ready"]);
  assert.ok(!x.has("ready"));
});

test("a human's label (the add answered changed false) is never removed and makes no second call on later ticks", async () => {
  const x = harness();
  x.host.labels.add("ready");
  x.start();
  await x.tick();
  x.set(snap({ runs: failing }));
  await x.tick();
  x.set(snap({ draft: true }));
  await x.tick();
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready"]);
  assert.ok(x.has("ready"));
});

test("a remove that finds nothing is not repeated", async () => {
  const x = harness();
  x.start();
  await x.tick();
  x.host.labels.delete("ready");
  x.set(snap({ runs: failing }));
  await x.tick();
  await x.tick();
  x.set(snap({ runs: failing, mergeState: "blocked" }));
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready", "-ready"]);
});

test("the key changed while the label is on: the old record is dropped and the old label is left alone", async () => {
  const x = harness();
  x.start();
  await x.tick();
  x.h.label = "queued";
  x.set(snap({ runs: failing }));
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready"], "the old label is not removed");
  assert.ok(x.has("ready"));
  assert.equal(x.watches.records()[0].state.label, undefined);
  x.set(snap());
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready", "+queued"]);
  assert.equal(x.watches.records()[0].state.label?.name, "queued");
});

test("a label name differing only in case keeps the record", async () => {
  const x = harness({ label: "Ready" });
  x.start();
  await x.tick();
  x.h.label = "ready";
  x.set(snap({ runs: failing }));
  await x.tick();
  assert.deepEqual(x.ops(), ["+Ready", "-ready"], "the record stays the watch's own");
  assert.ok(!x.has("Ready"));
});

test("the record survives a reload and no call is repeated", async () => {
  const x = harness();
  x.start();
  await x.tick();
  const stored = x.persisted.at(-1)!;
  const entry = [{ type: "custom", customType: "pi-foreman-prwatch", data: { v: 2, piSessionId: "s1", watches: stored } }];
  const back = latestWatches(entry, "s1");
  assert.equal(back.status, "ok");
  const y = harness();
  y.host.labels.add("ready");
  y.watches.restore(back);
  await flush();
  await flush();
  assert.deepEqual(y.watches.records()[0].state.label, { name: "ready", own: true, onHead: A, selfOff: "" });
  assert.deepEqual(y.ops(), [], "this head was asked for before the reload");
  y.set(snap({ runs: failing }));
  await y.tick();
  assert.deepEqual(y.ops(), ["-ready"], "the carried record is still the watch's own");
});

test("an entry without a label record still parses; a malformed record is dropped", () => {
  const base = { head: A, failedIds: [], ci: "", mergeable: "", commentIds: [], updatedAt: "", noCi: 0, noCiHead: "", readyHead: "", last: "watching" };
  const rec = (state: Record<string, unknown>) => parseWatchRecord({ key: K, cwd: "/w", startedAt: 1, state });
  assert.equal(rec(base)?.state.label, undefined);
  assert.deepEqual(rec({ ...base, label: { name: "ready", own: true, onHead: A, selfOff: "" } })?.state.label, { name: "ready", own: true, onHead: A, selfOff: "" });
  assert.equal(rec({ ...base, label: { name: "ready", own: "yes" } })?.state.label, undefined);
});

// ---------------------------------------------------------------- who and where

test("an adopted PR (not owned) is labelled on a tick, and through the facts-moved hook", async () => {
  const x = harness({ owned: false });
  x.h.facts = () => "unreviewed";
  x.start();
  await x.tick();
  assert.deepEqual(x.ops(), []);
  x.h.facts = () => "ok";
  await x.watches.reconcileOwned();
  assert.deepEqual(x.ops(), ["+ready"]);
  assert.deepEqual(x.draftCalls, [], "the draft step stays limited to PRs the session opened");
});

test("the facts-moved hook takes the label off an adopted PR whose review was withdrawn", async () => {
  const x = harness({ owned: false });
  x.start();
  await x.tick();
  x.h.facts = () => "wip";
  await x.watches.reconcileOwned();
  assert.deepEqual(x.ops(), ["+ready", "-ready"]);
});

test("the label does not depend on the draft setting", async () => {
  const x = harness({ owned: true, flow: false });
  x.start();
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready"]);
});

test("review gate off: the PASS is still required and the label is still set", async () => {
  const x = harness({ gate: false });
  x.h.facts = () => "unreviewed";
  x.start();
  await x.tick();
  assert.deepEqual(x.ops(), []);
  x.h.facts = () => "ok";
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready"]);
});

test("no review-facts source: nothing is labelled", async () => {
  const x = harness({ noFacts: true });
  x.start();
  await x.tick();
  await x.tick();
  await x.watches.reconcileOwned();
  assert.deepEqual(x.ops(), []);
});

test("key empty: no host call at all, not even a remove", async () => {
  const x = harness({ label: "" });
  x.start();
  await x.tick();
  x.set(snap({ runs: failing }));
  await x.tick();
  await x.watches.reconcileOwned();
  assert.deepEqual(x.ops(), []);
  const y = harness({ noOp: true });
  y.start();
  await y.tick();
  assert.deepEqual(y.ops(), []);
});

test("a tick and the facts-moved hook that overlap send one host call", async () => {
  const x = harness();
  let release: () => void = () => {};
  x.h.hold = new Promise<void>((r) => (release = r));
  x.start();
  const first = x.tick();
  await flush();
  await x.watches.reconcileOwned();
  await x.watches.reconcileOwned();
  assert.equal(x.calls.length, 1);
  release();
  await first;
  await flush();
  assert.equal(x.calls.length, 1);
  assert.equal(x.watches.records()[0].state.label?.own, true);
});

test("pr_label is not a model-facing tool", () => {
  assert.ok(!PR_TOOL_NAMES.includes("pr_label"));
});

test("a merged, a closed and an un-watched PR is not touched", async () => {
  for (const state of ["merged", "closed"] as const) {
    const x = harness();
    x.start();
    x.set(snap({ state }));
    await x.tick();
    await x.watches.reconcileOwned();
    assert.deepEqual(x.ops(), [], state);
  }
  const u = harness();
  u.start();
  assert.equal(u.watches.unwatch(7), 1);
  await u.tick();
  await u.watches.reconcileOwned();
  assert.deepEqual(u.ops(), []);
  // unwatched while the add is on its way: the answer touches nothing
  const w = harness();
  let release: () => void = () => {};
  w.h.hold = new Promise<void>((r) => (release = r));
  w.start();
  const t = w.tick();
  await flush();
  w.watches.unwatch(7);
  const before = w.persisted.length;
  release();
  await t;
  await flush();
  assert.equal(w.persisted.length, before);
});

// ---------------------------------------------------------------- failures

test("an unsupported host gives one notice and ends label handling for the watch", async () => {
  const x = harness();
  x.h.answer = () => ({ kind: "precondition", precondition: "pr_unsupported", message: "pr_label needs gh" });
  x.start();
  await x.tick();
  x.set(snap({ updatedAt: "t2" }));
  await x.tick();
  await x.watches.reconcileOwned();
  assert.equal(x.calls.length, 1);
  assert.equal(x.sent.filter((m) => m.includes("ready label not set")).length, 1);
  assert.ok(x.traces.includes("label_unsupported"));
});

test("a repeated failure pauses, then gives one notice at the cap and makes no more calls for the head", async () => {
  const x = harness();
  x.h.answer = () => ({ kind: "error", message: "boom" });
  x.start();
  const next = async () => {
    x.set(snap());
    await x.tick();
  };
  await next();
  assert.equal(x.calls.length, 1);
  await next();
  assert.equal(x.calls.length, 1, "inside the pause");
  x.h.clock += 40_000;
  await next();
  assert.equal(x.calls.length, 2);
  x.h.clock += 80_000;
  await next();
  assert.equal(x.calls.length, 3);
  x.h.clock += 160_000;
  await next();
  assert.equal(x.calls.length, DRAFT_FAIL_CAP);
  assert.equal(x.sent.filter((m) => m.includes("ready label not changed")).length, 1);
  x.h.clock += 10_000_000;
  await next();
  await next();
  assert.equal(x.calls.length, DRAFT_FAIL_CAP);
  assert.equal(x.sent.filter((m) => m.includes("ready label not changed")).length, 1);
  assert.ok(x.traces.includes("label_failed") && x.traces.includes("label_failed_capped"));
});

test("a throwing host op is a failure, not a crash", async () => {
  const x = harness();
  x.h.answer = () => {
    throw new Error("boom");
  };
  x.start();
  await x.tick();
  assert.equal(x.calls.length, 1);
  assert.ok(x.traces.includes("label_failed"));
});

// ---------------------------------------------------------------- the review decision reaches the snapshot

const result = (extra: Record<string, unknown>) => ({ number: 7, repo: "acme/app", state: "open", mergeable: "mergeable", headSha: A, baseRef: "main", updatedAt: "t0", runs: [], ...extra });

test("the batch answer's review decision reaches the watch snapshot; an unknown value or none leaves it out", async () => {
  const answer = (extra: Record<string, unknown>): RunOp => async (op) => (op === "pr_batch" ? { kind: "ran", result: { prs: [result(extra)], errors: [] } } : { kind: "ran", result: { comments: [] } });
  const seen = { updatedAt: "t0" };
  const at = async (v: unknown) => {
    const [p] = await pollWatchBatch(answer(v === undefined ? {} : { reviewDecision: v }), [{ key: K, seen }]);
    return "snap" in p ? p.snap.reviewDecision : "no snap";
  };
  assert.equal(await at("changes_requested"), "changes_requested");
  assert.equal(await at("approved"), "approved");
  assert.equal(await at("review_required"), "review_required");
  assert.equal(await at(null), undefined);
  assert.equal(await at("bogus"), undefined);
  assert.equal(await at(undefined), undefined);
});

test("pr_status's review decision reaches the snapshot of the one-by-one poll", async () => {
  const run =
    (extra: Record<string, unknown>): RunOp =>
    async (op) => (op === "pr_status" ? { kind: "ran", result: result(extra) } : op === "pr_checks" ? { kind: "ran", result: { pending: [], failed: [], passed: [] } } : { kind: "ran", result: { comments: [] } });
  const p = await pollWatch(run({ reviewDecision: "changes_requested" }), { host: "", repo: "", n: 7 }, { updatedAt: "t0" });
  assert.equal("snap" in p && p.snap.reviewDecision, "changes_requested");
  const q = await pollWatch(run({ reviewDecision: null }), { host: "", repo: "", n: 7 }, { updatedAt: "t0" });
  assert.equal("snap" in q && "reviewDecision" in q.snap, false);
});

test("the stored snapshot carries the review decision; an entry without it still parses", () => {
  const meta = { url: "u", title: "t", headRefName: "b", headRepo: "acme/app" };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-label-"));
  fs.mkdirSync(path.dirname(trackedStateFile(dir)), { recursive: true });
  const read = (extra: Record<string, unknown>) => {
    fs.writeFileSync(trackedStateFile(dir), JSON.stringify({ v: 1, trackedAt: 9_999_000, prs: { [storeKey("acme/app", 7)]: { repo: "acme/app", number: 7, at: 10_000_000, okAt: 9_999_000, meta, snap: { state: "open", mergeable: "mergeable", head: A, base: "main", updatedAt: "t1", runs: [], ...extra } } } }));
    clearStoreCache();
    return readStoreEntry(dir, { host: "github.com", repo: "acme/app", n: 7 }, 10_000_000, true);
  };
  const withIt = read({ reviewDecision: "changes_requested" });
  assert.equal(withIt.kind === "entry" && withIt.snap.reviewDecision, "changes_requested");
  const without = read({});
  assert.equal(without.kind, "entry");
  assert.equal(without.kind === "entry" && "reviewDecision" in without.snap, false);
  const bogus = read({ reviewDecision: 7 });
  assert.equal(bogus.kind === "entry" && "reviewDecision" in bogus.snap, false);
});

// ---------------------------------------------------------------- the label through the real review facts (the halves step C left)

const pass = (head: string, o: Partial<ReviewRecord> = {}): ReviewRecord => ({ role: "reviewer", verdict: "pass", head, kind: "code", occasion: "pre-pr", ...o });

test("a waiting reviewed PR keeps its label through other work; a FAIL after the PASS on the same head takes it off", async () => {
  const x = harness();
  const reviews: ReviewRecord[] = [pass(A)];
  x.h.facts = (head) => reviewFactsForHead(reviews, head, []);
  x.start();
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready"]);
  reviews.push(pass(B, { verdict: "fail" })); // review of other work, another head
  await x.watches.reconcileOwned();
  await x.tick();
  assert.deepEqual(x.ops(), ["+ready"], "other work leaves the label");
  reviews.push(pass(A, { verdict: "fail" }));
  await x.watches.reconcileOwned();
  assert.deepEqual(x.ops(), ["+ready", "-ready"]);
});
