// tools.prPhases mutant killers, round 3: the phase-1 lists and counts of a message, the gated blocked line, the gate-waiting guard and the `open` filter of the tracker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baselineOf, prDelta, prMessage } from "../prwatch.ts";
import type { Bucket, Delta, Run, WatchSnapshot } from "../prwatch.ts";
import { parsePhases, phasesStep } from "../prphases.ts";

const A = "a".repeat(40);
const RULES = parsePhases([{ gate: ["deploy*"], ignore: ["review-*"], mergeLabel: "merge-ok" }]).rules;
const run = (name: string, bucket: Bucket, id = name): Run => ({ id, name, bucket, url: `https://h.invalid/${name}` });
const snap = (runs: Run[], o: Partial<WatchSnapshot> = {}): WatchSnapshot => {
  const s = phasesStep(RULES, "acme/app", runs, o.required);
  return { state: "open", mergeable: "mergeable", head: A, base: "main", updatedAt: "t0", mergeState: "clean", draft: false, ...o, ...s };
};
const snapOf = (rules: typeof RULES) => (runs: Run[], o: Partial<WatchSnapshot> = {}): WatchSnapshot => {
  const s = phasesStep(rules, "acme/app", runs, o.required);
  return { state: "open", mergeable: "mergeable", head: A, base: "main", updatedAt: "t0", mergeState: "clean", draft: false, ...o, ...s };
};
const text = (d: Delta | null | undefined) => (d ? prMessage(7, d).content : "");

test("checks finished: fail lists only phase-1 runs; the counts leave out gate and not-counted runs", () => {
  const base = baselineOf(snap([run("build", "pending")]));
  const runs = [run("build", "failed"), run("deploy", "failed"), run("review-x", "failed"), run("lint", "passed"), run("deploy-b", "passed")];
  const r = prDelta(base, snap(runs), false);
  assert.ok(r.delta?.events.includes("checks finished: fail"), String(r.delta?.events));
  assert.deepEqual(r.delta?.failed.map((f) => f.name), ["build"]);
  const t = text(r.delta);
  assert.match(t, /checks 1 passed, 1 failed, 0 pending, 0 missing/);
  assert.deepEqual(t.split("\n").filter((l) => l.startsWith("- failed ")).map((l) => l.split(" ")[2]), ["build"]);
  assert.match(t, /- gate failed deploy /);
});

test("checks finished: fail lists only phase-1 missing runs", () => {
  const base = baselineOf(snap([run("build", "pending")]));
  const runs = [run("build", "failed"), run("m1", "missing"), run("deploy-m", "missing"), run("review-m", "missing")];
  const r = prDelta(base, snap(runs), false);
  assert.ok(r.delta?.events.includes("checks finished: fail"), String(r.delta?.events));
  assert.deepEqual(r.delta?.missing, ["m1"]);
  assert.deepEqual(text(r.delta).split("\n").filter((l) => l.startsWith("- missing ")), ["- missing m1"]);
});

