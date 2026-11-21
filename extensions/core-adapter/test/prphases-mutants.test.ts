// tools.prPhases mutant killers: the no-phase-1 label rule in the watch and the gate filters in the tracker.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pollPrs } from "../prs-cli.ts";
import type { PollDeps } from "../prs-cli.ts";
import { addTracked, clearStoreCache, trackedStateFile } from "../prstore.ts";
import { settledOf } from "../prwatch.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import type { MergedConfig } from "../config.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const T0 = 50_000_000;
const KEY = "acme/app#1";
type Row = Record<string, unknown>;
const run = (name: string, bucket: string): Row => ({ id: name, name, bucket, url: "x", expected: true });
const row = (o: Row = {}): Row => ({ repo: "acme/app", number: 1, state: "open", mergeable: "mergeable", headSha: "h1", baseRef: "main", updatedAt: "u1", url: "https://github.com/acme/app/pull/1", title: "t", draft: false, headRefName: "feat", headRepo: "acme/app", ...o });

async function setup(phases: unknown, r: Row, baseline?: Row, source?: { status: string }) {
  clearStoreCache();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-prphases2-"));
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

test("gate name in the baseline, no required list: not an expected check, no unsettled, pass after the hold", async () => {
  const h = await setup([{ gate: ["ci/gate"] }], row({ runs: [run("build", "passed")] }), { names: ["build", "ci/gate"] });
  const first = await h.poll();
  assert.equal(first.unsettled, true, "the first poll is held");
  const e = await h.poll();
  assert.equal(verdict(e), "pass");
  assert.equal(e.unsettled, undefined);
  assert.ok(!(e.snap.expect?.missing ?? []).includes("ci/gate"));
  assert.equal(e.snap.expect, undefined);
});

test("only a passed gate run, no phase-1 run: not unsettled", async () => {
  const h = await setup([{ gate: ["ci/gate"] }], row({ runs: [run("ci/gate", "passed")] }));
  await h.poll();
  const e = await h.poll();
  assert.equal(e.unsettled, undefined);
});

test("a pending gate run with phase 1 passed, no required list: no unsettled after the hold; the failed gate keeps the pass verdict", async () => {
  const h = await setup([{ gate: ["ci/gate"] }], row({ runs: [run("build", "passed"), run("ci/gate", "pending")] }));
  await h.poll();
  const e = await h.poll();
  assert.equal(verdict(e), "pass");
  assert.equal(e.unsettled, undefined);
  const f = await setup([{ gate: ["ci/gate"] }], row({ runs: [run("build", "passed"), run("ci/gate", "failed")] }));
  await f.poll();
  const g = await f.poll();
  assert.equal(verdict(g), "pass");
  assert.equal(g.unsettled, undefined);
});
