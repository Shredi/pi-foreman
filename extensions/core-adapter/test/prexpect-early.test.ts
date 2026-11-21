// The early pass (the PR watch must not report a check result before the host has reported the checks): the required list is unreadable, only the quick
// check finished and the baseline of recent merged pull requests names more checks. Through the tracker poll, the stored entry and the watch.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pollPrs } from "../prs-cli.ts";
import type { PollDeps } from "../prs-cli.ts";
import { addTracked, clearStoreCache, readStoreEntry, trackedStateFile } from "../prstore.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import type { MergedConfig } from "../config.ts";
import { baselineOf, prDelta } from "../prwatch.ts";
import { trackedTmp } from "./_tmpbase.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const T0 = 50_000_000;
const KEY = "acme/app#1";
const STEP = 30_000;

type Row = Record<string, unknown>;
const run = (name: string, bucket: string): Row => ({ id: name, name, bucket, url: "x", expected: true });
const row = (o: Row = {}): Row => ({ repo: "acme/app", number: 1, state: "open", mergeable: "mergeable", headSha: "h1", baseRef: "main", updatedAt: "u1", url: "https://github.com/acme/app/pull/1", title: "t", draft: false, headRefName: "feat", headRepo: "acme/app", required: null, runs: [run("quick", "passed")], baseline: { names: ["quick", "ci-build", "ci-test"] }, ...o });

async function setup() {
  clearStoreCache();
  const agentDir = trackedTmp("pf-prexpect-");
  const clock = { t: T0 };
  const world: { row: Row } = { row: row() };
  const deps: PollDeps = {
    agentDir,
    pkgRoot: PKG,
    now: () => clock.t,
    resolve: async (p) => ({ ok: true, info: { executable: p ?? "/py", version: [3, 13], source: "test" }, rejected: [] }),
    loadConfig: async () => ({ config: {}, warnings: [], errors: [], safetyFallback: false, roles: {}, source: "cli" }) as MergedConfig,
    runOp: () => async (op) => (op === "pr_batch" ? ({ kind: "ran", result: { prs: [world.row], errors: [] } } as SafeOpOutcome) : ({ kind: "ran", result: { comments: [] } } as SafeOpOutcome)),
    refresh: async () => "refreshed",
  };
  await addTracked(agentDir, "acme/app", 1, () => T0 - 1000);
  const poll = async (advanceMs: number) => {
    clock.t += advanceMs;
    await pollPrs(deps);
    return JSON.parse(fs.readFileSync(trackedStateFile(agentDir), "utf8")).prs[KEY];
  };
  return { poll, world, agentDir, clock };
}

test("early pass: unreadable required list, one quick check done, past the settle time: no pass anywhere", async () => {
  const h = await setup();
  assert.equal((await h.poll(0)).unsettled, true);
  // well past the default settle time of 90 s, nothing else reported
  const e = await h.poll(STEP * 10);
  assert.equal(e.unsettled, true, "the tracker entry stays unsettled");
  assert.deepEqual(e.snap.expect.missing.sort(), ["ci-build", "ci-test"]);
  const read = readStoreEntry(h.agentDir, { host: "github.com", repo: "acme/app", n: 1 }, h.clock.t, true);
  assert.equal(read.kind, "entry");
  if (read.kind !== "entry") return;
  const first = prDelta(baselineOf(read.snap), read.snap, true, undefined, "", undefined, true, { settleMs: 90_000, now: h.clock.t });
  assert.equal(first.delta, null, "no checks finished: pass, no ready line");
  const later = prDelta(first.state, read.snap, true, undefined, "", undefined, true, { settleMs: 90_000, now: h.clock.t + 10 * 60_000 });
  assert.equal(later.delta?.events.some((x) => x.startsWith("checks finished")) ?? false, false);
  assert.equal(later.delta?.events.includes("ready to merge") ?? false, false);
});