test("a gated repository with merge state blocked: ready to merge, the blocked line, and no `merge state blocked` line or report", () => {
  const base = baselineOf(snap([run("build", "pending")], { mergeState: "blocked" }));
  const r = prDelta(base, snap([run("build", "passed")], { mergeState: "blocked" }), true);
  assert.ok(r.delta?.events.includes("ready to merge"), String(r.delta?.events));
  assert.equal(r.delta?.notReady, undefined);
  assert.ok(!r.delta?.events.some((e) => e.startsWith("checks passed, merge state blocked")), String(r.delta?.events));
  const t = text(r.delta);
  assert.doesNotMatch(t, /merge state blocked, /);
  assert.doesNotMatch(t, /report to the parent: PR #7 checks passed/);
  assert.match(t, /report to the parent: PR #7 green on aaaaaaa, mergeable, ready to merge/);
  assert.equal(r.state.notReadyKey ?? "", "");
});

test("gate checks finished waits while gate.waiting is not empty, and is sent once when it empties", () => {
  const required = ["build", "deploy", "deploy-b"];
  const base = baselineOf(snap([run("build", "pending"), run("deploy", "pending")], { required }));
  const waiting = snap([run("build", "passed"), run("deploy", "passed")], { required });
  assert.deepEqual(waiting.gate?.waiting, ["deploy-b"]);
  const a = prDelta(base, waiting, false);
  assert.ok(!a.delta?.events.some((e) => e.startsWith("gate checks finished")), String(a.delta?.events));
  assert.equal(a.state.gateCi ?? "", "");
  const done = snap([run("build", "passed"), run("deploy", "passed"), run("deploy-b", "passed")], { required });
  const b = prDelta(a.state, done, false);
  assert.equal(b.delta?.events.filter((e) => e === "gate checks finished: pass").length, 1, String(b.delta?.events));
  const c = prDelta(b.state, done, false);
  assert.ok(!c.delta?.events.some((e) => e.startsWith("gate checks finished")), String(c.delta?.events));
});

test("a gated head in merge state behind or unknown is not ready: the host's line is sent; ungated blocked sends its line; a gated clean head has no blocked line", () => {
  const go = (rules: typeof RULES, state: string) => {
    const mk = (runs: Run[]): WatchSnapshot => ({ ...snapOf(rules)(runs), mergeState: state });
    return prDelta(baselineOf(mk([run("build", "pending")])), mk([run("build", "passed")]), true);
  };
  const behind = go(RULES, "behind");
  assert.ok(!behind.delta?.events.includes("ready to merge"), String(behind.delta?.events));
  assert.ok(behind.delta?.notReady, String(behind.delta?.events));
  const plain = go([], "blocked");
  assert.ok(!plain.delta?.events.includes("ready to merge"), String(plain.delta?.events));
  assert.ok(plain.delta?.notReady, String(plain.delta?.events));
  assert.match(text(plain.delta), /report to the parent: PR #7 checks passed, merge state blocked/);
  const clean = go(RULES, "clean");
  assert.ok(clean.delta?.events.includes("ready to merge"));
  assert.equal(clean.delta?.blocked, undefined);
  assert.doesNotMatch(text(clean.delta), /merge state blocked/);
});

test("the gate result: a missing gate run is a fail; a made-up pending run of a source that did not answer does not hold it; a running gate shows its line", () => {
  const base = baselineOf(snap([run("build", "pending"), run("deploy", "pending")]));
  const miss = prDelta(base, snap([run("build", "passed"), run("deploy", "missing")]), false);
  assert.ok(miss.delta?.events.includes("gate checks finished: fail"), String(miss.delta?.events));
  const noAnswer: Run = { ...run("deploy-src", "pending"), noAnswer: true };
  const na = prDelta(base, snap([run("build", "passed"), run("deploy", "passed"), noAnswer]), false);
  assert.ok(na.delta?.events.includes("gate checks finished: pass"), String(na.delta?.events));
  const running = prDelta(base, snap([run("build", "passed"), run("deploy", "pending")]), false);
  assert.match(text(running.delta), /\n- gate running/);
  // the stand-in alone is no gate run: no `gate checks finished: pass`
  const only = prDelta(base, snap([run("build", "passed"), noAnswer]), false);
  assert.ok(!only.delta?.events.some((e) => e.startsWith("gate checks finished")), String(only.delta?.events));
});

test("gate_settled follows the wake rules: a rule set without it sends no `gate checks finished`", () => {
  const rules = [{ source: "*", repos: null, events: ["check_failed" as const], authors: "any" as const, checks: null, wake: true }];
  const base = baselineOf(snap([run("build", "pending"), run("deploy", "pending")]));
  const off = prDelta(base, snap([run("build", "passed"), run("deploy", "passed")]), false, rules, "acme/app");
  assert.ok(!off.delta?.events.some((e) => e.startsWith("gate checks finished")), String(off.delta?.events));
  const on = prDelta(base, snap([run("build", "passed"), run("deploy", "passed")]), false);
  assert.ok(on.delta?.events.includes("gate checks finished: pass"));
});

// ---- the tracker: the `open` value of the expect step (prs-cli.ts expectSteps)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pollPrs } from "../prs-cli.ts";
import type { PollDeps } from "../prs-cli.ts";
import { addTracked, clearStoreCache, trackedStateFile } from "../prstore.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import type { MergedConfig } from "../config.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const T0 = 50_000_000;
type Row = Record<string, unknown>;
const trun = (name: string, bucket: string): Row => ({ id: name, name, bucket, url: "x", expected: true });
const trow = (o: Row = {}): Row => ({ repo: "acme/app", number: 1, state: "open", mergeable: "mergeable", headSha: "h1", baseRef: "main", updatedAt: "u1", url: "https://github.com/acme/app/pull/1", title: "t", draft: false, headRefName: "feat", headRepo: "acme/app", ...o });

async function polled(r: Row, baseline: Row | undefined, flagBaseline = true) {
  clearStoreCache();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-prphases3-"));
  const clock = { t: T0 };
  const deps: PollDeps = {
    agentDir,
    pkgRoot: PKG,
    now: () => clock.t,
    resolve: async (p) => ({ ok: true, info: { executable: p ?? "/py", version: [3, 13], source: "test" }, rejected: [] }),
    loadConfig: async () => ({ config: { tools: { prPhases: [{ gate: ["ci/gate"] }] } }, warnings: [], errors: [], safetyFallback: false, roles: {}, source: "cli" }) as MergedConfig,
    runOp: () => async (op, args) => {
      if (op !== "pr_batch") return { kind: "ran", result: { comments: [] } } as SafeOpOutcome;
      const prs = (args.prs as { baseline?: boolean }[]).map((e) => (flagBaseline && e.baseline && baseline ? { ...r, baseline } : r));
      return { kind: "ran", result: { prs, errors: [] } } as SafeOpOutcome;
    },
    refresh: async () => "refreshed",
  };
  await addTracked(agentDir, "acme/app", 1, () => T0 - 1000);
  clock.t += 100_000;
  await pollPrs(deps);
  return JSON.parse(fs.readFileSync(trackedStateFile(agentDir), "utf8")).prs["acme/app#1"];
}

test("a head whose only passed run is a gate run is not unsettled because of it (baseline with a missing check)", async () => {
  const e = await polled(trow({ runs: [trun("ci/gate", "passed")] }), { names: ["build"] });
  assert.equal(e.unsettled, undefined, JSON.stringify(e.snap.expect));
});

test("a head whose only passed run is a gate run is not unsettled because of it (baseline unknown)", async () => {
  const e = await polled(trow({ runs: [trun("ci/gate", "passed")] }), { error: "x" });
  assert.equal(e.unsettled, undefined, JSON.stringify(e.snap.expect));
});

async function tracker(phases: unknown, source = false) {
  clearStoreCache();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-prphases3-"));
  const clock = { t: T0 };
  const cur: { row: Row; baseline?: Row } = { row: trow() };
  const refreshed: (readonly unknown[] | undefined)[] = [];
  const deps: PollDeps = {
    agentDir,
    pkgRoot: PKG,
    now: () => clock.t,
    resolve: async (p) => ({ ok: true, info: { executable: p ?? "/py", version: [3, 13], source: "test" }, rejected: [] }),
    loadConfig: async () => ({ config: { tools: { prPhases: phases, ...(source ? { prSources: { ext: { command: "x" } } } : {}) } }, warnings: [], errors: [], safetyFallback: false, roles: {}, source: "cli" }) as MergedConfig,
    runOp: () => async (op, args) => {
      if (op !== "pr_batch") return { kind: "ran", result: { comments: [] } } as SafeOpOutcome;
      const prs = (args.prs as { baseline?: boolean }[]).map((e) => (e.baseline && cur.baseline ? { ...cur.row, baseline: cur.baseline } : cur.row));
      return { kind: "ran", result: { prs, errors: [] } } as SafeOpOutcome;
    },
    refresh: async (_c, _h, p) => (refreshed.push(p), "refreshed"),
    ...(source ? { runSource: async () => ({ outcome: "ok" as const, checks: [{ id: "1", name: "scan", status: "passed" as const, url: "x" }], comments: [] }) } : {}),
  };
  await addTracked(agentDir, "acme/app", 1, () => T0 - 1000);
  const poll = async (advance = 100_000) => {
    clock.t += advance;
    const res = await pollPrs(deps);
    return { res, e: JSON.parse(fs.readFileSync(trackedStateFile(agentDir), "utf8")).prs["acme/app#1"] };
  };
  return { cur, poll, refreshed };
}

test("a malformed tools.prPhases rule is the poll's error; the open-PR refresh gets the rules", async () => {
  const bad = await tracker("nope");
  assert.match(String((await bad.poll()).res.error), /tools\.prPhases must be a list/);
  const good = await tracker([{ gate: ["ci/gate"] }]);
  const { res } = await good.poll();
  assert.equal(res.error, undefined);
  assert.equal(good.refreshed.length, 1);
  assert.deepEqual((good.refreshed[0] as { gate: string[] }[]).map((r) => r.gate), [["ci/gate"]]);
});

test("a merged PR's stored snap is not sorted by the phases", async () => {
  const t = await tracker([{ gate: ["ci/gate"] }]);
  t.cur.row = trow({ state: "merged", runs: [trun("build", "passed"), trun("ci/gate", "passed")] });
  const { e } = await t.poll();
  assert.equal(e.snap.state, "merged");
  assert.ok(e.snap.runs.every((r: Row) => r.phase === undefined && r.gates === undefined), JSON.stringify(e.snap.runs));
});

test("a stored baseline is read without its gate names when a later answer for it failed", async () => {
  const t = await tracker([{ gate: ["ci/gate"] }]);
  t.cur.row = trow({ runs: [trun("build", "passed")] });
  t.cur.baseline = { names: ["build", "ci/gate"] };
  await t.poll();
  t.cur.row = trow({ runs: [trun("build", "passed")], updatedAt: "u2", headSha: "h2" });
  t.cur.baseline = { error: "x" };
  const { e } = await t.poll(1_000_000);
  assert.ok(!(e.snap.expect?.missing ?? []).includes("ci/gate"), JSON.stringify(e.snap.expect));
  assert.equal(e.unsettled === true && e.snap.expect !== undefined, false, JSON.stringify(e));
});

test("after the source merge the phases are sorted again from the host's raw required list: the gate name still waits", async () => {
  const t = await tracker([{ gate: ["ci/gate*"] }], true);
  t.cur.row = trow({ runs: [trun("build", "passed"), trun("ci/gate1", "pending")], required: ["build", "ci/gate1", "ci/gate2"] });
  const { e } = await t.poll();
  assert.ok(e.snap.runs.some((r: Row) => r.name === "ext/scan" || r.source === "ext"), JSON.stringify(e.snap.runs));
  assert.deepEqual(e.snap.gate, { state: "running", waiting: ["ci/gate2"] });
  assert.deepEqual(e.snap.required, ["build"]);
});

// ---- the open-PR feed: the rules reach the refresh and the refresher
import { OpenPrsRefresher, openPrsConfig, openPrsFile, refreshOpenPrs } from "../openprs.ts";
import type { GhRunner, OpenPrsFile } from "../openprs.ts";
import type { PhaseRule } from "../prphases.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const FEED = JSON.stringify({ data: { search: { nodes: [{
  number: 1, title: "PR 1", url: "https://example.test/acme/app/pull/1", isDraft: false, repository: { nameWithOwner: "acme/app" }, author: { login: "octo" },
  commits: { nodes: [{ commit: { oid: "a".repeat(40), statusCheckRollup: { state: "PENDING", contexts: { nodes: [{ __typename: "StatusContext", context: "build", state: "SUCCESS" }, { __typename: "StatusContext", context: "ci/gate", state: "PENDING" }] } } } }] },
}] } } });
const FEED_RULES: PhaseRule[] = [{ repos: null, gate: ["ci/gate"], ignore: [], mergeLabel: "" }];
const gh: GhRunner = async () => FEED;

