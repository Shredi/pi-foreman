import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RULES, globMatch, parseWakeRules, wakes } from "../prwake.ts";
import { baselineOf, prDelta } from "../prwatch.ts";
import type { Bucket, CommentEntry, Run, WatchSnapshot } from "../prwatch.ts";

const SHA = "abcdef0123456789";
const SHB = "fedcba9876543210";
const src = (name: string, bucket: Bucket, head = SHA, gates = true): Run => ({ id: `${name}:${head.slice(0, 12)}:${name}`, name: `${name}/deploy`, bucket, url: "", source: name, gates });
const gh = (name: string, bucket: Bucket): Run => ({ id: name, name, bucket, url: "" });
const snap = (o: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: SHA, base: "main", updatedAt: "t", runs: [], ...o });
const rules = (raw: unknown) => parseWakeRules(raw).rules;

test("globMatch and parseWakeRules", () => {
  assert.equal(globMatch("deploy-*", "deploy-prod"), true);
  assert.equal(globMatch("acme/*", "other/x"), false);
  const p = parseWakeRules([{ source: "ci", events: ["check_failed", "bogus"], wake: true }, { wake: "yes" }, "x"]);
  assert.equal(p.errors.length >= 2, true);
  assert.deepEqual(parseWakeRules(undefined).rules, [...DEFAULT_RULES]);
});

test("wakes: defaults, last match wins, both owner examples", () => {
  const ev = { kind: "check_failed" as const, source: "internal-ci", repo: "acme/widgets", check: "deploy-prod" };
  assert.equal(wakes(DEFAULT_RULES, ev), true);
  const silent = rules([{ source: "*", wake: false }]);
  assert.equal(wakes([...DEFAULT_RULES, ...silent], ev), false);
  const ex1 = rules([{ source: "*", wake: false }, { source: "internal-ci", repos: ["acme/widgets"], events: ["check_failed"], checks: ["deploy-*"], wake: true }]);
  const all = [...DEFAULT_RULES, ...ex1];
  assert.equal(wakes(all, ev), true);
  assert.equal(wakes(all, { ...ev, check: "lint" }), false);
  assert.equal(wakes(all, { ...ev, repo: "acme/other" }), false);
  const ex2 = rules([{ source: "github", events: ["issue", "review"], authors: "human", wake: false }]);
  assert.equal(wakes([...DEFAULT_RULES, ...ex2], { kind: "issue", source: "github", repo: "a/b", author: "bob", bot: false }), false);
  assert.equal(wakes([...DEFAULT_RULES, ...ex2], { kind: "issue", source: "github", repo: "a/b", author: "bot", bot: true }), true);
});

test("prDelta: silent source events are marked seen and never replay", () => {
  const r = rules([{ source: "*", wake: false }]);
  const base = baselineOf(snap({ runs: [gh("a", "passed")] }));
  const s = snap({ runs: [gh("a", "passed"), src("ci", "failed")] });
  const first = prDelta(base, s, false, [...DEFAULT_RULES, ...r], "acme/widgets");
  assert.equal(first.delta, null);
  assert.equal(prDelta(first.state, s, false, DEFAULT_RULES, "acme/widgets").delta, null);
});

test("prDelta: a check_failed-only rule still wakes on a failure that finishes CI", () => {
  const r = [...DEFAULT_RULES, ...rules([{ source: "github", events: ["checks_settled"], wake: false }])];
  const base = baselineOf(snap({ runs: [gh("a", "passed"), src("ci", "pending")] }));
  const out = prDelta(base, snap({ runs: [gh("a", "passed"), src("ci", "failed")] }), false, r, "acme/widgets");
  assert.ok(out.delta);
  assert.ok(out.delta.events.some((e) => /check failed/.test(e)));
});

test("prDelta: the same check failing on heads A and B wakes twice", () => {
  const a = prDelta(baselineOf(snap({ runs: [src("ci", "pending")] })), snap({ runs: [src("ci", "failed")] }), false, DEFAULT_RULES, "acme/widgets");
  assert.ok(a.delta);
  const b0 = prDelta(a.state, snap({ head: SHB, runs: [src("ci", "pending", SHB)] }), false, DEFAULT_RULES, "acme/widgets");
  const b = prDelta(b0.state, snap({ head: SHB, runs: [src("ci", "failed", SHB)] }), false, DEFAULT_RULES, "acme/widgets");
  assert.ok(b.delta);
  assert.ok(b.delta.events.some((e) => /check failed|checks finished: fail/.test(e)));
});

test("prDelta: gates:false is excluded from checks finished and ready", () => {
  const base = baselineOf(snap({ runs: [gh("a", "pending"), src("ci", "pending", SHA, false)] }));
  const out = prDelta(base, snap({ runs: [gh("a", "passed"), src("ci", "pending", SHA, false)] }), true, DEFAULT_RULES, "acme/widgets");
  assert.ok(out.delta);
  assert.ok(out.delta.events.includes("checks finished: pass"));
  assert.equal(out.delta.ready, true);
  const gated = prDelta(base, snap({ runs: [gh("a", "passed"), src("ci", "pending")] }), true, DEFAULT_RULES, "acme/widgets");
  assert.equal(gated.delta, null);
});

test("prDelta: more than 300 combined comment ids do not replay", () => {
  const cs = (n: number): CommentEntry[] => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, kind: "issue", author: "bob", body: "b" }));
  const s = snap({ comments: cs(100) });
  let st = baselineOf(snap());
  for (let round = 0; round < 6; round++) {
    const withSrc = snap({ comments: [...cs(100), ...Array.from({ length: 100 }, (_, i) => ({ id: `ci:${round}-${i}`, kind: "issue", author: "x", body: "b", source: "ci" }))] });
    st = prDelta(st, withSrc, false, DEFAULT_RULES, "acme/widgets").state;
  }
  const again = prDelta(st, snap({ comments: [...s.comments!, ...Array.from({ length: 100 }, (_, i) => ({ id: `ci:5-${i}`, kind: "issue", author: "x", body: "b", source: "ci" }))] }), false, DEFAULT_RULES, "acme/widgets");
  assert.equal(again.delta, null);
});
