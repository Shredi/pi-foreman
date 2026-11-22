// The tracker's side of the expected checks: the baseline is asked once per repository and base and kept for 10 minutes, a head freezes its set, a new head
// takes the previous head's names, an entry stored before this change is upgraded without a veto, and the pill flag follows the veto.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pollPrs } from "../prs-cli.ts";
import type { PollDeps } from "../prs-cli.ts";
import { addTracked, clearStoreCache, trackedStateFile } from "../prstore.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import type { MergedConfig } from "../config.ts";
import { trackedTmp } from "./_tmpbase.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const T0 = 50_000_000;
const MIN = 60_000;

type Row = Record<string, unknown>;
const run = (name: string, bucket: string): Row => ({ id: name, name, bucket, url: "x", expected: true });
const row = (n: number, o: Row = {}): Row => ({ repo: "acme/app", number: n, state: "open", mergeable: "mergeable", headSha: "h1", baseRef: "main", updatedAt: "u1", url: `https://github.com/acme/app/pull/${n}`, title: "t", draft: false, headRefName: "feat", headRepo: "acme/app", required: null, runs: [run("quick", "passed")], ...o });

async function setup(numbers = [1]) {
  clearStoreCache();
  const agentDir = trackedTmp("pf-prexpect-tr-");
  const clock = { t: T0 };
  const rows = new Map<number, Row>();
  const asked: number[][] = [];
  const baseline = { v: { names: ["quick", "ci"] } as Row | undefined };
  const deps: PollDeps = {
    agentDir,
    pkgRoot: PKG,
    now: () => clock.t,
    resolve: async (p) => ({ ok: true, info: { executable: p ?? "/py", version: [3, 13], source: "test" }, rejected: [] }),
    loadConfig: async () => ({ config: {}, warnings: [], errors: [], safetyFallback: false, roles: {}, source: "cli" }) as MergedConfig,
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
  };
  for (const n of numbers) {
    await addTracked(agentDir, "acme/app", n, () => T0 - 1000);
    rows.set(n, row(n));
  }
  const doc = () => JSON.parse(fs.readFileSync(trackedStateFile(agentDir), "utf8"));
  const poll = async (advanceMs: number) => {
    clock.t += advanceMs;
    await pollPrs(deps);
    return doc();
  };
  return { poll, rows, asked, baseline, agentDir, clock, doc };
}

test("one baseline question per repository and base, kept 10 minutes, then asked again", async () => {
  const h = await setup([1, 2]);
  await h.poll(0); // the base of neither is known yet: one entry of the repository asks
  assert.deepEqual(h.asked[0], [1]);
  await h.poll(MIN);
  assert.deepEqual(h.asked[1], [], "stored and fresh: nothing asked");
  await h.poll(10 * MIN);
  assert.equal(h.asked[2].length, 1, "older than 10 minutes: asked again, still one");
});

test("a failed answer is asked again on the next poll, and the entry stays unknown meanwhile", async () => {
  const h = await setup();
  h.baseline.v = { error: true };
  const s = await h.poll(0);
  assert.equal(s.prs["acme/app#1"].snap.expect.unknown, true);
  assert.equal(s.prs["acme/app#1"].unsettled, true);
  h.baseline.v = { names: ["quick"] };
  let t = await h.poll(30_000);
  assert.deepEqual(h.asked.at(-1), [1]);
  assert.equal(t.prs["acme/app#1"].snap.expect, undefined);
  t = await h.poll(2 * MIN); // past the ordinary settle hold of a fresh pass
  assert.equal(t.prs["acme/app#1"].unsettled, undefined);
});

test("a head freezes its set; a new head takes the previous head's names", async () => {
  const h = await setup();
  await h.poll(0);
  h.baseline.v = { names: ["quick", "other"] };
  const same = await h.poll(11 * MIN);
  assert.deepEqual(same.prs["acme/app#1"].snap.expect.missing, ["ci"], "the frozen set does not take the later merge");
  h.rows.set(1, row(1, { headSha: "h2", runs: [run("quick", "passed")] }));
  const next = await h.poll(30_000);
  assert.deepEqual(next.prs["acme/app#1"].exp.prev, ["quick"]);
  assert.deepEqual(next.prs["acme/app#1"].snap.expect.missing.sort(), ["other"]);
});

test("a pass the watch could already have seen before this change is not vetoed after the upgrade", async () => {
  const h = await setup();
  await h.poll(0);
  const d = h.doc();
  delete d.prs["acme/app#1"].exp;
  delete d.prs["acme/app#1"].snap.expect;
  delete d.prs["acme/app#1"].unsettled;
  d.prs["acme/app#1"].snap.runs = [{ id: "quick", name: "quick", bucket: "passed", url: "x" }];
  fs.writeFileSync(trackedStateFile(h.agentDir), JSON.stringify(d));
  clearStoreCache();
  let s = await h.poll(30_000);
  assert.equal(s.prs["acme/app#1"].snap.expect, undefined);
  s = await h.poll(2 * MIN);
  assert.equal(s.prs["acme/app#1"].unsettled, undefined);
});

test("a failing check leaves the entry without the unsettled flag", async () => {
  const h = await setup();
  h.rows.set(1, row(1, { runs: [run("quick", "failed")] }));
  const s = await h.poll(0);
  assert.equal(s.prs["acme/app#1"].unsettled, undefined);
});

test("a repository with no CI keeps no facts and no flag", async () => {
  const h = await setup();
  h.baseline.v = { names: [] };
  h.rows.set(1, row(1, { runs: [] }));
  const s = await h.poll(0);
  assert.equal(s.prs["acme/app#1"].snap.expect, undefined);
  assert.equal(s.prs["acme/app#1"].unsettled, undefined);
});