test("refreshOpenPrs sorts the found PRs by the rules it is given", async () => {
  const dir = mkTestTmp("prphases3-");
  const file = openPrsFile(dir);
  const read = () => JSON.parse(fs.readFileSync(file, "utf8")) as OpenPrsFile;
  assert.equal(await refreshOpenPrs({ file, config: openPrsConfig({ enabled: true }), gh, now: () => 1_000_000_000_000, force: true, phases: FEED_RULES }), "refreshed");
  assert.deepEqual(read().openPrs[0].checks.map((c) => c.phase), [undefined, 2]);
  assert.deepEqual(read().openPrs[0].gate, { state: "running" });
  rmTestTmp(dir);
});

test("the refresher passes its phases to every refresh", async () => {
  const dir = mkTestTmp("prphases3-");
  const rf = new OpenPrsRefresher({ agentDir: dir, config: () => ({ enabled: true }), gh, phases: () => FEED_RULES });
  assert.equal(await rf.tick(), "refreshed");
  const f = JSON.parse(fs.readFileSync(openPrsFile(dir), "utf8")) as OpenPrsFile;
  assert.deepEqual(f.openPrs[0].checks.map((c) => c.phase), [undefined, 2]);
  rmTestTmp(dir);
});

// ---- prphases.ts: the rule parser
import { phaseOf } from "../prphases.ts";

