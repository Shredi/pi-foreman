import { test } from "node:test";
import assert from "node:assert/strict";
import { dotState, PrDots } from "../prdots.ts";
import type { PrDotsDeps } from "../prdots.ts";
import { PrWatches, baselineOf } from "../prwatch.ts";
import type { ChecksAnswer, Timers } from "../prwatch.ts";
import type { SafeOpOutcome } from "../safeops.ts";

const chk = (name: string) => ({ name, status: "completed", conclusion: null, url: null });
const checks = (o: Partial<ChecksAnswer>): ChecksAnswer => ({ pending: [], failed: [], passed: [], summary: "s", ...o });
const ran = (result: Record<string, unknown>): SafeOpOutcome => ({ kind: "ran", result: { ok: true, ...result } });
const pre = (precondition: string): SafeOpOutcome => ({ kind: "precondition", precondition, message: "m" });
const green = checks({ passed: [chk("a")] });

interface Pr {
  status?: Record<string, unknown>;
  checks?: ChecksAnswer;
  fail?: SafeOpOutcome;
}

function harness(opts: { enabled?: boolean; branch?: string; intervalMs?: number; watched?: () => number[]; watchChecks?: PrDotsDeps["watchChecks"]; blocked?: () => boolean } = {}) {
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const fake: Timers = { set: (fn, ms) => (timers.push({ fn, ms, live: true }), timers.length - 1), clear: (h) => void (typeof h === "number" && timers[h] && (timers[h].live = false)) };
  const prs = new Map<number, Pr>();
  let branchPr: Pr & { number?: number } | null = null;
  let branch = opts.branch ?? "feat";
  const calls: { op: string; number?: number }[] = [];
  const traces: Record<string, unknown>[] = [];
  let changed = 0;
  let preflights = 0;
  const d = new PrDots({
    enabled: () => opts.enabled ?? true,
    preflight: async () => (preflights++, opts.blocked?.() ? { block: true as const, reason: "drift" } : undefined),
    branch: async () => branch,
    run: async (op, args) => {
      const n = args.number as number | undefined;
      calls.push({ op, number: n });
      if (n === undefined) return branchPr ? (branchPr.fail ?? ran(branchPr.status ?? {})) : pre("pr_not_found");
      const p = prs.get(n);
      if (!p) return pre("pr_not_found");
      if (p.fail) return p.fail;
      return op === "pr_status" ? ran({ number: n, state: "open", draft: false, mergeable: "mergeable", ...p.status }) : ran({ ...(p.checks ?? green) });
    },
    watched: opts.watched ?? (() => []),
    watchChecks: opts.watchChecks ?? (() => null),
    intervalMs: () => opts.intervalMs ?? 60_000,
    trace: (r) => void traces.push(r),
    timers: fake,
    changed: () => void changed++,
  });
  const live = () => [...timers].reverse().find((t) => t.live);
  /** Fire the live timer and let the tick finish. */
  const fire = async () => {
    const t = live();
    assert.ok(t, "a live timer");
    t.live = false;
    t.fn();
    await new Promise((r) => setImmediate(r));
  };
  return { d, prs, calls, traces, fire, live, setBranch: (b: string, p: (Pr & { number?: number }) | null) => ((branch = b), (branchPr = p)), setBranchPr: (p: (Pr & { number?: number }) | null) => (branchPr = p), changed: () => changed, preflights: () => preflights };
}

test("dotState: the mapping table", () => {
  assert.equal(dotState("conflicting", green), "fail");
  assert.equal(dotState("mergeable", checks({ failed: [chk("a")], passed: [chk("b")] })), "fail");
  assert.equal(dotState("mergeable", checks({ pending: [chk("a")] })), "run");
  assert.equal(dotState("conflicting", checks({ pending: [chk("a")] })), "fail");
  assert.equal(dotState("mergeable", green), "ok");
  assert.equal(dotState("mergeable", checks({})), "none");
  assert.equal(dotState("unknown", green), "none");
  assert.equal(dotState(null, green), "none");
  assert.equal(dotState("mergeable", undefined), "none");
});

test("a draft with green checks gives ok", async () => {
  const h = harness();
  h.prs.set(5, { status: { draft: true } });
  h.d.onCreated(5);
  h.d.start();
  await h.fire();
  assert.deepEqual(h.d.dots(), [{ n: 5, state: "ok" }]);
});

