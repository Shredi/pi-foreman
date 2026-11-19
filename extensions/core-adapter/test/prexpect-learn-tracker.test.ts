// D101 (plan v2) on the tracker's side: the baseline's `learn` list is stored, the case of a PR whose only missing runs are required names is decided after the baseline step
// (merge-time, pre-merge, not learnable) and written to the snap as `learn`, the expect facts are filtered per case, `unsettled` and `waiting` follow the case, and the
// store entry reaches a watch through readStoreEntry.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pollPrs } from "../prs-cli.ts";
import type { PollDeps } from "../prs-cli.ts";
import { addTracked, clearStoreCache, readStoreEntry, trackedStateFile } from "../prstore.ts";
import { baselineOf, checksOf, prDelta } from "../prwatch.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import type { MergedConfig } from "../config.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const T0 = 50_000_000;
const MIN = 60_000;
const KEY = "acme/app#1";
const BASE_KEY = "github.com|acme/app|main";

type Row = Record<string, unknown>;
const run = (name: string, bucket: string): Row => ({ id: name, name, bucket, url: "x", expected: true });
const row = (o: Row = {}): Row => ({ repo: "acme/app", number: 1, state: "open", mergeable: "mergeable", headSha: "h1", baseRef: "main", updatedAt: "u1", url: "https://github.com/acme/app/pull/1", title: "t", draft: false, headRefName: "feat", headRepo: "acme/app", required: ["check", "gate"], runs: [run("check", "passed")], ...o });
const learned = (ran: string[], merged = 3): Row => ({ names: ran, learn: { ran, merged } });

async function setup(baseline: Row | undefined) {
  clearStoreCache();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-prlearn-"));
  const clock = { t: T0 };
  const world = { row: row(), baseline };
  const deps: PollDeps = {
    agentDir,
    pkgRoot: PKG,
    now: () => clock.t,
    resolve: async (p) => ({ ok: true, info: { executable: p ?? "/py", version: [3, 13], source: "test" }, rejected: [] }),
    loadConfig: async () => ({ config: {}, warnings: [], errors: [], safetyFallback: false, roles: {}, source: "cli" }) as MergedConfig,
    runOp: () => async (op, args) => {
      if (op !== "pr_batch") return { kind: "ran", result: { comments: [] } } as SafeOpOutcome;
      const prs = (args.prs as { baseline?: boolean }[]).map((e) => (e.baseline && world.baseline ? { ...world.row, baseline: world.baseline } : world.row));
      return { kind: "ran", result: { prs, errors: [] } } as SafeOpOutcome;
    },
    refresh: async () => "refreshed",
  };
  await addTracked(agentDir, "acme/app", 1, () => T0 - 1000);
  const doc = () => JSON.parse(fs.readFileSync(trackedStateFile(agentDir), "utf8"));
  const poll = async (advanceMs: number) => {
    clock.t += advanceMs;
    await pollPrs(deps);
    return doc();
  };
  return { poll, world, doc, agentDir, clock };
}

test("case 1: the baseline fetched in this very poll decides: learn merge-time, no facts, no unsettled, the names in waiting", async () => {
  const h = await setup(learned(["check"]));
  const e = (await h.poll(0)).prs[KEY];
  assert.equal(e.snap.learn, "merge-time");
  assert.equal(e.snap.expect, undefined);
  assert.equal(e.unsettled, undefined);
  assert.deepEqual(e.waiting, ["gate"]);
  assert.deepEqual(h.doc().baselines[BASE_KEY].learn, { ran: ["check"], merged: 3 }, "the learning list is stored beside the names");
});

test("case 1: a required list of 12 names with 11 merge-time names missing is case 1 (no cap on the case)", async () => {
  const required = ["check", ...Array.from({ length: 11 }, (_, i) => `job-${i}`)];
  const h = await setup(learned(["check"]));
  h.world.row = row({ required });
  const e = (await h.poll(0)).prs[KEY];
  assert.equal(e.snap.learn, "merge-time");
  assert.equal(e.unsettled, undefined);
  assert.equal(e.waiting.length, 10, "the names shown are capped at 10");
});

test("case 2: a missing name that ran before the merge: learn pre-merge, the facts hold that name only, unsettled, no waiting", async () => {
  const h = await setup(learned(["check", "gate"]));
  const e = (await h.poll(0)).prs[KEY];
  assert.equal(e.snap.learn, "pre-merge");
  assert.deepEqual(e.snap.expect, { missing: ["gate"] });
  assert.equal(e.unsettled, true);
  assert.equal(e.waiting, undefined);
  const later = (await h.poll(11 * MIN)).prs[KEY];
  assert.equal(later.unsettled, true, "past the settle hold and the bound: still unsettled");
  assert.deepEqual(later.snap.expect, { missing: ["gate"], overdue: true });
});

test("case 2: required [check, gate, late] with learn.ran [check, late]: only late stays in the facts", async () => {
  const h = await setup(learned(["check", "late"], 2));
  h.world.row = row({ required: ["check", "gate", "late"] });
  const e = (await h.poll(0)).prs[KEY];
  assert.equal(e.snap.learn, "pre-merge");
  assert.deepEqual(e.snap.expect, { missing: ["late"] });
  assert.equal(e.unsettled, true);
});

