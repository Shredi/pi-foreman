// tools.prPhases in the watch, second part: the child's gate report, the reload, the gated no-checks cases, the pending start, reviewLive and the merge label.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baselineOf, parseWatchRecord, prDelta, prMessage, PrWatches } from "../prwatch.ts";
import type { Bucket, Delta, Run, StoreRead, Timers, WatchSnapshot, WatchState } from "../prwatch.ts";
import { parsePhases, phasesStep } from "../prphases.ts";
import type { PhaseRule } from "../prphases.ts";
import type { PrKey } from "../prhost.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import { strRaw } from "../strof.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const A = "a".repeat(40);
const B = "b".repeat(40);
const GATED = parsePhases([{ gate: ["deploy*"], ignore: ["review-*"], mergeLabel: "merge-ok" }]).rules;
const IGNORE_ONLY = parsePhases([{ ignore: ["review-*"] }]).rules;
const LABEL_ONLY = parsePhases([{ mergeLabel: "merge-ok" }]).rules;
const NO_LABEL = parsePhases([{ gate: ["deploy*"] }]).rules;
const run = (name: string, bucket: Bucket, id = name): Run => ({ id, name, bucket, url: `https://h.invalid/${name}` });
const snapOf = (rules: readonly PhaseRule[]) => (runs: Run[], o: Partial<WatchSnapshot> = {}): WatchSnapshot => {
  const s = phasesStep(rules, "acme/app", runs, o.required);
  return { state: "open", mergeable: "mergeable", head: A, base: "main", updatedAt: "t0", mergeState: "clean", draft: false, ...o, ...s };
};
const snap = snapOf(GATED);
const text = (d: Delta | null | undefined) => (d ? prMessage(7, d).content : "");

