// More of the tracker's side of the expected checks (prs-cli.ts expectSteps), through pollPrs and the stored state: a row without the baseline field, a gating source
// run, bases never asked before, entries from before the facts, push-only CI on a first head, a head that already passed when the baseline drifts, a malformed `exp`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pollPrs } from "../prs-cli.ts";
import type { PollDeps } from "../prs-cli.ts";
import { addTracked, clearStoreCache, readStoreEntry, trackedStateFile } from "../prstore.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import type { MergedConfig } from "../config.ts";
import type { SourceResult } from "../prsources.ts";
import { baselineOf, prDelta } from "../prwatch.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const T0 = 50_000_000;
const MIN = 60_000;
const SETTLE = 90_000;

type Row = Record<string, unknown>;
const run = (name: string, bucket: string): Row => ({ id: name, name, bucket, url: "x", expected: true });
const row = (n: number, o: Row = {}): Row => ({ repo: "acme/app", number: n, state: "open", mergeable: "mergeable", headSha: "h1", baseRef: "main", updatedAt: "u1", url: `https://github.com/acme/app/pull/${n}`, title: "t", draft: false, headRefName: "feat", headRepo: "acme/app", required: null, runs: [run("quick", "passed")], ...o });

async function setup(numbers = [1], withSource = false) {
  clearStoreCache();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-prexpect-po-"));
  const clock = { t: T0 };
  const rows = new Map<number, Row>();
  const asked: number[][] = [];
  const baseline = { v: { names: ["quick", "ci"] } as Row | undefined };
  const source = { status: "pending" };
  const deps: PollDeps = {
    agentDir,
    pkgRoot: PKG,
    now: () => clock.t,
    resolve: async (p) => ({ ok: true, info: { executable: p ?? "/py", version: [3, 13], source: "test" }, rejected: [] }),
    loadConfig: async () => ({ config: withSource ? { tools: { prSources: { ci: { command: "prog {head}" } } } } : {}, warnings: [], errors: [], safetyFallback: false, roles: {}, source: "cli" }) as MergedConfig,
    runOp: () => async (op, args) => {
      if (op !== "pr_batch") return { kind: "ran", result: { comments: [] } } as SafeOpOutcome;
      const flagged: number[] = [];
      const prs = (args.prs as { n: number; baseline?: boolean }[]).map((e) => {
        if (e.baseline) flagged.push(e.n);
        const r = rows.get(e.n)!;
        return e.baseline && baseline.v ? { ...r, baseline: baseline.v } : r;
      });
      asked.push(flagged);
      return { kind: "ran", result: { prs, errors: [] } } as SafeOpOutcome;
    },
    refresh: async () => "refreshed",
    runSource: async (): Promise<SourceResult> => ({ outcome: "ok", checks: [{ id: "s1", name: "deploy", status: source.status as "pending", url: "u" }], comments: [] }),
  };
  for (const n of numbers) {
    await addTracked(agentDir, "acme/app", n, () => T0 - 1000);
    rows.set(n, row(n));
  }
  const doc = () => JSON.parse(fs.readFileSync(trackedStateFile(agentDir), "utf8"));
  const put = (d: unknown) => {
    fs.writeFileSync(trackedStateFile(agentDir), JSON.stringify(d));
    clearStoreCache();
  };
  const poll = async (advanceMs: number) => {
    clock.t += advanceMs;
    await pollPrs(deps);
    return doc();
  };
  return { poll, rows, asked, baseline, source, agentDir, clock, doc, put };
}
const E = "acme/app#1";

test("a row without the baseline field is today's behaviour: known empty, no facts, the 90 s hold; the whole host counts as answered without it", async () => {
  const h = await setup([1, 2]);
  h.baseline.v = undefined;
  let s = await h.poll(0);
  assert.deepEqual(h.asked[0], [1]);
  for (const k of [E, "acme/app#2"]) {
    assert.equal(s.prs[k].snap.expect, undefined, `${k}: no facts`);
    assert.deepEqual(s.prs[k].exp.names, [], `${k}: a known empty set is frozen`);
  }
  assert.equal(s.prs[E].unsettled, true, "the ordinary settle hold of a fresh pass");
  s = await h.poll(SETTLE + 1000);
  assert.equal(s.prs[E].unsettled, undefined);
});

