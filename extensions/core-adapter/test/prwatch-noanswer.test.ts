import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pollPrs } from "../prs-cli.ts";
import type { PollDeps } from "../prs-cli.ts";
import { parseWire, runSource, sourceRuns } from "../prsources.ts";
import type { PrContext, SourceCfg, SourceResult } from "../prsources.ts";
import { addTracked, clearStoreCache, readStoreEntry, storeKey } from "../prstore.ts";
import { baselineOf, prDelta } from "../prwatch.ts";
import type { WatchSnapshot } from "../prwatch.ts";
import { DEFAULT_RULES } from "../prwake.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import type { MergedConfig } from "../config.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIX = path.join(PKG, "tests", "fixtures", "fake_pr_source.mjs");
const T0 = 50_000_000;
const K = { host: "github.com", repo: "acme/app", n: 1 };
const REPO = "acme/app";

const ghRow = { repo: REPO, number: 1, state: "open", mergeable: "mergeable", headSha: "abc123", baseRef: "main", updatedAt: "u1", url: `https://github.com/${REPO}/pull/1`, title: "t", draft: false, headRefName: "feat", headRepo: REPO, runs: [{ id: "1", name: "ci", bucket: "passed", url: "x" }] };

/** A tracker over one gating source whose answer mode the test switches; the store is read back through readStoreEntry. */
function harness() {
  clearStoreCache();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-noans-"));
  const clock = { t: T0 };
  const mode = { v: "pass" };
  const deps: PollDeps = {
    agentDir,
    pkgRoot: PKG,
    now: () => clock.t,
    resolve: async (p) => ({ ok: true, info: { executable: p ?? "/py", version: [3, 13], source: "test" }, rejected: [] }),
    loadConfig: async () => ({ config: { tools: { prSources: { ci: { command: `${process.execPath} ${FIX} {head}` } } } }, warnings: [], errors: [], safetyFallback: false, roles: {}, source: "cli" }) as MergedConfig,
    runOp: () => async (op, args) => {
      if (op === "pr_batch") return { kind: "ran", result: { prs: (args.prs as unknown[]).map(() => ghRow), errors: [] } } as SafeOpOutcome;
      return { kind: "ran", result: { comments: [] } } as SafeOpOutcome;
    },
    refresh: async () => "refreshed",
    runSource: async (cfg: SourceCfg, ctx: PrContext): Promise<SourceResult> =>
      runSource({ ...cfg, argv: [process.execPath, FIX, mode.v] }, ctx, { stateDir: path.join(agentDir, "pi-foreman", "state"), env: process.env, platform: process.platform }),
    trace: () => () => {},
  };
  const poll = async (m: string): Promise<WatchSnapshot> => {
    mode.v = m;
    clock.t += 60_000;
    await pollPrs(deps);
    clearStoreCache();
    const r = readStoreEntry(agentDir, K, clock.t, true);
    assert.equal(r.kind, "entry");
    if (r.kind !== "entry") throw new Error("no entry");
    return r.snap;
  };
  return { agentDir, poll, add: () => addTracked(agentDir, REPO, 1, () => T0 - 1000) };
}

test("a (no answer) run read back from the store holds back checks finished and ready to merge", async () => {
  const h = harness();
  await h.add();
  const pending = await h.poll("pending");
  const noAns = await h.poll("fail");
  assert.equal(noAns.runs.some((r) => r.noAnswer === true), true, "noAnswer survives the store");
  const base = baselineOf(pending);
  const out = prDelta(base, noAns, true, DEFAULT_RULES, REPO);
  assert.equal(out.delta, null);
  const passed = await h.poll("pass");
  const done = prDelta(out.state, passed, true, DEFAULT_RULES, REPO);
  assert.ok(done.delta);
  assert.ok(done.delta.events.includes("checks finished: pass"));
  assert.equal(done.delta.ready, true);
});

test("a (no answer) run does not reset the recorded ci: pass, skipped round, pass sends nothing", async () => {
  const h = harness();
  await h.add();
  const pending = await h.poll("pending");
  const first = await h.poll("pass");
  const reported = prDelta(baselineOf(pending), first, true, DEFAULT_RULES, REPO);
  assert.ok(reported.delta?.events.includes("checks finished: pass"));
  const base = reported.state;
  assert.notEqual(base.ci, "");
  const gap = await h.poll("fail");
  assert.equal(gap.runs.some((r) => r.noAnswer === true), true);
  const mid = prDelta(base, gap, true, DEFAULT_RULES, REPO);
  assert.equal(mid.delta, null);
  assert.equal(mid.state.ci, base.ci);
  const again = await h.poll("pass");
  assert.equal(prDelta(mid.state, again, true, DEFAULT_RULES, REPO).delta, null);
});

test("reordering duplicate-named checks between polls does not replay a failure", () => {
  const cfg: SourceCfg = { name: "ci", argv: ["x"], repos: null, timeoutMs: 1000, gates: true };
  const runsOf = (checks: string): ReturnType<typeof sourceRuns> => sourceRuns(cfg, "abc123def456abc", parseWire(checks)!.checks);
  const a = JSON.stringify({ checks: [{ name: "t", status: "failed" }, { name: "t", status: "passed" }, { name: "u", status: "failed" }] });
  const b = JSON.stringify({ checks: [{ name: "u", status: "failed" }, { name: "t", status: "passed" }, { name: "t", status: "failed" }] });
  const snap = (runs: ReturnType<typeof sourceRuns>): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: "abc123def456abc", base: "main", updatedAt: "t", runs });
  const first = prDelta(baselineOf(snap([])), snap(runsOf(a)), false, DEFAULT_RULES, REPO);
  assert.ok(first.delta);
  assert.equal(prDelta(first.state, snap(runsOf(b)), false, DEFAULT_RULES, REPO).delta, null);
});

test("runSource called with the process cwd at the filesystem root finds the source program through PATH", async () => {
  const cwd = process.cwd();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-noans-state-"));
  const cfg: SourceCfg = { name: "ci", argv: [path.parse(process.execPath).name, FIX, "pass"], repos: null, timeoutMs: 20_000, gates: true };
  const ctx: PrContext = { host: "github.com", repo: REPO, number: 1, head: "abc123", base: "main" };
  process.chdir(path.parse(cwd).root);
  try {
    const r = await runSource(cfg, ctx, { stateDir, env: { PATH: path.dirname(process.execPath) }, platform: process.platform });
    assert.equal(r.outcome, "ok");
    assert.equal(r.checks[0]?.name, "deploy");
  } finally {
    process.chdir(cwd);
  }
});
