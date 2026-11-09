import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pollPrs } from "../prs-cli.ts";
import type { PollDeps } from "../prs-cli.ts";
import { runSource } from "../prsources.ts";
import type { PrContext, SourceCfg, SourceResult } from "../prsources.ts";
import { addTracked, clearStoreCache, readStoreEntry, storeKey, trackedCommentsFile, trackedStateFile } from "../prstore.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import type { MergedConfig } from "../config.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIX = path.join(PKG, "tests", "fixtures", "fake_pr_source.mjs");
const T0 = 50_000_000;

type Row = Record<string, unknown>;
const row = (repo: string, n: number, o: Row = {}): Row => ({ repo, number: n, state: "open", mergeable: "mergeable", headSha: "abc", baseRef: "main", updatedAt: "u1", url: `https://github.com/${repo}/pull/${n}`, title: `t${n}`, draft: false, headRefName: "feat", headRepo: repo, runs: [{ id: "1", name: "ci", bucket: "passed", url: "x" }], ...o });

function setup(over: { sources?: Record<string, unknown>; mode?: string; tick?: number; deadlineMs?: number; batchAdvance?: number } = {}) {
  clearStoreCache();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-prsrc-"));
  const rows = new Map<string, Row | "error">();
  const clock = { t: T0 };
  const ran: string[] = [];
  const traces: Record<string, unknown>[] = [];
  const mode = { v: over.mode ?? "ok" };
  const sources = { current: over.sources ?? { ci: { command: `${process.execPath} ${FIX} {head}` } } };
  const deps: PollDeps = {
    agentDir,
    pkgRoot: PKG,
    now: () => (clock.t += over.tick ?? 0),
    resolve: async (p) => ({ ok: true, info: { executable: p ?? "/py", version: [3, 13], source: "test" }, rejected: [] }),
    loadConfig: async () => ({ config: { tools: { prSources: sources.current } }, warnings: [], errors: [], safetyFallback: false, roles: {}, source: "cli" }) as MergedConfig,
    runOp: () => async (op, args) => {
      if (op === "pr_batch") {
        const prs: Row[] = [];
        const errors: Row[] = [];
        for (const p of args.prs as { repo: string; n: number }[]) {
          const r = rows.get(storeKey(p.repo, p.n));
          if (!r || r === "error") errors.push({ repo: p.repo, number: p.n, kind: "host_error" });
          else prs.push(r);
        }
        return { kind: "ran", result: { prs, errors } } as SafeOpOutcome;
      }
      clock.t += over.batchAdvance ?? 0; // the comment fetch is the last GitHub step before the sources
      return { kind: "ran", result: { comments: [] } } as SafeOpOutcome;
    },
    refresh: async () => "refreshed",
    runSource: async (cfg: SourceCfg, ctx: PrContext): Promise<SourceResult> => {
      ran.push(`${ctx.repo}#${ctx.number}:${cfg.name}`);
      return runSource({ ...cfg, argv: [process.execPath, FIX, mode.v] }, ctx, { stateDir: path.join(agentDir, "pi-foreman", "state"), env: process.env, platform: process.platform });
    },
    trace: () => (r) => void traces.push(r),
    ...(over.deadlineMs !== undefined ? { deadlineMs: over.deadlineMs } : {}),
  };
  return { deps, agentDir, rows, clock, ran, traces, mode, sources };
}
const state = (dir: string) => JSON.parse(fs.readFileSync(trackedStateFile(dir), "utf8"));
const comments = (dir: string) => JSON.parse(fs.readFileSync(trackedCommentsFile(dir), "utf8"));
const K = { host: "github.com", repo: "acme/app", n: 1 };

test("a source answer lands in runs, sources and comments, and survives readStoreEntry", async () => {
  const h = setup();
  await addTracked(h.agentDir, "acme/app", 1, () => T0 - 1000);
  h.rows.set("acme/app#1", row("acme/app", 1, { headSha: "abc123" }));
  await pollPrs(h.deps);
  const e = state(h.agentDir).prs["acme/app#1"];
  assert.deepEqual(e.snap.runs.map((r: { name: string }) => r.name), ["ci", "ci/deploy"]);
  assert.equal(e.snap.runs[1].source, "ci");
  assert.equal(e.snap.runs[1].bucket, "failed");
  assert.equal(e.sources.ci.ok, true);
  assert.equal(e.sources.ci.head, "abc123");
  assert.equal(e.sources.ci.gates, true);
  const c = comments(h.agentDir).prs["acme/app#1"];
  assert.equal(c.sources.ci.head, "abc123");
  assert.equal(c.sources.ci.comments[0].id, "ci:c1");
  assert.equal(c.sources.ci.comments[0].bot, true);
  const read = readStoreEntry(h.agentDir, K, h.clock.t, true);
  assert.equal(read.kind, "entry");
  if (read.kind === "entry") {
    assert.equal(read.snap.runs[1].source, "ci");
    assert.equal(read.snap.sources?.ci.ok, true);
    assert.equal(read.snap.comments?.some((x) => x.id === "ci:c1" && x.source === "ci" && x.bot === true), true);
  }
  assert.ok(h.traces.some((t) => t.event === "pr_source" && t.outcome === "ok" && t.source === "ci"));
  assert.ok(h.traces.every((t) => !("number" in t)));
  // head mismatch: the source comments are dropped at read time
  const st = state(h.agentDir);
  st.prs["acme/app#1"].snap.head = "zzz999";
  fs.writeFileSync(trackedStateFile(h.agentDir), JSON.stringify(st));
  clearStoreCache();
  const read2 = readStoreEntry(h.agentDir, K, h.clock.t, true);
  assert.equal(read2.kind === "entry" && (read2.snap.comments ?? []).some((x) => x.source === "ci"), false);
});