test("a child gets the gate-failed report line once per head; the same failed run is not repeated; ready is not taken back", () => {
  const base = baselineOf(snap([run("build", "pending"), run("deploy", "pending", "g1")]));
  const ready = prDelta(base, snap([run("build", "passed"), run("deploy", "pending", "g1")]), true);
  assert.ok(ready.delta?.events.includes("ready to merge"));
  assert.equal(ready.state.readyHead, A);
  const bad = prDelta(ready.state, snap([run("build", "passed"), run("deploy", "failed", "g1")]), true);
  assert.ok(bad.delta?.events.includes("gate check failed"));
  assert.ok(!bad.delta?.events.includes("ready to merge"));
  assert.equal(bad.state.readyHead, A, "the ready latch stays");
  assert.match(text(bad.delta), /\nreport to the parent: PR #7 gate failed on aaaaaaa$/);
  const same = prDelta(bad.state, snap([run("build", "passed"), run("deploy", "failed", "g1")]), true);
  assert.equal(same.delta?.events.includes("gate check failed") ?? false, false, "no repeat for the same run id");
  const other = prDelta(bad.state, snap([run("build", "passed"), run("deploy", "failed", "g1"), run("deploy-2", "failed", "g2")]), true);
  assert.ok(other.delta?.events.includes("gate check failed"), "a new failed run is news");
  assert.doesNotMatch(text(other.delta), /report to the parent/, "the report line is once per head");
});

test("a parent (not a child) gets no gate report line", () => {
  const base = baselineOf(snap([run("build", "passed"), run("deploy", "pending")]));
  const bad = prDelta(base, snap([run("build", "passed"), run("deploy", "failed")]), false);
  assert.ok(bad.delta?.events.includes("gate check failed"));
  assert.doesNotMatch(text(bad.delta), /report to the parent/);
});

test("no `gate checks finished` without a gate run, gated repository or not", () => {
  for (const rules of [GATED, IGNORE_ONLY, []]) {
    const s = snapOf(rules);
    let st = baselineOf(s([run("build", "pending")]));
    const a = prDelta(st, s([run("build", "passed")]), true);
    st = a.state;
    assert.ok(!a.delta?.events.some((e) => e.startsWith("gate checks finished")), JSON.stringify(rules));
    assert.equal(st.gateCi ?? "", "");
  }
});

test("a reload through parseWatchRecord does not repeat gate news", () => {
  const s = snap([run("build", "passed"), run("deploy", "failed", "g1")]);
  const base = baselineOf(snap([run("build", "passed"), run("deploy", "pending", "g1")]));
  const first = prDelta(base, s, true);
  assert.ok(first.delta?.events.includes("gate check failed"));
  assert.ok(first.delta?.events.includes("gate checks finished: fail"));
  const rec = parseWatchRecord(JSON.parse(JSON.stringify({ key: K, cwd: "/w", startedAt: 1, state: first.state })));
  assert.ok(rec);
  assert.equal(rec.state.gateCi, `${A}:fail`);
  assert.equal(rec.state.gateReportHead, A);
  assert.equal(prDelta(rec.state as WatchState, s, true).delta, null);
});

// ---------------------------------------------------------------- the gated no-checks cases

function noChecksEvents(s: (runs: Run[], o?: Partial<WatchSnapshot>) => WatchSnapshot, runs: Run[]): string[] {
  const x = s(runs);
  let st = baselineOf(x);
  const events: string[] = [];
  for (let i = 0; i < 5; i++) {
    const r = prDelta(st, x, true, undefined, "acme/app", undefined, true, undefined, { ok: true, managed: false });
    st = r.state;
    events.push(...(r.delta?.events ?? []));
  }
  return events;
}

test("a gated head with no runs at all is never ready by no-checks", () => {
  const ev = noChecksEvents(snap, []);
  assert.ok(!ev.includes("ready to merge, no checks") && !ev.includes("ready to merge"), ev.join("|"));
});

test("a repository with only not-counted rules keeps `ready to merge, no checks` (not-counted runs are absent)", () => {
  const ev = noChecksEvents(snapOf(IGNORE_ONLY), [run("review-bot", "failed")]);
  assert.ok(ev.includes("ready to merge, no checks"), ev.join("|"));
  assert.ok(!ev.some((e) => e.startsWith("check failed")));
});

// ---------------------------------------------------------------- watches

const flush = () => new Promise((r) => setImmediate(r));
interface Opts {
  rules?: readonly PhaseRule[];
  readyLabel?: string;
  owned?: boolean;
  start?: WatchSnapshot;
}
function harness(o: Opts = {}) {
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const calls: string[] = [];
  const draftCalls: boolean[] = [];
  const sent: string[] = [];
  const h = { read: { kind: "entry", snap: o.start ?? snap([run("build", "pending")]), okAt: 1000 } as StoreRead, okAt: 1000, label: o.readyLabel ?? "ready" };
  const watches = new PrWatches({
    storeEntry: () => h.read,
    githubHosts: () => ({ hosts: [] }),
    reviewFacts: () => "ok",
    reviewGate: () => true,
    draftFlow: () => true,
    draft: async (_k, _c, draft) => (draftCalls.push(draft), { kind: "ran", result: { ok: true } }),
    label: async (_k, _c, label, on): Promise<SafeOpOutcome> => (calls.push(`${on ? "+" : "-"}${label}`), { kind: "ran", result: { changed: true } }),
    readyLabel: () => h.label,
    phaseRules: () => o.rules ?? GATED,
    persist: () => {},
    cwd: () => "/w",
    child: () => false,
    send: (m) => void sent.push(m.content),
    idle: () => true,
    trace: () => {},
    intervalMs: () => 60_000,
    settleMs: () => 0,
    now: () => 0,
    timers,
  });
  const tick = async () => (fns.shift()?.(), await flush(), await flush());
  const set = (s: WatchSnapshot) => (h.okAt += 1000, (h.read = { kind: "entry", snap: { ...s, updatedAt: `t${h.okAt}` }, okAt: h.okAt }));
  return { watches, calls, draftCalls, sent, tick, set, h };
}

test("a managed draft in a gated repository with only gate runs and confirmed no-checks leaves draft", async () => {
  const s = snap([run("deploy", "passed")], { draft: true });
  const x = harness({ start: s, owned: true });
  x.watches.start(K, s, null, true);
  for (let i = 0; i < 4; i++) {
    x.set(s);
    await x.tick();
  }
  assert.ok(x.draftCalls.length > 0 && x.draftCalls.every((d) => d === false), `draft calls: ${strRaw(x.draftCalls)}`);
});

test("a pending-start watch sends `gate checks finished` exactly once", async () => {
  const done = snap([run("build", "passed"), run("deploy", "passed")]);
  const x = harness({ start: done });
  x.watches.startPending(K);
  await x.tick();
  x.set(done);
  await x.tick();
  x.set(done);
  await x.tick();
  assert.equal(x.sent.filter((m) => m.includes("gate checks finished: pass")).length, 1);
});

test("reviewLive sets noChecks in an ungated repository and not in a gated one", async () => {
  for (const [rules, want] of [[[], true], [IGNORE_ONLY, true], [GATED, undefined], [LABEL_ONLY, undefined]] as [PhaseRule[], true | undefined][]) {
    const s = snapOf(rules)([], {});
    const x = harness({ rules, start: s });
    x.watches.start(K, s, null, true);
    await x.tick();
    await x.tick();
    assert.equal(x.watches.reviewLive()[0].noChecks, want, JSON.stringify(rules));
  }
});

// ---------------------------------------------------------------- the label name and its latch

test("tools.prReadyLabel is the label when the repository has no mergeLabel", async () => {
  const s = snapOf(NO_LABEL)([run("build", "passed")]);
  const x = harness({ rules: NO_LABEL, start: s });
  x.watches.start(K, s, null, false);
  await x.tick();
  assert.deepEqual(x.calls, ["+ready"]);
});

test("a label removed after a gate failure is not added again on the same head; a new head gets it again", async () => {
  const ok = snap([run("build", "passed"), run("deploy", "pending")]);
  const x = harness({ start: snap([run("build", "pending")]) });
  x.watches.start(K, snap([run("build", "pending")]), null, false);
  x.set(ok);
  await x.tick();
  assert.deepEqual(x.calls, ["+merge-ok"]);
  // the gate bot removes the label after a failure: the watch sees the same head, still ready
  x.set(snap([run("build", "passed"), run("deploy", "failed")]));
  await x.tick();
  x.set(snap([run("build", "passed"), run("deploy", "failed")]));
  await x.tick();
  assert.deepEqual(x.calls, ["+merge-ok"], "no second add on the same head");
  x.set(snap([run("build", "passed"), run("deploy", "pending")], { head: B }));
  await x.tick();
  assert.deepEqual(x.calls, ["+merge-ok", "+merge-ok"]);
});

test("the facts hook labels an adopted watch when prReadyLabel is empty and a mergeLabel is set; with neither it does nothing", async () => {
  const s = snap([run("build", "passed")]);
  const x = harness({ readyLabel: "", start: s });
  x.watches.start(K, s, null, false);
  await x.watches.reconcileOwned();
  assert.deepEqual(x.calls, ["+merge-ok"]);
  const none = harness({ readyLabel: "", rules: IGNORE_ONLY, start: snapOf(IGNORE_ONLY)([run("build", "passed")]) });
  none.watches.start(K, snapOf(IGNORE_ONLY)([run("build", "passed")]), null, false);
  await none.watches.reconcileOwned();
  assert.deepEqual(none.calls, []);
});
