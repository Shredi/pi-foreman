// The label path fails closed: a stored tag never hides a check the live rules count, and unreadable live rules add no label.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrWatches } from "../prwatch.ts";
import type { Bucket, Run, StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import { parsePhases, phasesStep } from "../prphases.ts";
import type { PhaseRule } from "../prphases.ts";
import type { PrKey } from "../prhost.ts";
import type { SafeOpOutcome } from "../safeops.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const OLD = parsePhases([{ ignore: ["flaky"], mergeLabel: "merge-ok" }]).rules;
const LIVE = parsePhases([{ mergeLabel: "merge-ok" }]).rules;
const run = (name: string, bucket: Bucket): Run => ({ id: name, name, bucket, url: `https://h.invalid/${name}` });
const snapOf = (runs: Run[]): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: "a".repeat(40), base: "main", updatedAt: "t0", mergeState: "blocked", draft: false, ...phasesStep(OLD, "acme/app", runs) });

const flush = () => new Promise((r) => setImmediate(r));
async function go(s: WatchSnapshot, phaseRules: () => readonly PhaseRule[], child = false, readyLabel = "ready"): Promise<{ labels: string[]; sent: string[] }> {
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const labels: string[] = [];
  const sent: string[] = [];
  const read: StoreRead = { kind: "entry", snap: s, okAt: 1000 };
  const watches = new PrWatches({
    storeEntry: () => read,
    githubHosts: () => ({ hosts: [] }),
    reviewFacts: () => "ok",
    reviewGate: () => true,
    draftFlow: () => false,
    label: async (_k, _c, label, on): Promise<SafeOpOutcome> => (labels.push(`${on ? "+" : "-"}${label}`), { kind: "ran", result: { changed: true } }),
    readyLabel: () => readyLabel,
    phaseRules,
    persist: () => {},
    cwd: () => "/w",
    child: () => child,
    send: (m: unknown) => void sent.push(JSON.stringify(m)),
    idle: () => true,
    trace: () => {},
    intervalMs: () => 60_000,
    settleMs: () => 0,
    now: () => 0,
    timers,
  } as never);
  watches.start(K, s, null, false);
  for (let i = 0; i < 4; i++) (fns.shift()?.(), await flush(), await flush());
  return { labels, sent };
}

test("stale snap tags flaky as not counted, live rules count it again, flaky failed: no label", async () => {
  const s = snapOf([run("flaky", "failed"), run("build", "passed")]);
  assert.deepEqual((await go(s, () => LIVE)).labels, []);
});

test("same with flaky passed: no label while the snap key differs from the live rules", async () => {
  const s = snapOf([run("flaky", "passed"), run("build", "passed")]);
  assert.deepEqual((await go(s, () => LIVE)).labels, []);
});

test("live rules throw: no label call", async () => {
  const s = snapOf([run("build", "passed")]);
  const boom = (): never => {
    throw new Error("unreadable");
  };
  assert.deepEqual((await go(s, boom)).labels, []);
});

test("live rules throw in a repo without phases: no label call, ready line still comes", async () => {
  const plain: WatchSnapshot = { state: "open", mergeable: "mergeable", head: "b".repeat(40), base: "main", updatedAt: "t0", mergeState: "clean", draft: false, runs: [run("build", "passed")] };
  const boom = (): never => {
    throw new Error("unreadable");
  };
  const r = await go(plain, boom, true);
  assert.deepEqual(r.labels, []);
  assert.ok(r.sent.some((m) => m.includes("ready to merge")), `ready line sent: ${r.sent.join("|")}`);
});
