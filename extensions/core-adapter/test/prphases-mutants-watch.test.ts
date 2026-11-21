// tools.prPhases mutant killer: a gated head with no phase-1 run gets no merge label (prwatch.ts checksInput).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrWatches } from "../prwatch.ts";
import type { Bucket, Run, StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import { parsePhases, phasesStep } from "../prphases.ts";
import type { PrKey } from "../prhost.ts";
import type { SafeOpOutcome } from "../safeops.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const A = "a".repeat(40);
const RULES = parsePhases([{ gate: ["deploy*"], ignore: ["review-*"], mergeLabel: "merge-ok" }]).rules;
const run = (name: string, bucket: Bucket): Run => ({ id: name, name, bucket, url: `https://h.invalid/${name}` });
/** A polled head sorted the way the tracker does. */
const snap = (runs: Run[], o: Partial<WatchSnapshot> = {}): WatchSnapshot => {
  const s = phasesStep(RULES, "acme/app", runs, o.required);
  return { state: "open", mergeable: "mergeable", head: A, base: "main", updatedAt: "t0", mergeState: "clean", draft: false, ...o, ...s };
};



const flush = () => new Promise((r) => setImmediate(r));
function harness(s0: WatchSnapshot) {
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const calls: string[] = [];
  const sent: string[] = [];
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
  return { watches, calls, sent, tick, set };
}



for (const [name, runs] of [["no runs at all", [] as Run[]], ["only gate runs", [run("deploy", "passed")]]] as const) {
  test(`a gated head with ${name}, confirmed no checks, PASS, mergeable, not draft: no label, the no-checks event is sent`, async () => {
    const x = harness(snap([...runs]));
    x.watches.start(K, snap([...runs]), null, false);
    for (let i = 0; i < 5; i++) {
      x.set(snap([...runs]));
      await x.tick();
    }
    assert.deepEqual(x.calls, []);
    assert.ok(x.sent.some((c) => c.includes(`no checks reported for ${A.slice(0, 7)}`)), x.sent.join("|"));
  });
}
