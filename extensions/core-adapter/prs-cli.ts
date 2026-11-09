// `foreman prs poll [--json]` (bin/foreman, .cmd, .ps1): the PR tracker's poll (docs/herdr.md#open-prs). herdr-app runs it per machine.
// One run: (1) the tracked step polls the PRs of tracked-prs.json with pr_batch (gh, github.com) and writes tracked-prs-state.json and
// tracked-prs-comments.json; merged and closed PRs are dropped from the list; (2) the search step calls refreshOpenPrs. `poll` never throws and exits 0.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadMergedConfig, get, pythonPathHint } from "./config.ts";
import type { Json, MergedConfig } from "./config.ts";
import { piAgentDir } from "./env.ts";
import { openPrsConfig, openPrsFile, realGh, refreshOpenPrs, MAX_BODY } from "./openprs.ts";
import type { OpenPrsConfig, RefreshResult } from "./openprs.ts";
import { NO_PYTHON_FIX, resolvePython } from "./python.ts";
import type { PythonResolution } from "./python.ts";
import { resolveGithubHosts } from "./prhost.ts";
import type { GithubHosts } from "./prhost.ts";
import { pollWatchBatch } from "./prwatch.ts";
import type { CommentEntry, RunOp, SourceStatus, WatchPoll } from "./prwatch.ts";
import { inScope, noAnswerRun, parsePrSources, runSource, sourceComments, sourceRuns } from "./prsources.ts";
import type { PrContext, SourceCfg, SourceResult } from "./prsources.ts";
import { openTrace } from "./trace.ts";
import { runSafeOp } from "./safeops.ts";
import type { SafeOpOutcome } from "./safeops.ts";
import { defaultSpawner } from "./spawn.ts";
import { ENDED_KEEP_MS, STATE_LOCK_STALE_MS, readTracked, storeKey, trackedCommentsFile, trackedStateFile, usableLine, withTrackedLock, writeTracked } from "./prstore.ts";
import type { CommentsDoc, StateDoc, StateEntry, StateMeta, TrackedPr } from "./prstore.ts";
import { dropLock, ownsLock, takeLock, writeAtomic } from "./statefile.ts";

const DEFAULT_HOSTS: GithubHosts = { hosts: ["github.com"] };
const SOURCE_CONCURRENCY = 4;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..", "..");

/** The tracked step is due when its last run is older than this (shorter than herdr's 30 s timer, so no run is skipped). */
const DUE_MS = 25_000;
const BATCH_PICK = 50;
const RUN_DEADLINE_MS = 4 * 60_000;
const OP_TIMEOUT_MS = 120_000;
const MAX_COMMENTS = 100;
export const DEADLINE = "deadline";

export const USAGE = "usage: foreman prs poll [--json]";

export interface PollResult {
  tracked: number;
  dropped: number;
  searched: boolean;
  skipped?: "off" | "not_due" | "busy" | "list_unreadable";
  error?: string;
}

export interface PollDeps {
  agentDir: string;
  pkgRoot: string;
  now(): number;
  /** Resolves Python for the given python.path (null: none); no workspace check. */
  resolve(configPath: string | null): Promise<PythonResolution>;
  loadConfig(python: string | null): Promise<MergedConfig>;
  /** The RunOp over safe_ops.py with config `{prHost:"gh"}`; `pr_comments` gets the top-level `repoless`. */
  runOp(python: string): RunOp;
  refresh(config: OpenPrsConfig, hosts?: GithubHosts): Promise<RefreshResult>;
  /** tools.prGithubHosts of the loaded config; absent: github.com only. */
  githubHosts?(config: Json): GithubHosts;
  deadlineMs?: number;
  /** Runs one PR source (prsources.ts runSource); absent: no source runs. */
  runSource?(cfg: SourceCfg, ctx: PrContext): Promise<SourceResult>;
  /** A trace emitter for the loaded config (`pr_source` events); absent: none. */
  trace?(config: Json): (rec: Record<string, unknown>) => void;
}