test("case 3: no learn in the answer: no `learn` in the snap, the facts stay, unsettled during the hold, then waiting and no unsettled", async () => {
  const h = await setup({ names: ["check"] });
  const first = (await h.poll(0)).prs[KEY];
  assert.equal(first.snap.learn, undefined);
  assert.deepEqual(first.snap.expect, { missing: ["gate"] });
  assert.equal(first.unsettled, true);
  assert.equal(first.waiting, undefined);
  assert.equal((await h.poll(30_000)).prs[KEY].unsettled, true);
  const later = (await h.poll(90_000)).prs[KEY];
  assert.equal(later.unsettled, undefined);
  assert.deepEqual(later.waiting, ["gate"]);
  assert.deepEqual(later.snap.expect, { missing: ["gate"] });
  assert.equal(later.snap.learn, undefined);
});

test("case 3: an unreadable baseline answer, or no baseline field at all, is not learnable", async () => {
  for (const baseline of [{ error: true }, undefined] as (Row | undefined)[]) {
    const h = await setup(baseline);
    await h.poll(0);
    const later = (await h.poll(3 * MIN)).prs[KEY];
    assert.equal(later.snap.learn, undefined);
    assert.deepEqual(later.waiting, ["gate"]);
  }
});

test("a malformed `learn` is dropped from the answer and from the stored baseline: case 3", async () => {
  for (const learn of [{ ran: [1], merged: 3 }, { ran: ["check"], merged: 0 }, { ran: ["check"] }, "x", { ran: Array.from({ length: 201 }, (_, i) => `n${i}`), merged: 1 }]) {
    const h = await setup({ names: ["check"], learn });
    await h.poll(0);
    assert.equal(h.doc().baselines[BASE_KEY].learn, undefined, JSON.stringify(learn).slice(0, 40));
    assert.equal((await h.poll(3 * MIN)).prs[KEY].snap.learn, undefined);
  }
  const h = await setup(learned(["check"]));
  await h.poll(0);
  const d = h.doc();
  d.baselines[BASE_KEY].learn = { ran: "check", merged: 3 };
  fs.writeFileSync(trackedStateFile(h.agentDir), JSON.stringify(d));
  clearStoreCache();
  assert.equal((await h.poll(MIN)).prs[KEY].snap.learn, undefined, "a stored malformed learn is not learnable");
});

test("a stored learn is used on the next poll without a new question, and survives the poll that does not ask", async () => {
  const h = await setup(learned(["check"]));
  await h.poll(0);
  h.world.baseline = undefined;
  const e = (await h.poll(MIN)).prs[KEY];
  assert.equal(e.snap.learn, "merge-time");
  assert.deepEqual(h.doc().baselines[BASE_KEY].learn, { ran: ["check"], merged: 3 });
});

test("a failure with the gate missing leaves the entry without learn, facts or unsettled", async () => {
  const h = await setup(learned(["check"]));
  h.world.row = row({ runs: [run("check", "failed")] });
  const e = (await h.poll(0)).prs[KEY];
  assert.equal(e.unsettled, undefined);
  assert.equal(e.snap.learn, undefined);
  assert.equal(e.waiting, undefined);
});

test("a pending check is not waiting: no learn, unsettled", async () => {
  const h = await setup(learned(["check"]));
  h.world.row = row({ runs: [run("check", "pending")] });
  const e = (await h.poll(0)).prs[KEY];
  assert.equal(e.snap.learn, undefined);
  assert.equal(e.waiting, undefined);
});

test("store -> readStoreEntry -> watch: a case-1 entry reaches the delta and the label input as a pass; a malformed snap `learn` is dropped (case 3)", async () => {
  const h = await setup(learned(["check"]));
  await h.poll(0);
  const key = { host: "github.com", repo: "acme/app", n: 1 };
  const r = readStoreEntry(h.agentDir, key, h.clock.t, true);
  assert.equal(r.kind, "entry");
  if (r.kind !== "entry") return;
  assert.equal(r.snap.learn, "merge-time");
  const gate = { settleMs: 90_000, now: h.clock.t };
  const out = prDelta(baselineOf({ ...r.snap, runs: [{ id: "check", name: "check", bucket: "pending", url: "x" }], expect: undefined }), r.snap, false, undefined, "", undefined, true, gate);
  assert.deepEqual(out.delta?.events, ["checks finished: pass"]);
  assert.deepEqual(out.delta?.waiting, ["gate"]);
  assert.equal(checksOf(out.state, r.snap, h.clock.t, 90_000), "green");
  const d = h.doc();
  d.prs[KEY].snap.learn = "sometimes";
  fs.writeFileSync(trackedStateFile(h.agentDir), JSON.stringify(d));
  clearStoreCache();
  const bad = readStoreEntry(h.agentDir, key, h.clock.t, true);
  assert.equal(bad.kind === "entry" ? bad.snap.learn : "x", undefined);
});
