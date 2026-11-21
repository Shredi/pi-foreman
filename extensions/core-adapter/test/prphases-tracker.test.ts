// tools.prPhases in the tracker (prs-cli.ts pollPrs): gate and not-counted runs are tagged in the stored snap, the required list loses their names, and the stored
// snap carries `gate`, `gated` and `ruled`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pollPrs } from "../prs-cli.ts";
import type { PollDeps } from "../prs-cli.ts";
import { addTracked, clearStoreCache, parseSnap, trackedStateFile } from "../prstore.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import type { MergedConfig } from "../config.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const T0 = 50_000_000;
type Row = Record<string, unknown>;
const run = (name: string, bucket: string): Row => ({ id: name, name, bucket, url: "x", expected: true });
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

test("the stored snap: gate and not-counted runs tagged, required stripped, gate state and flags set; the required gate name with no run is waiting", async () => {
  const h = await setup([{ gate: ["deploy", "release"], ignore: ["review-*"] }], row({ required: ["build", "deploy", "release"], runs: [run("build", "passed"), run("deploy", "pending"), run("review-x", "failed")] }));
  const e = await h.poll();
  const byName = Object.fromEntries(e.snap.runs.map((r: Row) => [r.name, r]));
  assert.equal(byName.build.phase, undefined);
  assert.equal(byName.deploy.phase, 2);
  assert.equal(byName.deploy.gates, false);
  assert.equal(byName["review-x"].phase, "ignore");
  assert.deepEqual(e.snap.required, ["build"]);
  assert.deepEqual(e.snap.gate, { state: "running", waiting: ["release"] });
  assert.equal(e.snap.gated, true);
  assert.equal(e.snap.ruled, true);
  const back = parseSnap(e.snap);
  assert.equal(back?.gated, true);
  assert.deepEqual(back?.gate, { state: "running", waiting: ["release"] });
  assert.equal(back?.runs.find((r) => r.name === "deploy")?.phase, 2);
});

test("a failed gate check leaves phase 1 alone: the unsettled hold does not apply and no phase-1 run is failed", async () => {
  const h = await setup([{ gate: ["deploy"] }], row({ required: ["build", "deploy"], runs: [run("build", "passed"), run("deploy", "failed")] }));
  const e = await h.poll();
  assert.equal(e.unsettled, undefined);
  assert.equal(e.snap.gate.state, "failed");
  assert.equal(e.snap.runs.filter((r: Row) => r.bucket === "failed" && r.phase === undefined).length, 0);
});

test("no rule for the repository: the snap is as the host gave it", async () => {
  const h = await setup([{ repos: ["other/*"], gate: ["deploy"] }], row({ required: ["build", "deploy"], runs: [run("build", "passed"), run("deploy", "pending")] }));
  const e = await h.poll();
  assert.equal(e.snap.gate, undefined);
  assert.equal(e.snap.gated, undefined);
  assert.equal(e.snap.runs[1].phase, undefined);
  assert.deepEqual(e.snap.required, ["build", "deploy"]);
});