test("parsePhases: null is no rules; a non-list is an error; the name lists and the merge label are checked as the docs say", () => {
  assert.deepEqual(parsePhases(null).errors, []);
  assert.deepEqual(parsePhases("x").errors, ["tools.prPhases must be a list"]);
  const bad = (rule: unknown) => parsePhases([rule]).errors.join("|");
  assert.match(bad({ gate: "ci" }), /gate must be a list of at most 64 globs/);
  assert.match(bad({ ignore: "ci" }), /ignore must be a list of at most 64 globs/);
  assert.match(bad({ gate: Array.from({ length: 65 }, (_, i) => `g${i}`) }), /gate must be a list of at most 64 globs/);
  assert.match(bad({ mergeLabel: 5 }), /mergeLabel must be 1 to 50 characters/);
  assert.match(bad({ mergeLabel: "-x" }), /mergeLabel must be/);
  assert.match(bad({ mergeLabel: "x".repeat(51) }), /mergeLabel must be/);
  const ok = parsePhases([{ gate: [], ignore: [], mergeLabel: "" }, { mergeLabel: "x".repeat(50) }]);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.rules.map((r) => r.mergeLabel.length), [0, 50]);
});

test("a source check matches by its raw name only under its own source prefix", () => {
  const rules = parsePhases([{ gate: ["scan"] }]).rules;
  assert.equal(phaseOf(rules, "a/b", { name: "ext/scan", source: "ext" }), 2);
  assert.equal(phaseOf(rules, "a/b", { name: "ext/scan", source: "other" }), 1);
  assert.equal(phaseOf(rules, "a/b", { name: "scan", source: "ext" }), 2);
});