test("a known-empty baseline with runs keeps today's hold at the default 90 s, in the tracker and in the watch", async () => {
  const h = await setup();
  h.baseline.v = { names: [] };
  let s = await h.poll(0);
  assert.equal(s.prs[E].snap.expect, undefined);
  assert.equal(s.prs[E].unsettled, true);
  s = await h.poll(SETTLE - 30_000);
  assert.equal(s.prs[E].unsettled, true, "still held inside the settle time");
  s = await h.poll(2 * MIN);
  assert.equal(s.prs[E].unsettled, undefined);
  const read = readStoreEntry(h.agentDir, { host: "github.com", repo: "acme/app", n: 1 }, h.clock.t, true);
  assert.equal(read.kind, "entry");
  if (read.kind !== "entry") return;
  const pending = { ...read.snap, runs: [{ id: "quick", name: "quick", bucket: "pending" as const, url: "x" }] };
  const gate = (now: number) => ({ settleMs: SETTLE, now });
  let r = prDelta(baselineOf(pending), read.snap, false, undefined, "", undefined, true, gate(0));
  assert.equal(r.delta, null);
  r = prDelta(r.state, read.snap, false, undefined, "", undefined, true, gate(SETTLE - 1));
  assert.equal(r.delta, null);
  r = prDelta(r.state, read.snap, false, undefined, "", undefined, true, gate(SETTLE));
  assert.deepEqual(r.delta?.events, ["checks finished: pass"]);
});

test("a gating source run keeps its effect: the facts are computed after the source merge", async () => {
  const h = await setup([1], true);
  h.source.status = "pending";
  await h.poll(0);
  let s = await h.poll(11 * MIN);
  assert.deepEqual(s.prs[E].snap.expect.missing, ["ci"]);
  assert.equal(s.prs[E].snap.expect.overdue, undefined, "a pending source run holds the line back");
  assert.equal(s.prs[E].unsettled, true);
  h.source.status = "failed";
  s = await h.poll(11 * MIN);
  assert.equal(s.prs[E].unsettled, undefined, "a failed source run is a failure, not a hold");
  assert.equal(s.prs[E].snap.expect.overdue, undefined);
  h.source.status = "passed";
  await h.poll(MIN);
  s = await h.poll(11 * MIN);
  assert.equal(s.prs[E].snap.expect.overdue, true, "with the source run passed and nothing moving, the bound passes");
});

test("a base never asked before is unknown and flagged on the next poll; an unknown answer is asked again", async () => {
  const h = await setup([1, 2]);
  h.rows.set(2, row(2, { baseRef: "dev" }));
  let s = await h.poll(0);
  assert.deepEqual(h.asked[0], [1], "one flagged entry for the repository");
  assert.equal(s.prs[E].snap.expect?.unknown, undefined);
  assert.equal(s.prs["acme/app#2"].snap.expect.unknown, true, "a PR polled later than the flagged entry: unknown");
  assert.equal(s.prs["acme/app#2"].unsettled, true);
  h.baseline.v = { error: true };
  s = await h.poll(30_000);
  assert.deepEqual(h.asked[1], [2], "its base is known now and was never asked: flagged");
  assert.equal(s.prs["acme/app#2"].snap.expect.unknown, true, "the failed answer leaves it unknown");
  s = await h.poll(30_000);
  assert.deepEqual(h.asked[2], [2], "asked again");
  h.baseline.v = { names: ["quick"] };
  s = await h.poll(30_000);
  assert.deepEqual(h.asked[3], [2]);
  assert.equal(s.prs["acme/app#2"].snap.expect, undefined);
  await h.poll(30_000);
  assert.deepEqual(h.asked[4], [], "answered: nothing asked while it is fresh");
});

test("a new base inside the 10 minutes: a PR added later on another base is flagged on its first poll", async () => {
  const h = await setup([1]);
  await h.poll(0);
  await addTracked(h.agentDir, "acme/app", 3, () => h.clock.t);
  h.rows.set(3, row(3, { baseRef: "release" }));
  h.baseline.v = { error: true };
  const s = await h.poll(MIN);
  assert.deepEqual(h.asked.at(-1), [3]);
  assert.equal(s.prs["acme/app#3"].snap.expect.unknown, true);
  assert.equal(s.prs[E].snap.expect?.unknown, undefined, "the fresh baseline of the first base stays");
});

