// D201 at tracker level (prs-cli.ts expectSteps): a phase-rule edit between two polls drops a frozen expected name, and the entry leaves the expected-check veto
// (`unsettled`, `snap.expect`) the pill shows as "CI running"; a name the rules still expect stays.
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
type Row = Record<string, unknown>;
const run = (name: string, bucket: string): Row => ({ id: name, name, bucket, url: "x", expected: true });
const row: Row = { repo: "acme/app", number: 1, state: "open", mergeable: "mergeable", headSha: "h1", baseRef: "main", updatedAt: "u1", url: "https://github.com/acme/app/pull/1", title: "t", draft: false, headRefName: "feat", headRepo: "acme/app", required: null, runs: [run("quick", "passed")] };

async function setup() {
  clearStoreCache();
  const agentDir = trackedTmp("pf-prexpect-rules-");
  const clock = { t: T0 };
  const phases = { v: undefined as unknown };
  const deps: PollDeps = {
    agentDir,
    pkgRoot: PKG,
    now: () => clock.t,
    resolve: async (p) => ({ ok: true, info: { executable: p ?? "/py", version: [3, 13], source: "test" }, rejected: [] }),
    loadConfig: async () => ({ config: phases.v === undefined ? {} : { tools: { prPhases: phases.v } }, warnings: [], errors: [], safetyFallback: false, roles: {}, source: "cli" }) as MergedConfig,
    runOp: () => async (op, args) => {
      if (op !== "pr_batch") return { kind: "ran", result: { comments: [] } } as SafeOpOutcome;
      const prs = (args.prs as { baseline?: boolean }[]).map((e) => (e.baseline ? { ...row, baseline: { names: ["quick", "ci"] } } : row));
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
  return { poll, phases };
}

test("a rule edit that no longer expects a frozen name drops it on the next poll and the veto goes", async () => {
  const h = await setup();
  const first = await h.poll();
  assert.deepEqual(first.snap.expect.missing, ["ci"]);
  assert.equal(first.unsettled, true);
  h.phases.v = [{ ignore: ["ci"] }];
  const second = await h.poll();
  assert.equal(second.snap.expect, undefined, "no expected name left");
  assert.equal(second.unsettled, undefined, "the pill leaves CI running");
});

test("a rule edit that leaves the name expected keeps the veto", async () => {
  const h = await setup();
  await h.poll();
  h.phases.v = [{ ignore: ["other"] }];
  const second = await h.poll();
  assert.deepEqual(second.snap.expect.missing, ["ci"]);
  assert.equal(second.unsettled, true);
});
