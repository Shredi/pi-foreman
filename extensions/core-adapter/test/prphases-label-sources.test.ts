// The label path counts a run only through phases: a non-gating source's run stays out, and unreadable rules keep the label record.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrWatches } from "../prwatch.ts";
import type { Bucket, Run, StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import { parsePhases, phasesStep } from "../prphases.ts";
import type { PhaseRule } from "../prphases.ts";
import type { PrKey } from "../prhost.ts";
import type { SafeOpOutcome } from "../safeops.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const GATED = parsePhases([{ mergeLabel: "merge-ok" }]).rules;
const run = (name: string, bucket: Bucket): Run => ({ id: name, name, bucket, url: `https://h.invalid/${name}` });
const src = (bucket: Bucket): Run => ({ id: "lint:x", name: "lint/x", bucket, url: "", source: "lint", gates: false });
const base = { state: "open", mergeable: "mergeable", head: "a".repeat(40), base: "main", updatedAt: "t0", mergeState: "clean", draft: false } as const;
const snapOf = (runs: Run[], rules: readonly PhaseRule[] = []): WatchSnapshot => ({ ...base, sources: { lint: { head: "a".repeat(40), gates: false, ok: true, at: 1 } }, ...phasesStep(rules, "acme/app", runs) });

const flush = () => new Promise((r) => setImmediate(r));
function rig(first: WatchSnapshot, phaseRules: () => readonly PhaseRule[]) {
  let cur = first;
  let at = 1000;
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const labels: string[] = [];
  const read = (): StoreRead => ({ kind: "entry", snap: cur, okAt: at });
  const watches = new PrWatches({
    storeEntry: read,
    githubHosts: () => ({ hosts: [] }),
    reviewFacts: () => "ok",
    reviewGate: () => true,
    draftFlow: () => false,
    label: async (_k, _c, label, on): Promise<SafeOpOutcome> => (labels.push(`${on ? "+" : "-"}${label}`), { kind: "ran", result: { changed: true } }),
    readyLabel: () => "ready",
    phaseRules: (() => phaseRules()) as never,
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
  } as never);
  watches.start(K, first, null, false);
  const tick = async (s?: WatchSnapshot) => {
    if (s) (cur = s, (at += 1000));
    for (let i = 0; i < 4; i++) (fns.shift()?.(), await flush(), await flush());
  };
  return { labels, tick, watches };
}

test("no rules: build passed, non-gating source run failed: ready added", async () => {
  const r = rig(snapOf([run("build", "passed"), src("failed")]), () => []);
  await r.tick();
  assert.deepEqual(r.labels, ["+ready"]);
});

test("no rules: non-gating source run pending: ready added", async () => {
  const r = rig(snapOf([run("build", "passed"), src("pending")]), () => []);
  await r.tick();
  assert.deepEqual(r.labels, ["+ready"]);
});

test("gated repo, phase 1 green, non-gating source run failed: merge label added", async () => {
  const r = rig(snapOf([run("build", "passed"), src("failed")], GATED), () => GATED);
  await r.tick();
  assert.deepEqual(r.labels, ["+merge-ok"]);
});

test("unreadable rules keep the label record: a later tick with red phase 1 removes the label", async () => {
  let readable = true;
  const rules = (): readonly PhaseRule[] => {
    if (!readable) throw new Error("unreadable");
    return GATED;
  };
  const r = rig(snapOf([run("build", "passed")], GATED), rules);
  await r.tick();
  assert.deepEqual(r.labels, ["+merge-ok"]);
  readable = false;
  await r.tick(snapOf([run("build", "failed")], GATED));
  assert.deepEqual(r.labels, ["+merge-ok"]);
  readable = true;
  await r.tick(snapOf([run("build", "failed")], GATED));
  assert.deepEqual(r.labels, ["+merge-ok", "-merge-ok"]);
});
