// tools.prPhases in the watch (prwatch.ts): phase 1 alone decides checks finished, ready and the label; the gate is reported on its own; ignored checks send nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baselineOf, prDelta, prMessage, PrWatches } from "../prwatch.ts";
import type { Bucket, Run, StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import { parsePhases, phasesStep } from "../prphases.ts";
import type { PrKey } from "../prhost.ts";
import type { SafeOpOutcome } from "../safeops.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const A = "a".repeat(40);
const B = "b".repeat(40);
const RULES = parsePhases([{ gate: ["deploy*"], ignore: ["review-*"], mergeLabel: "merge-ok" }]).rules;
const run = (name: string, bucket: Bucket): Run => ({ id: name, name, bucket, url: `https://h.invalid/${name}` });
/** A polled head sorted the way the tracker does. */
const snap = (runs: Run[], o: Partial<WatchSnapshot> = {}): WatchSnapshot => {
  const s = phasesStep(RULES, "acme/app", runs, o.required);
  return { state: "open", mergeable: "mergeable", head: A, base: "main", updatedAt: "t0", mergeState: "clean", draft: false, ...o, ...s };
};

test("a gate failure is its own event and lines; checks finished and ready do not wait for the gate", () => {
  const base = baselineOf(snap([run("build", "pending"), run("deploy", "pending")]));
  const pass = prDelta(base, snap([run("build", "passed"), run("deploy", "pending")]), true);
  assert.deepEqual(pass.delta?.events, ["checks finished: pass", "ready to merge"].filter((e) => pass.delta?.events.includes(e)));
  assert.ok(pass.delta?.events.includes("checks finished: pass"));
  assert.deepEqual(pass.delta?.gate, { state: "running" });
  assert.match(prMessage(7, pass.delta!).content, /- gate running/);
  const bad = prDelta(pass.state, snap([run("build", "passed"), run("deploy", "failed")]), true);
  assert.ok(bad.delta?.events.includes("gate check failed"));
  assert.ok(!bad.delta?.events.some((e) => e.startsWith("check failed")));
  assert.equal(bad.delta?.gateFailed?.[0].name, "deploy");
  assert.match(prMessage(7, bad.delta!).content, /- gate failed deploy /);
  assert.equal(bad.delta?.failed.length, 0, "the failed list is phase 1 only");
});

test("gate result is reported once per head and result; a new head re-arms", () => {
  const base = baselineOf(snap([run("build", "passed"), run("deploy", "pending")]));
  const done = prDelta(base, snap([run("build", "passed"), run("deploy", "passed")]), false);
  assert.ok(done.delta?.events.includes("gate checks finished: pass"));
  assert.equal(prDelta(done.state, snap([run("build", "passed"), run("deploy", "passed")]), false).delta, null);
  const next = prDelta(done.state, snap([run("build", "passed"), run("deploy", "pending")], { head: B }), false);
  assert.equal(next.state.gateCi, "");
  const again = prDelta(next.state, snap([run("build", "passed"), run("deploy", "failed")], { head: B }), false);
  assert.ok(again.delta?.events.includes("gate checks finished: fail"));
});

test("a gate already passed at the first sight is the baseline: nothing reported", () => {
  const s = snap([run("build", "passed"), run("deploy", "passed")]);
  const base = baselineOf(s);
  assert.equal(base.gateCi, `${A}:pass`);
  assert.equal(prDelta(base, s, false).delta, null);
});

test("ignored checks send nothing, failed or not", () => {
  const base = baselineOf(snap([run("build", "passed"), run("review-bot", "pending")]));
  const r = prDelta(base, snap([run("build", "passed"), run("review-bot", "failed")]), true);
  assert.ok(!r.delta?.events.some((e) => /fail/.test(e)));
  assert.equal(r.delta?.gateFailed, undefined);
});

test("a gated repository: blocked merge state still gives the ready line, with the blocked data line; ungated does not", () => {
  const base = baselineOf(snap([run("build", "pending")], { mergeState: "blocked" }));
  const g = prDelta(base, snap([run("build", "passed")], { mergeState: "blocked" }), true);
  assert.ok(g.delta?.events.includes("ready to merge"));
  assert.equal(g.delta?.blocked, true);
  assert.match(prMessage(7, g.delta!).content, /merge state blocked/);
  const plain = (rs: Run[]): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: A, base: "main", updatedAt: "t0", mergeState: "blocked", draft: false, runs: rs });
  const u = prDelta(baselineOf(plain([run("build", "pending")])), plain([run("build", "passed")]), true);
  assert.ok(!u.delta?.events.includes("ready to merge"));
});

test("a gated head with only gate checks is never ready by no-checks", () => {
  const s = snap([run("deploy", "pending")]);
  let st = baselineOf(s);
  for (let i = 0; i < 4; i++) st = prDelta(st, s, true).state;
  assert.ok(!prDelta(st, s, true).delta?.events.includes("ready to merge"));
});

// ---------------------------------------------------------------- the merge label

const flush = () => new Promise((r) => setImmediate(r));
function harness(s0: WatchSnapshot) {
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const calls: string[] = [];
  const h = { read: { kind: "entry", snap: s0, okAt: 1000 } as StoreRead, okAt: 1000 };
  const watches = new PrWatches({
    storeEntry: () => h.read,
    githubHosts: () => ({ hosts: [] }),
    reviewFacts: () => "ok",
    reviewGate: () => true,
    draftFlow: () => false,
    label: async (_k, _c, label, on): Promise<SafeOpOutcome> => (calls.push(`${on ? "+" : "-"}${label}`), { kind: "ran", result: { changed: true } }),
    readyLabel: () => "ready",
    phaseRules: () => RULES,
    persist: () => {},
    cwd: () => "/w",
    child: () => false,
    send: () => {},
    idle: () => true,
    trace: () => {},
    intervalMs: () => 60_000,
    settleMs: () => 0,
    now: () => 0,
    timers,
  });
  const tick = async () => (fns.shift()?.(), await flush(), await flush());
  const set = (s: WatchSnapshot) => (h.okAt += 1000, (h.read = { kind: "entry", snap: { ...s, updatedAt: `t${h.okAt}` }, okAt: h.okAt }));
  return { watches, calls, tick, set };
}

test("the merge label replaces tools.prReadyLabel, is added only on phase 1 green + mergeable + not draft (blocked allowed), and comes off when phase 1 fails", async () => {
  const x = harness(snap([run("build", "pending")]));
  x.watches.start(K, snap([run("build", "pending")]), null, false);
  await x.tick();
  assert.deepEqual(x.calls, []);
  x.set(snap([run("build", "passed"), run("deploy", "pending")], { mergeState: "blocked" }));
  await x.tick();
  assert.deepEqual(x.calls, ["+merge-ok"]);
  x.set(snap([run("build", "failed"), run("deploy", "passed")], { mergeState: "blocked" }));
  await x.tick();
  assert.deepEqual(x.calls, ["+merge-ok", "-merge-ok"]);
  x.set(snap([run("build", "passed")], { draft: true }));
  await x.tick();
  assert.deepEqual(x.calls, ["+merge-ok", "-merge-ok"], "draft: no add");
});