test("the tracked set: created, watched, and the branch PR; newest first, at most 6, no duplicates", async () => {
  const h = harness({ watched: () => [30, 20, 10] });
  for (const n of [1, 2, 3, 10, 20, 30, 40, 50]) h.prs.set(n, {});
  h.setBranchPr({ number: 40, status: { number: 40, state: "open", mergeable: "mergeable" } });
  h.d.onCreated(1);
  h.d.onCreated(2);
  h.d.onCreated(3);
  h.d.onCreated(2);
  h.d.start();
  await h.fire();
  assert.deepEqual(h.d.dots().map((x) => x.n), [2, 3, 1, 30, 20, 10]);
  assert.equal(h.calls.filter((c) => c.number === undefined).length, 1, "one pr_status without a number");
  // the branch PR joins when there is room
  const h2 = harness({ watched: () => [10] });
  h2.prs.set(10, {});
  h2.prs.set(40, {});
  h2.setBranchPr({ number: 40, status: { number: 40, state: "open", mergeable: "mergeable" } });
  h2.d.start();
  await h2.fire();
  assert.deepEqual(h2.d.dots().map((x) => x.n), [10, 40]);
  assert.equal(h2.calls.filter((c) => c.number === 40 && c.op === "pr_status").length, 0, "the branch status answer is reused");
});

test("the branch lookup is cached per branch name, hits and misses, and runs again when the name changes", async () => {
  const h = harness();
  h.d.start();
  await h.fire(); // miss
  await h.fire();
  assert.equal(h.calls.filter((c) => c.number === undefined).length, 1);
  h.prs.set(9, {});
  h.setBranch("other", { number: 9, status: { number: 9, state: "open", mergeable: "mergeable" } });
  await h.fire();
  assert.equal(h.calls.filter((c) => c.number === undefined).length, 2);
  assert.deepEqual(h.d.dots(), [{ n: 9, state: "ok" }]);
  await h.fire();
  assert.equal(h.calls.filter((c) => c.number === undefined).length, 2);
  h.setBranch("feat", null); // back to a cached miss
  await h.fire();
  assert.equal(h.calls.filter((c) => c.number === undefined).length, 2);
  assert.deepEqual(h.d.dots(), []);
});

test("closed, merged and pr_not_found are dropped and not tracked again", async () => {
  const h = harness({ watched: () => [3] });
  h.prs.set(1, { status: { state: "closed" } });
  h.prs.set(2, { status: { state: "merged" } });
  h.prs.set(3, {});
  h.d.onCreated(1);
  h.d.onCreated(2);
  h.d.onCreated(4); // not found
  h.d.start();
  await h.fire();
  assert.deepEqual(h.d.dots(), [{ n: 3, state: "ok" }]);
  await h.fire();
  assert.deepEqual(h.d.dots(), [{ n: 3, state: "ok" }]);
  assert.equal(h.calls.filter((c) => c.number === 1 || c.number === 2 || c.number === 4).length, 3, "each asked once");
});

test("three failures in a row give none; a failure before that keeps the last state; a success resets", async () => {
  const h = harness();
  h.prs.set(5, {});
  h.d.onCreated(5);
  h.d.start();
  await h.fire();
  assert.equal(h.d.dots()[0].state, "ok");
  h.prs.set(5, { fail: { kind: "error", message: "boom" } });
  await h.fire();
  assert.equal(h.d.dots()[0].state, "ok");
  await h.fire();
  assert.equal(h.d.dots()[0].state, "ok");
  await h.fire();
  assert.equal(h.d.dots()[0].state, "none");
  h.prs.set(5, { checks: checks({ pending: [chk("a")] }) });
  await h.fire();
  assert.equal(h.d.dots()[0].state, "run");
  h.prs.set(5, { fail: { kind: "error", message: "boom" } });
  await h.fire();
  await h.fire();
  assert.equal(h.d.dots()[0].state, "run", "the counter restarted");
});

