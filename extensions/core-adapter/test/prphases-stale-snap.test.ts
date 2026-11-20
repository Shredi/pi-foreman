// The merge label reads the live tools.prPhases rules too: a snap stored before the tracker saw them never gets a label on a head with no phase-1 run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrWatches } from "../prwatch.ts";
import type { Bucket, Run, StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import { parsePhases, phasesStep } from "../prphases.ts";
import type { PrKey } from "../prhost.ts";
import type { SafeOpOutcome } from "../safeops.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const RULES = parsePhases([{ gate: ["deploy*"], mergeLabel: "merge-ok" }]).rules;
const run = (name: string, bucket: Bucket): Run => ({ id: name, name, bucket, url: `https://h.invalid/${name}` });
const stale = (runs: Run[]): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: "a".repeat(40), base: "main", updatedAt: "t0", mergeState: "blocked", draft: false, runs });
const fresh = (runs: Run[]): WatchSnapshot => ({ ...stale([]), ...phasesStep(RULES, "acme/app", runs) });

const flush = () => new Promise((r) => setImmediate(r));
async function labels(s: WatchSnapshot): Promise<string[]> {
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const calls: string[] = [];
  const read: StoreRead = { kind: "entry", snap: s, okAt: 1000 };
  const watches = new PrWatches({
    storeEntry: () => read,
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
  watches.start(K, s, null, false);
  for (let i = 0; i < 4; i++) (fns.shift()?.(), await flush(), await flush());
  return calls;
}

test("stale snap (built without rules), no runs: no label", async () => {
  assert.deepEqual(await labels(stale([])), []);
});

test("stale snap, only an untagged passed deploy run: no label", async () => {
  assert.deepEqual(await labels(stale([run("deploy", "passed")])), []);
});

test("current snap, no runs: no label", async () => {
  assert.deepEqual(await labels(fresh([])), []);
});

test("current snap, deploy passed: no label", async () => {
  assert.deepEqual(await labels(fresh([run("deploy", "passed")])), []);
});

test("stale snap, untagged passed phase-1 run: label added", async () => {
  assert.deepEqual(await labels(stale([run("build", "passed")])), ["+merge-ok"]);
});