/** What the tracked step needs to run the configured PR sources. */
interface SourceEnv {
  cfgs: SourceCfg[];
  run: NonNullable<PollDeps["runSource"]>;
  trace: (rec: Record<string, unknown>) => void;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const msg = (err: unknown): string => String((err as Error)?.message ?? err).replace(/\s+/g, " ").trim().slice(0, 200);

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readState(agentDir: string): StateDoc | null {
  const j = readJson(trackedStateFile(agentDir));
  if (!isObj(j) || j.v !== 1 || !isObj(j.prs)) return null;
  const prs: Record<string, StateEntry> = {};
  for (const [k, e] of Object.entries(j.prs)) if (isObj(e) && validEntry(e)) prs[k] = e as unknown as StateEntry;
  return { v: 1, trackedAt: finite(j.trackedAt) ? j.trackedAt : 0, ...(j.off === true ? { off: true as const } : {}), prs };
}

const validEntry = (e: Record<string, unknown>): boolean => typeof e.repo === "string" && finite(e.number) && finite(e.at);

function readComments(agentDir: string): CommentsDoc {
  const j = readJson(trackedCommentsFile(agentDir));
  return isObj(j) && j.v === 1 && isObj(j.prs) ? { v: 1, prs: j.prs as CommentsDoc["prs"] } : { v: 1, prs: {} };
}

const cap = (c: CommentEntry): CommentEntry => ({ ...c, ...(typeof c.body === "string" ? { body: c.body.slice(0, MAX_BODY) } : {}) });

/** Take the state lock once and run `fn`; null when busy. */
function withStateLock<T>(agentDir: string, now: number, fn: (token: string, lock: string) => T): { value: T } | null {
  const lock = `${trackedStateFile(agentDir)}.lock`;
  const token = takeLock(lock, now, STATE_LOCK_STALE_MS);
  if (!token) return null;
  try {
    return { value: fn(token, lock) };
  } finally {
    dropLock(lock, token);
  }
}

function setOff(agentDir: string, now: number, off: boolean): void {
  try {
    withStateLock(agentDir, now, () => {
      const st = readState(agentDir) ?? { v: 1 as const, trackedAt: 0, prs: {} };
      if ((st.off === true) === off) return;
      const next: StateDoc = { v: 1, trackedAt: st.trackedAt, prs: st.prs, ...(off ? { off: true as const } : {}) };
      writeAtomic(trackedStateFile(agentDir), next);
    });
  } catch {
    // busy or unwritable: the next run retries
  }
}

const hostOkOf = (config: Json): boolean => {
  const h = get(config, "tools.prHost") ?? "auto";
  return h === "auto" || h === "gh";
};

/** A run of the poll CLI. Never throws. */
export async function pollPrs(deps: PollDeps): Promise<PollResult> {
  const res: PollResult = { tracked: 0, dropped: 0, searched: false };
  try {
    const hint = pythonPathHint(deps.pkgRoot, deps.agentDir);
    let py = await deps.resolve(hint);
    const config = await deps.loadConfig(py.ok ? py.info.executable : null);
    if (config.safetyFallback) return { ...res, error: `config load failed: ${config.errors[0] ?? "safety fallback"}` };
    const merged = get(config.config, "python.path");
    if (typeof merged === "string" && merged.trim() && merged !== hint) py = await deps.resolve(merged);
    const oc = openPrsConfig(get(config.config, "radar.openPrs"));
    if (!oc.enabled || !hostOkOf(config.config)) {
      setOff(deps.agentDir, deps.now(), true);
      return { ...res, skipped: "off" };
    }
    setOff(deps.agentDir, deps.now(), false);
    const hosts = deps.githubHosts ? deps.githubHosts(config.config) : DEFAULT_HOSTS;
    if ("error" in hosts) res.error = hosts.error;
    else if (!py.ok) res.error = `no Python >= 3.13 found (${py.rejected.join("; ") || "none tried"}). ${NO_PYTHON_FIX}`;
    else {
      try {
        const ps = parsePrSources(get(config.config, "tools.prSources"));
        if (ps.errors.length > 0) res.error ??= ps.errors[0];
        const sx: SourceEnv = { cfgs: ps.sources, run: deps.runSource ?? (async () => ({ outcome: "program_missing", error: "no runner", checks: [], comments: [] })), trace: deps.trace?.(config.config) ?? (() => undefined) };
        if (!deps.runSource) sx.cfgs = [];
        await trackedStep(deps, py.info.executable, res, hosts.hosts, sx);
      } catch (err) {
        res.error = msg(err);
      }
    }
    try {
      res.searched = (await deps.refresh(oc, hosts)) === "refreshed";
    } catch (err) {
      res.error ??= msg(err);
    }
  } catch (err) {
    res.error = msg(err);
  }
  return res;
}

async function trackedStep(deps: PollDeps, python: string, res: PollResult, hosts: string[], sx: SourceEnv): Promise<void> {
  const { agentDir } = deps;
  const start = deps.now();
  const pre = readState(agentDir);
  const listed = readTracked(agentDir);
  if (listed.kind !== "bad") {
    const newest = listed.kind === "ok" ? Math.max(0, ...listed.lines.map((l) => usableLine(l)?.addedAt ?? 0)) : 0;
    if (pre && start - pre.trackedAt <= DUE_MS && newest <= pre.trackedAt) {
      res.skipped = "not_due";
      return;
    }
  }
  const lock = `${trackedStateFile(agentDir)}.lock`;
  const token = takeLock(lock, deps.now(), STATE_LOCK_STALE_MS);
  if (!token) {
    res.skipped = "busy";
    return;
  }
  try {
    await locked_step(deps, python, res, lock, token, hosts, sx);
  } finally {
    dropLock(lock, token);
  }
}

async function locked_step(deps: PollDeps, python: string, res: PollResult, lock: string, token: string, hosts: string[], sx: SourceEnv): Promise<void> {
  const { agentDir } = deps;
  const t0 = deps.now();
  const state = readState(agentDir) ?? { v: 1 as const, trackedAt: 0, prs: {} };
  const listed = readTracked(agentDir);
  if (listed.kind === "bad") {
    res.skipped = "list_unreadable";
    if (ownsLock(lock, token)) writeAtomic(trackedStateFile(agentDir), { v: 1, trackedAt: t0, prs: state.prs });
    return;
  }
  const lines = listed.kind === "ok" ? listed.lines : [];
  const seenKeys = new Set<string>();
  const usable: TrackedPr[] = [];
  let unlisted = false;
  for (const l of lines) {
    const u = usableLine(l);
    if (!u) continue;
    if (!hosts.includes(u.host ?? "github.com")) {
      unlisted = true;
      continue;
    }
    const k = storeKey(u.repo, u.number, u.host);
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    usable.push(u);
  }
  if (unlisted) res.error ??= `tracked PRs on a host outside tools.prGithubHosts are skipped (${hosts.join(", ")})`;
  const comments = readComments(agentDir);
  // Prune: keys no longer in the list, except ended entries younger than ENDED_KEEP_MS.
  const prs: Record<string, StateEntry> = {};
  for (const [k, e] of Object.entries(state.prs)) {
    const ended = finite(e.endedAt) && t0 - e.endedAt < ENDED_KEEP_MS;
    if (seenKeys.has(k) || ended) prs[k] = e;
  }
  const cprs: CommentsDoc["prs"] = {};
  for (const [k, c] of Object.entries(comments.prs)) if (seenKeys.has(k) && prs[k]?.endedAt === undefined) cprs[k] = c;

  const pick = [...usable]
    .sort((a, b) => {
      const ea = prs[storeKey(a.repo, a.number, a.host)];
      const eb = prs[storeKey(b.repo, b.number, b.host)];
      if (!ea !== !eb) return ea ? 1 : -1;
      return (ea?.at ?? 0) - (eb?.at ?? 0);
    })
    .slice(0, BATCH_PICK);

  const rows = new Map<string, { row: Record<string, unknown>; startedAt: number }>();
  const deadline = t0 + (deps.deadlineMs ?? RUN_DEADLINE_MS);
  const inner = deps.runOp(python);
  const run: RunOp = async (op, args) => {
    if (deps.now() > deadline) return { kind: "error", message: DEADLINE } as SafeOpOutcome;
    const startedAt = deps.now();
    const out = await inner(op, args);
    if (op === "pr_batch" && out.kind === "ran" && Array.isArray(out.result.prs)) {
      const host = typeof args.host === "string" ? args.host.toLowerCase() : "github.com";
      for (const r of out.result.prs) if (isObj(r)) rows.set(rowKey(host, String(r.repo), String(r.number)), { row: r, startedAt });
    }
    return out;
  };

  const items = pick.map((p) => ({ key: { host: p.host ?? "github.com", repo: p.repo, n: p.number }, seen: { updatedAt: String(cprs[storeKey(p.repo, p.number, p.host)]?.updatedAt ?? "") } }));
  const polls: WatchPoll[] = items.length ? await pollWatchBatch(run, items) : [];
  const drop = new Set<string>();
  const now = deps.now();
  const newComments: CommentsDoc["prs"] = { ...cprs };
  pick.forEach((p, i) => {
    const k = storeKey(p.repo, p.number, p.host);
    const rk = rowKey(p.host ?? "github.com", p.repo, String(p.number));
    const r = polls[i];
    const prev = prs[k];
    if ("snap" in r) {
      const { comments: fetched, ...snap } = r.snap;
      if (snap.state !== "open") {
        prs[k] = { repo: p.repo, number: p.number, snap, okAt: rows.get(rk)?.startedAt ?? now, endedAt: prev?.endedAt ?? now, at: now };
        delete newComments[k];
        drop.add(k);
        return;
      }
      const row = rows.get(rk);
      const meta = row ? metaOf(row.row) : prev?.meta;
      prs[k] = { repo: p.repo, number: p.number, snap, ...(meta ? { meta } : {}), okAt: row?.startedAt ?? now, at: now };
      if (fetched) newComments[k] = { updatedAt: snap.updatedAt, comments: fetched.slice(0, MAX_COMMENTS).map(cap) };
    } else if ("error" in r && r.error === DEADLINE) {
      // keeps its entry and its turn
    } else {
      const base: StateEntry = prev ?? { repo: p.repo, number: p.number, at: now };
      const { gone: _g, ...rest } = base;
      prs[k] = { ...rest, error: "error" in r ? r.error.replace(/\s+/g, " ").slice(0, 300) : "the pull request was not found", errorAt: now, ...("gone" in r ? { gone: true as const } : {}), at: now };
    }
  });
  res.tracked = items.length;
  const commentsBefore = JSON.stringify(comments.prs); // sourceStep edits shared comment objects in place
  await sourceStep(deps, sx, pick, polls, state.prs, prs, newComments, deadline);

  if (!ownsLock(lock, token)) return; // another run took the lock over: discard
  if (JSON.stringify(newComments) !== commentsBefore) writeAtomic(trackedCommentsFile(agentDir), { v: 1, prs: newComments });
  writeAtomic(trackedStateFile(agentDir), { v: 1, trackedAt: t0, prs });
  if (drop.size) {
    const done = await withTrackedLock(agentDir, () => {
      const cur = readTracked(agentDir);
      if (cur.kind !== "ok") return 0;
      const keep = cur.lines.filter((l) => {
        const u = usableLine(l);
        return !(u && drop.has(storeKey(u.repo, u.number, u.host)));
      });
      if (keep.length === cur.lines.length) return 0;
      writeTracked(agentDir, keep);
      return cur.lines.length - keep.length;
    }, deps.now);
    res.dropped = done?.value ?? 0;
  }
}

/**
 * Run the configured sources for every open PR whose GitHub poll succeeded and merge their answers into `prs` (runs after GitHub's, `sources`) and
 * `newComments` (`sources`). PRs whose oldest source answer is oldest go first (never-run first); a source not started before the deadline is skipped
 * and keeps its previous `at`. A PR without a successful poll is left alone, previous `sources` included. `before`: the entries as of the last run.
 */
async function sourceStep(deps: PollDeps, sx: SourceEnv, pick: TrackedPr[], polls: WatchPoll[], before: Record<string, StateEntry>, prs: Record<string, StateEntry>, newComments: CommentsDoc["prs"], deadline: number): Promise<void> {
  if (sx.cfgs.length === 0) {
    // no source configured: nothing of an earlier run stays
    for (const [k, e] of Object.entries(prs)) if (e.sources) delete e.sources;
    for (const c of Object.values(newComments)) if (c.sources) delete c.sources;
    return;
  }
  interface Job {
    k: string;
    p: TrackedPr;
    snapHead: string;
    base: string;
    scope: SourceCfg[];
    oldest: number;
    results: Map<string, { r: SourceResult | null; at: number; ms: number }>;
  }
  const jobs: Job[] = [];
  pick.forEach((p, i) => {
    const r = polls[i];
    if (!r || !("snap" in r) || r.snap.state !== "open") return;
    const k = storeKey(p.repo, p.number, p.host);
    const scope = sx.cfgs.filter((c) => inScope(c, p.repo));
    jobs.push({ k, p, snapHead: r.snap.head, base: r.snap.base, scope, oldest: scope.length ? Math.min(...scope.map((c) => before[k]?.sources?.[c.name]?.at ?? 0)) : 0, results: new Map() });
  });
  jobs.sort((a, b) => a.oldest - b.oldest);
  const tasks: { job: Job; cfg: SourceCfg }[] = jobs.flatMap((job) => job.scope.map((cfg) => ({ job, cfg })));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const t = tasks[next++];
      if (!t) return;
      const prevAt = before[t.job.k]?.sources?.[t.cfg.name]?.at ?? 0;
      if (deps.now() > deadline) {
        t.job.results.set(t.cfg.name, { r: null, at: prevAt, ms: 0 });
        sx.trace({ event: "pr_source", source: t.cfg.name, outcome: "deadline" });
        continue;
      }
      const t0 = deps.now();
      let r: SourceResult;
      try {
        r = await sx.run(t.cfg, { host: t.job.p.host ?? "github.com", repo: t.job.p.repo, number: t.job.p.number, head: t.job.snapHead, base: t.job.base });
      } catch (err) {
        r = { outcome: "failed", error: msg(err), checks: [], comments: [] };
      }
      const done = deps.now();
      t.job.results.set(t.cfg.name, { r, at: done, ms: Math.max(0, done - t0) });
      sx.trace({ event: "pr_source", source: t.cfg.name, outcome: r.outcome, ms: Math.max(0, done - t0) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(SOURCE_CONCURRENCY, tasks.length) }, worker));