test("failures: error recorded, no checks stored, a gating source holds a no-answer run", async () => {
  const h = setup({ mode: "fail" });
  await addTracked(h.agentDir, "acme/app", 1, () => T0 - 1000);
  h.rows.set("acme/app#1", row("acme/app", 1));
  await pollPrs(h.deps);
  const e = state(h.agentDir).prs["acme/app#1"];
  assert.equal(e.sources.ci.ok, false);
  assert.match(e.sources.ci.error, /^boom/);
  assert.equal(e.snap.runs.some((r: { noAnswer?: boolean }) => r.noAnswer), true);
  assert.equal(comments(h.agentDir).prs["acme/app#1"].sources, undefined);
  assert.ok(h.traces.some((t) => t.outcome === "failed"));
  // a source that does not gate adds nothing when it has no answer
  const g = setup({ mode: "fail", sources: { ci: { command: "x", gates: false } } });
  await addTracked(g.agentDir, "acme/app", 1, () => T0 - 1000);
  g.rows.set("acme/app#1", row("acme/app", 1));
  await pollPrs(g.deps);
  assert.equal(state(g.agentDir).prs["acme/app#1"].snap.runs.length, 1);
});

test("a removed source leaves nothing; a source out of repo scope does not run", async () => {
  const h = setup();
  await addTracked(h.agentDir, "acme/app", 1, () => T0 - 1000);
  h.rows.set("acme/app#1", row("acme/app", 1));
  await pollPrs(h.deps);
  h.clock.t += 60_000;
  h.sources.current = {};
  await pollPrs(h.deps);
  const e = state(h.agentDir).prs["acme/app#1"];
  assert.equal(e.sources, undefined);
  assert.deepEqual(e.snap.runs.map((r: { name: string }) => r.name), ["ci"]);
  assert.equal(comments(h.agentDir).prs["acme/app#1"].sources, undefined);
  h.sources.current = { ci: { command: "x", repos: ["other/*"] } };
  h.ran.length = 0;
  h.clock.t += 60_000;
  await pollPrs(h.deps);
  assert.deepEqual(h.ran, []);
});

test("a GitHub poll error runs no source and keeps the previous sources", async () => {
  const h = setup();
  await addTracked(h.agentDir, "acme/app", 1, () => T0 - 1000);
  h.rows.set("acme/app#1", row("acme/app", 1));
  await pollPrs(h.deps);
  const before = state(h.agentDir).prs["acme/app#1"].sources;
  h.ran.length = 0;
  h.rows.set("acme/app#1", "error");
  h.clock.t += 60_000;
  await pollPrs(h.deps);
  assert.deepEqual(h.ran, []);
  assert.deepEqual(state(h.agentDir).prs["acme/app#1"].sources, before);
});

test("the PR whose source ran longest ago goes first; past the deadline the rest is skipped and keeps its at", async () => {
  const h = setup();
  for (const n of [1, 2]) {
    await addTracked(h.agentDir, "acme/app", n, () => T0 - 1000);
    h.rows.set(`acme/app#${n}`, row("acme/app", n));
  }
  await pollPrs(h.deps);
  const st = state(h.agentDir);
  st.prs["acme/app#2"].sources.ci.at = 1;
  fs.writeFileSync(trackedStateFile(h.agentDir), JSON.stringify(st));
  h.ran.length = 0;
  h.clock.t += 60_000;
  await pollPrs(h.deps);
  assert.equal(h.ran[0], "acme/app#2:ci");
  // deadline already passed: nothing runs, at unchanged, outcome deadline traced
  const d = setup({ deadlineMs: 1000, batchAdvance: 5000 });
  await addTracked(d.agentDir, "acme/app", 1, () => T0 - 1000);
  d.rows.set("acme/app#1", row("acme/app", 1));
  await pollPrs(d.deps);
  const s0 = state(d.agentDir);
  s0.prs["acme/app#1"].sources = { ci: { head: "abc", gates: true, ok: true, at: 777 } };
  fs.writeFileSync(trackedStateFile(d.agentDir), JSON.stringify(s0));
  d.ran.length = 0;
  d.traces.length = 0;
  d.rows.set("acme/app#1", row("acme/app", 1, { updatedAt: "u2" })); // a changed PR makes the comment fetch run, which spends the deadline
  d.clock.t += 60_000;
  await pollPrs(d.deps);
  assert.deepEqual(d.ran, []);
  assert.ok(d.traces.some((t) => t.outcome === "deadline"));
  const e = state(d.agentDir).prs["acme/app#1"];
  assert.deepEqual(e.sources.ci, { head: "abc", gates: true, ok: false, error: "deadline", at: 777 });
  const na = e.snap.runs.find((r: { noAnswer?: boolean }) => r.noAnswer);
  assert.equal(na?.id, "ci:(no answer)");
  assert.equal(na?.bucket, "pending");
});
