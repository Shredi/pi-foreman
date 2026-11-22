// tools.prPhases in the tracker, second part: the settle verdict with gate and not-counted runs (D119, D101++, D101+), against the stored entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pollPrs } from "../prs-cli.ts";
import type { PollDeps } from "../prs-cli.ts";
import { addTracked, clearStoreCache, trackedStateFile } from "../prstore.ts";
import { settledOf } from "../prwatch.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import type { MergedConfig } from "../config.ts";
import { trackedTmp } from "./_tmpbase.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const T0 = 50_000_000;
const KEY = "acme/app#1";
type Row = Record<string, unknown>;
const run = (name: string, bucket: string): Row => ({ id: name, name, bucket, url: "x", expected: true });
const row = (o: Row = {}): Row => ({ repo: "acme/app", number: 1, state: "open", mergeable: "mergeable", headSha: "h1", baseRef: "main", updatedAt: "u1", url: "https://github.com/acme/app/pull/1", title: "t", draft: false, headRefName: "feat", headRepo: "acme/app", ...o });

async function setup(phases: unknown, r: Row, baseline?: Row, source?: { status: string }) {
  clearStoreCache();
  const agentDir = trackedTmp("pf-prphases2-");
  const clock = { t: T0 };
  const deps: PollDeps = {
    agentDir,
    pkgRoot: PKG,
    now: () => clock.t,
    resolve: async (p) => ({ ok: true, info: { executable: p ?? "/py", version: [3, 13], source: "test" }, rejected: [] }),
    loadConfig: async () => ({ config: { tools: { prPhases: phases, ...(source ? { prSources: { ext: { command: "x" } } } : {}) } }, warnings: [], errors: [], safetyFallback: false, roles: {}, source: "cli" }) as MergedConfig,
    runOp: () => async (op, args) => {
      if (op !== "pr_batch") return { kind: "ran", result: { comments: [] } } as SafeOpOutcome;
      const prs = (args.prs as { baseline?: boolean }[]).map((e) => (e.baseline && baseline ? { ...r, baseline } : r));
      return { kind: "ran", result: { prs, errors: [] } } as SafeOpOutcome;
    },
    refresh: async () => "refreshed",
    ...(source ? { runSource: async () => ({ outcome: "ok" as const, checks: [{ id: "1", name: "scan", status: source.status as "pending", url: "x" }], comments: [] }) } : {}),
  };
  await addTracked(agentDir, "acme/app", 1, () => T0 - 1000);
  const poll = async (advance = 100_000) => {
    clock.t += advance;
    await pollPrs(deps);
    return JSON.parse(fs.readFileSync(trackedStateFile(agentDir), "utf8")).prs[KEY];
  };
  return { poll };
}

const verdict = (e: { snap: { runs: never[]; required?: string[] } }) => settledOf(e.snap.runs, e.snap.required).result;

test("a failing not-counted check with phase 1 green: pass, no unsettled", async () => {
  const h = await setup([{ ignore: ["review-*"] }], row({ runs: [run("build", "passed"), run("review-assign", "failed")] }));
  await h.poll(); // the first poll holds a bare pass for the settle time; the verdict is the second
  const e = await h.poll();
  assert.equal(verdict(e), "pass");
  assert.equal(e.unsettled, undefined);
  assert.equal(e.snap.runs.find((r: Row) => r.name === "review-assign").phase, "ignore");
});

test("merged history ran the gate check before its merge: pass, the gate is waiting, no veto", async () => {
  const h = await setup([{ gate: ["ci/gate"] }], row({ required: ["build", "ci/gate"], runs: [run("build", "passed")] }), { names: ["build", "ci/gate"], learn: { ran: ["build", "ci/gate"], merged: 3 } });
  const e = await h.poll();
  assert.equal(verdict(e), "pass");
  assert.equal(e.unsettled, undefined);
  assert.deepEqual(e.snap.gate, { state: "waiting", waiting: ["ci/gate"] });
  assert.equal(e.snap.expect, undefined, "the gate name is not an expected check");
  assert.deepEqual(e.snap.required, ["build"]);
});

test("a new base with an empty baseline and a required gate name missing: pass after the hold", async () => {
  const h = await setup([{ gate: ["ci/gate"] }], row({ required: ["build", "ci/gate"], runs: [run("build", "passed")] }), { names: [] });
  let e = await h.poll(0);
  e = await h.poll(100_000);
  e = await h.poll(100_000);
  assert.equal(verdict(e), "pass");
  assert.equal(e.unsettled, undefined);
  assert.equal(e.snap.expect, undefined);
  assert.deepEqual(e.snap.gate, { state: "waiting", waiting: ["ci/gate"] });
});

test("a pending gate run with phase 1 green: pass, no unsettled, gate running", async () => {
  const h = await setup([{ gate: ["ci/gate"] }], row({ required: ["build", "ci/gate"], runs: [run("build", "passed"), run("ci/gate", "pending")] }));
  const e = await h.poll();
  assert.equal(verdict(e), "pass");
  assert.equal(e.unsettled, undefined);
  assert.equal(e.snap.gate.state, "running");
});

test("a pending not-counted run with phase 1 green: no unsettled", async () => {
  const h = await setup([{ ignore: ["review-*"] }], row({ runs: [run("build", "passed"), run("review-assign", "pending")] }));
  await h.poll();
  const e = await h.poll();
  assert.equal(verdict(e), "pass");
  assert.equal(e.unsettled, undefined);
  const counted = await setup([{ ignore: ["other-*"] }], row({ runs: [run("build", "passed"), run("review-assign", "pending")] }));
  await counted.poll();
  assert.equal((await counted.poll()).unsettled, true, "control: the same run counted keeps the PR unsettled");
});

test("a pending not-counted source run: no unsettled", async () => {
  const h = await setup([{ ignore: ["ext/*"] }], row({ runs: [run("build", "passed")] }), undefined, { status: "pending" });
  await h.poll();
  const e = await h.poll();
  const src = e.snap.runs.find((r: Row) => r.name === "ext/scan");
  assert.equal(src.bucket, "pending");
  assert.equal(src.phase, "ignore");
  assert.equal(e.unsettled, undefined);
});