  for (const job of jobs) {
    const entry = prs[job.k];
    if (!entry?.snap) continue;
    const runs = [...entry.snap.runs];
    const sources: Record<string, SourceStatus> = {};
    const cs: NonNullable<CommentsDoc["prs"][string]["sources"]> = {};
    for (const cfg of job.scope) {
      const got = job.results.get(cfg.name);
      const ok = got?.r?.outcome === "ok";
      if (ok && got?.r) {
        runs.push(...sourceRuns(cfg, job.snapHead, got.r.checks));
        if (got.r.comments.length > 0) cs[cfg.name] = { head: job.snapHead, comments: sourceComments(cfg, got.r.comments) };
      } else if (cfg.gates) runs.push(noAnswerRun(cfg));
      sources[cfg.name] = { head: job.snapHead, gates: cfg.gates, ok, ...(ok ? {} : { error: got?.r?.error ?? DEADLINE }), at: got?.at ?? 0 };
    }
    entry.snap = { ...entry.snap, runs };
    if (Object.keys(sources).length > 0) entry.sources = sources;
    else delete entry.sources;
    const c = newComments[job.k] ?? { updatedAt: "", comments: [] };
    const { sources: _old, ...rest } = c;
    if (Object.keys(cs).length > 0) newComments[job.k] = { ...rest, sources: cs };
    else if (newComments[job.k]) newComments[job.k] = rest;
  }
  // an entry whose PR was not source-run keeps its sources only if it still has a source in config
  for (const [k, e] of Object.entries(prs)) {
    if (!e.sources) continue;
    for (const name of Object.keys(e.sources)) if (!sx.cfgs.some((c) => c.name === name && inScope(c, e.repo))) delete e.sources[name];
    if (Object.keys(e.sources).length === 0) delete e.sources;
    const c = newComments[k];
    if (c?.sources) {
      for (const name of Object.keys(c.sources)) if (!sx.cfgs.some((cfg) => cfg.name === name && inScope(cfg, e.repo))) delete c.sources[name];
      if (Object.keys(c.sources).length === 0) delete c.sources;
    }
  }
}