test("a new entry with an unknown baseline is not matched by the upgrade rule on its second poll", async () => {
  const h = await setup();
  h.baseline.v = { error: true };
  let s = await h.poll(0);
  assert.ok(s.prs[E].exp, "the marker is written while the baseline is unknown");
  s = await h.poll(30_000);
  assert.equal(s.prs[E].snap.expect.unknown, true);
  assert.equal(s.prs[E].exp.names, undefined, "no empty set was frozen");
  assert.equal(s.prs[E].unsettled, true);
  s = await h.poll(5 * MIN);
  assert.equal(s.prs[E].unsettled, true);
});

test("an entry from before the change that was mid-CI is treated as a first sight, not upgraded", async () => {
  const h = await setup();
  await h.poll(0);
  const d = h.doc();
  delete d.prs[E].exp;
  delete d.prs[E].snap.expect;
  delete d.prs[E].unsettled;
  d.prs[E].snap.runs = [{ id: "quick", name: "quick", bucket: "pending", url: "x" }];
  h.put(d);
  const s = await h.poll(30_000);
  assert.deepEqual(s.prs[E].snap.expect.missing, ["ci"], "vetoed: the set is not frozen empty");
  assert.deepEqual(s.prs[E].exp.names, ["quick", "ci"]);
  assert.equal(s.prs[E].unsettled, true);
});

test("push-only CI on a first head: the merged heads carry push runs only, one quick check done, past the settle time: no pass", async () => {
  const h = await setup();
  h.baseline.v = { names: ["quick", "build (push)", "test (push)"] };
  await h.poll(0);
  const s = await h.poll(10 * MIN - 1000);
  assert.deepEqual(s.prs[E].snap.expect.missing.sort(), ["build (push)", "test (push)"]);
  assert.equal(s.prs[E].unsettled, true);
  const read = readStoreEntry(h.agentDir, { host: "github.com", repo: "acme/app", n: 1 }, h.clock.t, true);
  assert.equal(read.kind, "entry");
  if (read.kind !== "entry") return;
  const pending = { ...read.snap, runs: [{ id: "quick", name: "quick", bucket: "pending" as const, url: "x" }], expect: undefined };
  const r = prDelta(baselineOf(pending), read.snap, false, undefined, "", undefined, true, { settleMs: SETTLE, now: h.clock.t });
  assert.equal(r.delta, null);
});

test("baseline drift on a head that already passed: the pass is kept, the entry stays settled, no line", async () => {
  const h = await setup();
  h.baseline.v = { names: ["quick"] };
  await h.poll(0);
  let s = await h.poll(2 * MIN);
  assert.equal(s.prs[E].unsettled, undefined);
  h.baseline.v = { names: ["quick", "other"] };
  s = await h.poll(11 * MIN);
  assert.equal(s.baselines["github.com|acme/app|main"].names.includes("other"), true, "the baseline of the repository did change");
  assert.equal(s.prs[E].snap.expect, undefined);
  assert.equal(s.prs[E].unsettled, undefined);
  s = await h.poll(11 * MIN);
  assert.equal(s.prs[E].snap.expect, undefined, "no overdue line is ever due");
  assert.equal(s.prs[E].unsettled, undefined);
  const read = readStoreEntry(h.agentDir, { host: "github.com", repo: "acme/app", n: 1 }, h.clock.t, true);
  assert.equal(read.kind, "entry");
  if (read.kind !== "entry") return;
  const r = prDelta(baselineOf(read.snap), read.snap, false, undefined, "", undefined, true, { settleMs: SETTLE, now: h.clock.t });
  assert.equal(r.delta, null);
  assert.equal(r.state.overdueHead, undefined);
});

test("a stored `exp` that is malformed is dropped: the poll does not throw and the entry gets a valid state", async () => {
  const h = await setup();
  await h.poll(0);
  const d = h.doc();
  d.prs[E].exp = { head: "h1", prev: "oops", names: 5, since: "x", sig: 1, draft: "y" };
  h.put(d);
  const s = await h.poll(30_000);
  assert.ok(Array.isArray(s.prs[E].exp.prev));
  assert.ok(s.prs[E].exp.names === undefined || Array.isArray(s.prs[E].exp.names));
  assert.equal(s.prs[E].snap.expect.unknown === true || Array.isArray(s.prs[E].snap.expect.missing), true);
});
