// The label waits for a snap written under the current rules: the tracker stores `rulesKey`, the watch compares it with the live rules (prphases.ts rulesKeyOf).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrWatches } from "../prwatch.ts";
import type { Bucket, Run, StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import { parsePhases, phasesStep, rulesKeyOf } from "../prphases.ts";
import type { PhaseRule } from "../prphases.ts";
import type { PrKey } from "../prhost.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pollPrs } from "../prs-cli.ts";
import type { PollDeps } from "../prs-cli.ts";
import { addTracked, clearStoreCache, parseSnap, trackedStateFile } from "../prstore.ts";
import type { MergedConfig } from "../config.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const rulesOf = (r: unknown): PhaseRule[] => parsePhases(r).rules;
const LIVE = rulesOf([{ mergeLabel: "merge-ok" }]);
const wrun = (name: string, bucket: Bucket): Run => ({ id: name, name, bucket, url: `https://h.invalid/${name}` });
const snapUnder = (rules: PhaseRule[], runs: Run[], required: string[], mergeState = "blocked"): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: "a".repeat(40), base: "main", updatedAt: "t0", mergeState, draft: false, ...phasesStep(rules, "acme/app", runs, required) });

const flush = () => new Promise((r) => setImmediate(r));
async function go(s: WatchSnapshot, rules: PhaseRule[]): Promise<{ labels: string[]; sent: string[] }> {
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
    readyLabel: () => "ready",
    phaseRules: () => rules,
    persist: () => {},
    cwd: () => "/w",
    child: () => false,
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

const RUNS = [wrun("build", "passed")];
test("stale snap written under an ignore of lint: lint required with no run, no label", async () => {
  const s = snapUnder(rulesOf([{ ignore: ["lint"], mergeLabel: "merge-ok" }]), RUNS, ["build", "lint"]);
  assert.deepEqual((await go(s, LIVE)).labels, []);
});

test("stale snap written under a gate of lint: no label", async () => {
  const s = snapUnder(rulesOf([{ gate: ["lint"], mergeLabel: "merge-ok" }]), RUNS, ["build", "lint"]);
  assert.deepEqual((await go(s, LIVE)).labels, []);
});

test("fresh snap, lint required with no run: no label", async () => {
  assert.deepEqual((await go(snapUnder(LIVE, RUNS, ["build", "lint"]), LIVE)).labels, []);
});

test("fresh snap, lint passed: label added", async () => {
  assert.deepEqual((await go(snapUnder(LIVE, [...RUNS, wrun("lint", "passed")], ["build", "lint"]), LIVE)).labels, ["+merge-ok"]);
});

test("repository without prPhases and a snap without rulesKey: ready line as before, no label call", async () => {
  const s = snapUnder([], RUNS, ["build"], "clean");
  assert.equal(s.rulesKey, undefined);
  const r = await go(s, []);
  assert.deepEqual(r.labels, ["+ready"]);
});

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const T0 = 50_000_000;
type Row = Record<string, unknown>;
const trun = (name: string, bucket: string): Row => ({ id: name, name, bucket, url: "x", expected: true });
const row = (o: Row = {}): Row => ({ repo: "acme/app", number: 1, state: "open", mergeable: "mergeable", headSha: "h1", baseRef: "main", updatedAt: "u1", url: "https://github.com/acme/app/pull/1", title: "t", draft: false, headRefName: "feat", headRepo: "acme/app", ...o });

async function setup(phases: unknown, r: Row) {
  clearStoreCache();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-prphases-"));
  const clock = { t: T0 };
  const deps: PollDeps = {
    agentDir,
    pkgRoot: PKG,
    now: () => clock.t,
    resolve: async (p) => ({ ok: true, info: { executable: p ?? "/py", version: [3, 13], source: "test" }, rejected: [] }),
    loadConfig: async () => ({ config: { tools: { prPhases: phases } }, warnings: [], errors: [], safetyFallback: false, roles: {}, source: "cli" }) as MergedConfig,
    runOp: () => async (op, args) => {
      if (op !== "pr_batch") return { kind: "ran", result: { comments: [] } } as SafeOpOutcome;
      const prs = (args.prs as unknown[]).map(() => r);
      return { kind: "ran", result: { prs, errors: [] } } as SafeOpOutcome;
    },
    refresh: async () => "refreshed",
  };
  await addTracked(agentDir, "acme/app", 1, () => T0 - 1000);
  const poll = async () => {
    clock.t += 100_000;
    await pollPrs(deps);
    return JSON.parse(fs.readFileSync(trackedStateFile(agentDir), "utf8")).prs["acme/app#1"];
  };
  return { poll };
}


test("the tracker writes rulesKey (the key of the live rules) and parseSnap keeps it; no matching rule: no key", async () => {
  const h = await setup([{ ignore: ["lint"], mergeLabel: "merge-ok" }], row({ required: ["build", "lint"], runs: [trun("build", "passed")] }));
  const e = await h.poll();
  assert.equal(e.snap.rulesKey, rulesKeyOf(rulesOf([{ ignore: ["lint"], mergeLabel: "merge-ok" }]), "acme/app"));
  assert.ok(e.snap.rulesKey);
  assert.equal(parseSnap(e.snap)?.rulesKey, e.snap.rulesKey);
  const none = await (await setup([{ repos: ["other/*"], ignore: ["lint"] }], row({ runs: [trun("build", "passed")] }))).poll();
  assert.equal(none.snap.rulesKey, undefined);
});