/** Key of a pr_batch row: the same `o/r#n` on two hosts keeps its own row. */
const rowKey = (host: string, repo: string, n: string): string => `${host}|${repo.toLowerCase()}#${n}`;

function metaOf(row: Record<string, unknown>): StateMeta {
  const s = (v: unknown, n: number): string => (typeof v === "string" ? v.slice(0, n) : "");
  return { url: s(row.url, 2048), title: s(row.title, 300), draft: row.draft === true, headRefName: s(row.headRefName, 200), headRepo: s(row.headRepo, 140) };
}

export function realDeps(env: NodeJS.ProcessEnv = process.env): PollDeps {
  const agentDir = piAgentDir(env, env.HOME ?? env.USERPROFILE ?? "");
  const spawner = defaultSpawner;
  const penv = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string"));
  return {
    agentDir,
    pkgRoot: PKG_ROOT,
    now: Date.now,
    resolve: (configPath) => resolvePython({ configPath, envPath: env.PI_FOREMAN_PYTHON, platform: process.platform, spawner }),
    loadConfig: (python) => loadMergedConfig({ python, pkgRoot: PKG_ROOT, agentDir, projectDir: agentDir, trusted: false, spawner }),
    runOp: (python) => (op, args) =>
      runSafeOp({ python, script: path.join(PKG_ROOT, "scripts", "safe_ops.py"), op, args, cwd: agentDir, config: { prHost: "gh" }, env: penv, spawner, timeoutMs: OP_TIMEOUT_MS, repoless: true }),
    refresh: (config, hosts) => refreshOpenPrs({ file: openPrsFile(agentDir), config, gh: realGh(agentDir, env), ...(hosts ? { hosts } : {}) }),
    githubHosts: resolveGithubHosts,
    runSource: (cfg, ctx) => runSource(cfg, ctx, { stateDir: path.join(agentDir, "pi-foreman", "state"), env, platform: process.platform }),
    trace: (config) => {
      const w = openTrace({ enabled: get(config, "trace.enabled"), dir: get(config, "trace.dir"), stateDir: path.join(agentDir, "pi-foreman", "state"), sessionId: "pr-tracker" });
      return (rec) => w?.emit(rec);
    },
  };
}

export function line(r: PollResult): string {
  return `prs poll: tracked ${r.tracked}, dropped ${r.dropped}, searched ${r.searched ? "yes" : "no"}${r.skipped ? `, skipped ${r.skipped}` : ""}${r.error ? `, error ${r.error}` : ""}`;
}

/** The CLI: argv after `prs`. Returns the exit code. */
export async function main(argv: string[], out: (s: string) => void, err: (s: string) => void, deps: () => PollDeps = realDeps): Promise<number> {
  if (argv[0] !== "poll" || argv.slice(1).some((a) => a !== "--json")) {
    err(`${USAGE}\n`);
    return 2;
  }
  const r = await pollPrs(deps());
  const { tracked, dropped, searched, skipped, error } = r;
  out(argv.includes("--json") ? `${JSON.stringify({ tracked, dropped, searched, ...(skipped ? { skipped } : {}), ...(error ? { error } : {}) })}\n` : `${line(r)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), (s) => process.stdout.write(s), (s) => process.stderr.write(s));
}
