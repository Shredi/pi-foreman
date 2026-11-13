import { test } from "node:test";
import assert from "node:assert/strict";
import { baselineOf, prDelta, prMessage } from "../prwatch.ts";
import type { Bucket, Run, WatchSnapshot, WatchState } from "../prwatch.ts";

const SHA = "abcdef0123456789";
const run = (name: string, bucket: Bucket): Run => ({ id: name, name, bucket, url: `https://h.invalid/${name}` });
const snap = (o: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: SHA, base: "main", updatedAt: "t0", runs: [], ...o });
const green = (o: Partial<WatchSnapshot> = {}) => snap({ runs: [run("a", "passed")], ...o });
const READY = /\nreport to the parent: PR #7 green on abcdef0, mergeable, ready to merge$/;
const NO_CHECKS = /\nreport to the parent: PR #7 no checks on abcdef0, mergeable, ready to merge$/;

test("a call without the rule input keeps today's ready line", () => {
  const base = baselineOf(snap({ runs: [run("a", "pending")], mergeable: "unknown" }));
  const { delta } = prDelta(base, green(), true);
  assert.deepEqual(delta?.events, ["checks finished: pass", "ready to merge"]);
  assert.match(prMessage(7, delta!).content, READY);
});

test("rule not ok: the ready line is withheld without setting the latch; once the rule holds it is sent once", () => {
  const base = baselineOf(snap({ runs: [run("a", "pending")], mergeable: "unknown" }));
  const held = prDelta(base, green(), true, undefined, "", undefined, true, undefined, { ok: false, managed: false });
  assert.deepEqual(held.delta?.events, ["checks finished: pass"]);
  assert.equal(held.state.readyHead, "");
  assert.ok(!prMessage(7, held.delta!).content.includes("ready to merge"));
  const sent = prDelta(held.state, green({ updatedAt: "t1" }), true, undefined, "", undefined, true, undefined, { ok: true, managed: false });
  assert.deepEqual(sent.delta?.events, ["ready to merge"]);
  assert.match(prMessage(7, sent.delta!).content, READY);
  assert.equal(prDelta(sent.state, green({ updatedAt: "t2" }), true, undefined, "", undefined, true, undefined, { ok: true, managed: false }).delta, null);
});

test("a managed watch gets no 'green, still a draft'; an unmanaged one keeps it", () => {
  const base = baselineOf(snap({ runs: [run("a", "pending")], mergeable: "unknown", draft: true }));
  const managed = prDelta(base, green({ draft: true }), true, undefined, "", undefined, true, undefined, { ok: true, managed: true });
  assert.deepEqual(managed.delta?.events, ["checks finished: pass, draft"]);
  assert.ok(!prMessage(7, managed.delta!).content.includes("still a draft"));
  const plain = prDelta(base, green({ draft: true }), true, undefined, "", undefined, true, undefined, { ok: true, managed: false });
  assert.deepEqual(plain.delta?.events, ["checks finished: pass, draft", "green, still a draft"]);
});

test("no checks: a draft confirmed with no checks sends no ready line; the draft change restarts the count; then the no-checks line, once per head", () => {
  const rule = { ok: true, managed: true };
  const step = (st: WatchState, s: WatchSnapshot) => prDelta(st, s, true, undefined, "", undefined, true, undefined, rule);
  let st = baselineOf(snap({ draft: true }));
  let r = step(st, snap({ draft: true, updatedAt: "t1" }));
  assert.deepEqual(r.delta?.events, ["no checks reported for abcdef0"]);
  assert.ok(r.state.noCi >= 2);
  // the host takes it out of draft: the count restarts, so no ready line on the first non-draft tick
  r = step(r.state, snap({ updatedAt: "t2" }));
  assert.equal(r.state.noCi, 1);
  assert.equal(r.delta, null);
  // confirmed again on the non-draft PR
  r = step(r.state, snap({ updatedAt: "t3" }));
  assert.deepEqual(r.delta?.events, ["ready to merge, no checks"]);
  assert.match(prMessage(7, r.delta!).content, NO_CHECKS);
  assert.equal(step(r.state, snap({ updatedAt: "t4" })).delta, null);
  // a new head is confirmed afresh and reported once
  const head2 = "fedcba9876543210";
  r = step(r.state, snap({ head: head2, updatedAt: "t5" }));
  r = step(r.state, snap({ head: head2, updatedAt: "t6" }));
  assert.ok(r.delta?.events.includes("ready to merge, no checks"));
  assert.equal(step(r.state, snap({ head: head2, updatedAt: "t7" })).delta, null);
});

test("no checks: the line needs the rule (ok), a child, mergeable, not draft", () => {
  const go = (rule: { ok: boolean; managed: boolean } | undefined, child: boolean, s: Partial<WatchSnapshot>) => {
    const a = prDelta(baselineOf(snap()), snap({ updatedAt: "t1", ...s }), child, undefined, "", undefined, true, undefined, rule);
    const b = prDelta(a.state, snap({ updatedAt: "t2", ...s }), child, undefined, "", undefined, true, undefined, rule);
    return [a, b].some((x) => x.delta?.events.includes("ready to merge, no checks"));
  };
  assert.equal(go({ ok: true, managed: false }, true, {}), true);
  assert.equal(go({ ok: false, managed: false }, true, {}), false);
  assert.equal(go(undefined, true, {}), false, "without the rule input a head with no checks has no ready line, as today");
  assert.equal(go({ ok: true, managed: false }, false, {}), false);
  assert.equal(go({ ok: true, managed: false }, true, { mergeable: "conflicting" }), false);
  assert.equal(go({ ok: true, managed: false }, true, { draft: true }), false);
  assert.equal(go({ ok: true, managed: false }, true, { mergeState: "blocked" }), false);
});

test("an unmanaged watch keeps today's no-checks count across a draft change", () => {
  const rule = { ok: true, managed: false };
  let st = baselineOf(snap({ draft: true }));
  st = prDelta(st, snap({ draft: true, updatedAt: "t1" }), true, undefined, "", undefined, true, undefined, rule).state;
  const r = prDelta(st, snap({ updatedAt: "t2" }), true, undefined, "", undefined, true, undefined, rule);
  assert.ok(r.state.noCi >= 3);
  assert.equal("draftSeen" in r.state, false);
});

test("nothing lets a ready line go out earlier than today: with any rule input the line is sent only when it is without one", () => {
  const snaps: Partial<WatchSnapshot>[] = [{}, { draft: true }, { mergeable: "conflicting" }, { mergeable: "unknown" }, { mergeState: "blocked" }, { mergeState: "behind" }, { mergeState: "clean" }, { runs: [run("a", "failed")] }, { runs: [run("a", "pending")] }];
  for (const over of snaps) {
    for (const rule of [{ ok: true, managed: true }, { ok: true, managed: false }, { ok: false, managed: true }, { ok: false, managed: false }]) {
      for (const child of [true, false]) {
        const before = baselineOf(snap({ runs: [run("a", "pending")], mergeable: "unknown" }));
        const s = green(over);
        const today = prDelta(before, s, child);
        const ruled = prDelta(before, s, child, undefined, "", undefined, true, undefined, rule);
        const ev = (d: typeof today) => d.delta?.events.filter((e) => e.startsWith("ready to merge")) ?? [];
        // today has no line for a head with no checks, so the only new line is the no-checks one
        if (over.runs === undefined || over.runs.length > 0) assert.ok(ev(ruled).length <= ev(today).length, JSON.stringify({ over, rule, child }));
      }
    }
  }
});
