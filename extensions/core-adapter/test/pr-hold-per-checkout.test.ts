// An open PR's readiness is held by the high-stakes state of its own checkout only (docs/review.md): prHoldFacts, and two owned watches over real records.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HighStakes, prHoldFacts } from "../highstakes.ts";
import { PrWatches } from "../prwatch.ts";
import type { StoreRead, WatchSnapshot } from "../prwatch.ts";
import type { ReviewRecord } from "../reviews.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const FAILH = "f".repeat(40);
const rec = (head: string, cwd: string | undefined, o: Partial<ReviewRecord> = {}): ReviewRecord => ({ role: "reviewer", verdict: "pass", head, occasion: "pre-pr", ...(cwd ? { cwd } : {}), ...o }) as ReviewRecord;
const FIRED = { reasons: ["lines"], files: 1, lines: 100, modules: 1 };

test("prHoldFacts: a pass due and an uncleared FAIL in checkout b leave head A of checkout a ok; head B is unreviewed, then wip", () => {
  const records = [rec(A, "/w/a"), rec(B, "/w/b")];
  const hs = new HighStakes();
  assert.equal(prHoldFacts(records, hs.all(), A, []), "ok");
  assert.equal(prHoldFacts(records, hs.all(), B, []), "ok");
  hs.fire("/w/b", FIRED);
  assert.equal(prHoldFacts(records, hs.all(), A, []), "ok");
  assert.equal(prHoldFacts(records, hs.all(), B, []), "unreviewed");
  hs.begin("c1", "/w/b");
  hs.settle("c1", "run-1", false);
  hs.record("/w/b", "fail", FAILH, "1. FAIL x");
  assert.equal(prHoldFacts(records, hs.all(), A, []), "ok");
  assert.equal(prHoldFacts(records, hs.all(), B, []), "wip");
});

test("prHoldFacts: a later PASS or FAIL review on head B leaves head A ok", () => {
  const hs = new HighStakes();
  hs.fire("/w/b", FIRED);
  const pass = [rec(A, "/w/a"), rec(B, "/w/b"), rec(B, "/w/b")];
  assert.equal(prHoldFacts(pass, hs.all(), A, []), "ok");
  const fail = [...pass, rec(B, "/w/b", { verdict: "fail" })];
  assert.equal(prHoldFacts(fail, hs.all(), A, []), "ok");
  assert.equal(prHoldFacts(fail, hs.all(), B, []), "wip");
});

test("prHoldFacts: a later item review on the same head A after its [pre-pr] PASS leaves A unreviewed (docs/review.md)", () => {
  const records = [rec(A, "/w/a"), rec(A, "/w/a", { occasion: "item" })];
  assert.equal(prHoldFacts(records, new HighStakes().all(), A, []), "unreviewed");
});

test("prHoldFacts: a head whose records carry no cwd is held by any checkout (the session-wide fallback)", () => {
  const records = [rec(A, undefined)];
  const hs = new HighStakes();
  assert.equal(prHoldFacts(records, hs.all(), A, []), "ok");
  hs.fire("/w/b", FIRED);
  assert.equal(prHoldFacts(records, hs.all(), A, []), "unreviewed");
});

test("prHoldFacts: a high-stakes FAIL run naming head A that ran in checkout b still makes A wip", () => {
  const records = [rec(A, "/w/a")];
  const hs = new HighStakes();
  hs.fire("/w/b", FIRED);
  hs.begin("c1", "/w/b");
  hs.settle("c1", "run-1", false);
  hs.record("/w/b", "fail", A, "1. FAIL x");
  assert.equal(prHoldFacts(records, hs.all(), A, []), "wip");
});

test("two owned watches over real records: checkout b's due pass re-drafts only PR B", () => {
  const records = [rec(A, "/w/a"), rec(B, "/w/b")];
  const hs = new HighStakes();
  const snapOf = (head: string): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head, base: "main", updatedAt: "t0", runs: [] });
  const store = (n: number): StoreRead => ({ kind: "entry", snap: snapOf(n === 7 ? A : B), okAt: 1 });
  const watches = new PrWatches({
    storeEntry: (key) => store(key.n),
    githubHosts: () => ({ hosts: ["github.com"] }),
    reviewFacts: (head) => prHoldFacts(records, hs.all(), head, []),
    reviewGate: () => true,
    cwd: () => "/w/own",
    send: () => {},
    idle: () => true,
    trace: () => {},
    intervalMs: () => 60_000,
    now: () => 0,
    timers: { set: () => 1, clear: () => {} },
  });
  watches.start({ host: "github.com", repo: "acme/app", n: 7 }, snapOf(A), 1, true);
  watches.start({ host: "github.com", repo: "acme/app", n: 8 }, snapOf(B), 1, true);
  const states = () => Object.fromEntries(watches.reviewLive().map((l) => [l.n, l.state]));
  assert.deepEqual(states(), { 7: "ok", 8: "ok" });
  hs.fire("/w/b", FIRED);
  assert.deepEqual(states(), { 7: "ok", 8: "unreviewed" });
});