import { gateOf, tagChecks } from "../prphases.ts";

test("a raw source name only strips its own `<source>/` prefix; the required names match runs by name or by raw name; only gate names wait", () => {
  const rules = parsePhases([{ gate: ["scan"] }]).rules;
  assert.equal(phaseOf(rules, "a/b", { name: "ext-scan", source: "ext" }), 1);
  const src = (name: string, source: string): Run => ({ ...run(name, "passed"), source });
  const raw = phasesStep(rules, "a/b", [run("build", "passed"), src("ext/scan", "ext")], ["build", "scan"]);
  assert.equal(raw.gate?.waiting, undefined, "a gate name that a source run answers by its raw name does not wait");
  const full = phasesStep(parsePhases([{ gate: ["ext/scan"] }]).rules, "a/b", [run("build", "passed"), src("ext/scan", "ext")], ["build", "ext/scan"]);
  assert.equal(full.gate?.waiting, undefined, "a required name equal to the run's name does not wait");
  const one = phasesStep(rules, "a/b", [run("build", "passed")], ["build", "lint", "scan"]);
  assert.deepEqual(one.gate, { state: "waiting", waiting: ["scan"] }, "a phase-1 name with no run is not a waiting gate name");
});

test("gateOf: a missing gate run is a failed gate", () => {
  assert.deepEqual(gateOf([{ bucket: "missing", phase: 2 }]), { state: "failed" });
});

test("tagChecks: no rules with an unknown repository, and a repository no rule matches, leave the answer exactly as it is", () => {
  const res = { action: "pr_checks", pending: [], failed: [{ name: "build" }], passed: [], summary: "host text" };
  assert.deepEqual(tagChecks([], null, res), res);
  assert.deepEqual(tagChecks(parsePhases([{ repos: ["acme/*"], gate: ["x"] }]).rules, "other/app", res), res);
});

test("tagChecks: the failed list of the summary is capped at five names, the rest is counted", () => {
  const rules = parsePhases([{ gate: ["deploy"] }]).rules;
  const fails = (n: number) => ({ pending: [], passed: [], failed: Array.from({ length: n }, (_, i) => ({ name: `f${i}` })) });
  assert.equal(tagChecks(rules, "a/b", fails(5)).summary, "0 passed, 5 failed (f0, f1, f2, f3, f4), 0 pending");
  assert.equal(tagChecks(rules, "a/b", fails(6)).summary, "0 passed, 6 failed (f0, f1, f2, f3, f4, +1), 0 pending");
  assert.equal(tagChecks(rules, "a/b", fails(7)).summary, "0 passed, 7 failed (f0, f1, f2, f3, f4, +2), 0 pending");
});

import { parseSnap } from "../prstore.ts";

test("parseSnap reads the gate state of every kind, keeps only string waiting names (at most 10) and drops an unknown state", () => {
  const snapOf2 = (gate: unknown) => parseSnap({ state: "open", runs: [], gate });
  for (const state of ["waiting", "running", "failed", "passed"]) assert.deepEqual(snapOf2({ state })?.gate, { state }, state);
  assert.equal(snapOf2({ state: "bogus" })?.gate, undefined);
  const names = Array.from({ length: 12 }, (_, i) => `n${i}`);
  assert.deepEqual(snapOf2({ state: "waiting", waiting: [1, ...names] })?.gate?.waiting, names.slice(0, 10));
});
