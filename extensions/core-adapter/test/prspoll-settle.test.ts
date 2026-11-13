import { test } from "node:test";
import assert from "node:assert/strict";
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
const KEY = "acme/app#1";

type Row = Record<string, unknown>;
const run = (name: string, bucket: string): Row => ({ id: name, name, bucket, url: "x" });
const row = (o: Row = {}): Row => ({ repo: "acme/app", number: 1, state: "open", mergeable: "mergeable", headSha: "h1", baseRef: "main", updatedAt: "u1", url: "https://github.com/acme/app/pull/1", title: "t", draft: false, headRefName: "feat", headRepo: "acme/app", runs: [run("ci", "passed")], ...o });

async function setup(config: Record<string, unknown> = {}) {
  clearStoreCache();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-prsettle-"));
  const clock = { t: T0 };
  const world: { row: Row } = { row: row() };
  const deps: PollDeps = {
    agentDir,
    pkgRoot: PKG,
    now: () => clock.t,
    resolve: async (p) => ({ ok: true, info: { executable: p ?? "/py", version: [3, 13], source: "test" }, rejected: [] }),
    loadConfig: async () => ({ config, warnings: [], errors: [], safetyFallback: false, roles: {}, source: "cli" }) as MergedConfig,
    runOp: () => async (op) => (op === "pr_batch" ? ({ kind: "ran", result: { prs: [world.row], errors: [] } } as SafeOpOutcome) : ({ kind: "ran", result: { comments: [] } } as SafeOpOutcome)),
    refresh: async () => "refreshed",
  };
  await addTracked(agentDir, "acme/app", 1, () => T0 - 1000);
  const poll = async (advanceMs: number) => {
    clock.t += advanceMs;
    await pollPrs(deps);
    return JSON.parse(fs.readFileSync(trackedStateFile(agentDir), "utf8")).prs[KEY];
  };
  return { poll, world, stateFile: () => trackedStateFile(agentDir) };
}

const STEP = 30_000; // past the poll's due time

test("one passed run on a fresh head: the entry is flagged unsettled", async () => {
  const h = await setup();
  assert.equal((await h.poll(0)).unsettled, true);
});

test("the same head after the settle hold (default 90 s): not flagged", async () => {
  const h = await setup();
  await h.poll(0);
  assert.equal((await h.poll(STEP)).unsettled, true);
  assert.equal((await h.poll(STEP * 3)).unsettled, undefined);
});

test("tools.prSettleSeconds sets the hold", async () => {
  const h = await setup({ tools: { prSettleSeconds: 40 } });
  assert.equal((await h.poll(0)).unsettled, true);
  assert.equal((await h.poll(STEP)).unsettled, true);
  assert.equal((await h.poll(STEP)).unsettled, undefined);
});

test("settle time 0: no hold", async () => {
  const h = await setup({ tools: { prSettleSeconds: 0 } });
  assert.equal((await h.poll(0)).unsettled, undefined);
});

test("a complete required set is settled at once", async () => {
  const h = await setup();
  h.world.row = row({ required: ["ci"] });
  assert.equal((await h.poll(0)).unsettled, undefined);
});

test("a required check without a run is unsettled, even past the hold", async () => {
  const h = await setup();
  h.world.row = row({ required: ["ci", "lint"] });
  await h.poll(0);
  assert.equal((await h.poll(STEP * 10)).unsettled, true);
});

test("a failed run is not flagged and the failure stays in the snap", async () => {
  const h = await setup();
  h.world.row = row({ runs: [run("ci", "passed"), run("lint", "failed")] });
  const e = await h.poll(0);
  assert.equal(e.unsettled, undefined);
  assert.equal(e.snap.runs.some((r: Row) => r.bucket === "failed"), true);
});

test("a head change restarts the hold", async () => {
  const h = await setup();
  await h.poll(0);
  assert.equal((await h.poll(STEP * 4)).unsettled, undefined);
  h.world.row = row({ headSha: "h2" });
  assert.equal((await h.poll(STEP)).unsettled, true);
  assert.equal((await h.poll(STEP * 4)).unsettled, undefined);
});

test("a new check that passes after the first hold ran out restarts the hold", async () => {
  const h = await setup();
  await h.poll(0);
  assert.equal((await h.poll(STEP * 4)).unsettled, undefined);
  h.world.row = row({ runs: [run("ci", "passed"), run("lint", "passed")] });
  assert.equal((await h.poll(STEP)).unsettled, true);
  assert.equal((await h.poll(STEP * 4)).unsettled, undefined);
});

test("a failed run clears the flag at once, inside the hold", async () => {
  const h = await setup();
  assert.equal((await h.poll(0)).unsettled, true);
  h.world.row = row({ runs: [run("ci", "passed"), run("lint", "failed")] });
  assert.equal((await h.poll(STEP)).unsettled, undefined);
});

test("a stored entry without passSince and unsettled still reads and polls", async () => {
  const h = await setup();
  await h.poll(0);
  const file = h.stateFile();
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  delete doc.prs[KEY].passSince;
  delete doc.prs[KEY].unsettled;
  fs.writeFileSync(file, JSON.stringify(doc));
  clearStoreCache();
  const e = await h.poll(STEP);
  assert.equal(e.snap.head, "h1");
  assert.equal(e.unsettled, true);
  assert.equal(typeof e.passSince.at, "number");
});