test("backoff doubles per failed tick, caps at 600 s and resets on success; the floor is 30 s", async () => {
  const h = harness({ intervalMs: 5000 });
  h.prs.set(5, {});
  h.d.onCreated(5);
  h.d.start();
  await h.fire();
  assert.equal(h.live()?.ms, 30_000, "floor");
  h.prs.set(5, { fail: { kind: "error", message: "x" } });
  const seen: number[] = [];
  for (let i = 0; i < 7; i++) {
    await h.fire();
    seen.push(h.live()!.ms);
  }
  assert.deepEqual(seen, [60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
  h.prs.set(5, {});
  await h.fire();
  assert.equal(h.live()?.ms, 30_000);
  assert.ok(h.traces.some((t) => t.outcome === "backoff"));
  assert.ok(h.traces.some((t) => t.outcome === "error"));
});

test("a watched PR reuses a fresh watch snapshot (status only), a stale one polls checks", async () => {
  let age = 1000;
  const h = harness({ watched: () => [7], watchChecks: () => ({ checks: checks({ pending: [chk("a")] }), ageMs: age }) });
  h.prs.set(7, { checks: green });
  h.d.start();
  await h.fire();
  assert.deepEqual(h.d.dots(), [{ n: 7, state: "run" }]);
  assert.deepEqual(h.calls.filter((c) => c.number === 7).map((c) => c.op), ["pr_status"]);
  age = 90_000;
  await h.fire();
  assert.deepEqual(h.d.dots(), [{ n: 7, state: "ok" }]);
  assert.deepEqual(h.calls.filter((c) => c.number === 7).map((c) => c.op), ["pr_status", "pr_status", "pr_checks"]);
});

test("PrWatches.lastChecks: the latest poll's checks and age; null without a watch or poll", async () => {
  let clock = 1000;
  const timers: { fn: () => void; ms: number }[] = [];
  const fake: Timers = { set: (fn, ms) => (timers.push({ fn, ms }), timers.length - 1), clear: () => undefined };
  const snap = checks({ pending: [chk("a")] });
  const w = new PrWatches({ poll: async () => ({ checks: snap }), send: () => undefined, idle: () => true, trace: () => undefined, intervalMs: () => 5000, now: () => clock, timers: fake });
  assert.equal(w.lastChecks(1), null);
  w.start(1, "checks", baselineOf({ checks: snap }), 3_600_000);
  assert.equal(w.lastChecks(1), null);
  clock = 6000;
  timers[1].fn();
  await new Promise((r) => setImmediate(r));
  clock = 8000;
  assert.deepEqual(w.lastChecks(1), { checks: snap, ageMs: 2000 });
  assert.equal(w.lastChecks(2), null);
});

test("a blocked preflight skips the tick and keeps the states", async () => {
  let blocked = false;
  const h = harness({ blocked: () => blocked });
  h.prs.set(5, {});
  h.d.onCreated(5);
  h.d.start();
  await h.fire();
  blocked = true;
  h.prs.set(5, { checks: checks({ failed: [chk("a")] }) });
  const before = h.calls.length;
  await h.fire();
  assert.equal(h.calls.length, before, "no host call");
  assert.deepEqual(h.d.dots(), [{ n: 5, state: "ok" }]);
  assert.equal(h.live()?.ms, 60_000, "no backoff");
  blocked = false;
  await h.fire();
  assert.deepEqual(h.d.dots(), [{ n: 5, state: "fail" }]);
});

test("host or auth missing stops the loop with one trace event; tracked PRs show none", async () => {
  for (const which of ["pr_host_missing", "pr_auth_missing"]) {
    const h = harness();
    h.prs.set(5, {});
    h.d.onCreated(5);
    h.d.start();
    await h.fire();
    h.prs.set(5, { fail: pre(which) });
    await h.fire();
    assert.equal(h.live(), undefined, "no timer left");
    assert.deepEqual(h.d.dots(), [{ n: 5, state: "none" }]);
    assert.equal(h.traces.filter((t) => t.outcome === "stopped").length, 1);
    h.d.onCreated(6);
    assert.equal(h.live(), undefined, "a later create does not restart it");
    assert.equal(h.traces.filter((t) => t.outcome === "stopped").length, 1);
  }
});

test("a child (gate closed) never starts the loop", async () => {
  const h = harness({ enabled: false });
  h.d.onCreated(5);
  h.d.start();
  assert.equal(h.live(), undefined);
  assert.equal(h.calls.length, 0);
  assert.equal(h.preflights(), 0);
});

test("clear() stops the timer and empties the dots; the live-file hook is called on a change", async () => {
  const h = harness();
  h.prs.set(5, {});
  h.d.onCreated(5);
  h.d.start();
  await h.fire();
  assert.equal(h.changed(), 1);
  await h.fire();
  assert.equal(h.changed(), 1, "unchanged dots do not signal");
  h.d.clear();
  assert.equal(h.live(), undefined);
  assert.deepEqual(h.d.dots(), []);
});

test("trace records never hold a PR number", async () => {
  const h = harness({ watched: () => [4242] });
  h.prs.set(4242, {});
  h.prs.set(987654, { fail: { kind: "error", message: "boom 987654" } });
  h.d.onCreated(987654);
  h.d.start();
  await h.fire();
  await h.fire();
  assert.ok(h.traces.length > 0);
  for (const t of h.traces) {
    assert.equal(t.event, "pr_dots");
    assert.deepEqual(Object.keys(t).sort(), ["count", "event", "outcome"]);
    assert.doesNotMatch(JSON.stringify(t), /4242|987654/);
  }
});
