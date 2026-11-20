// `foreman prs poll [--json]` (bin/foreman, .cmd, .ps1): the PR tracker's poll (docs/herdr.md#open-prs). herdr-app runs it per machine.
// One run: (1) the tracked step polls the PRs of tracked-prs.json with pr_batch (gh, github.com) and writes tracked-prs-state.json and
// tracked-prs-comments.json; merged and closed PRs are dropped from the list; (2) the search step calls refreshOpenPrs. `poll` never throws and exits 0.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadMergedConfig, get, pythonPathHint } from "./config.ts";
import type { Json, MergedConfig } from "./config.ts";
import { piAgentDir } from "./env.ts";
import { clearOpenPrs, hiddenRepo, openPrsConfig, openPrsFile, realGh, refreshOpenPrs, remarkOpenPrs, MAX_BODY } from "./openprs.ts";
import type { OpenPrsConfig, RefreshResult } from "./openprs.ts";
import { NO_PYTHON_FIX, resolvePython } from "./python.ts";
import type { PythonResolution } from "./python.ts";
import { resolveGithubHosts } from "./prhost.ts";
import type { GithubHosts } from "./prhost.ts";
import { expectStep, holdPass, oneLine, pollWatchBatch, settleMsOf, settledOf, waitingOf } from "./prwatch.ts";
import type { CommentEntry, RunOp, SourceStatus, WatchPoll } from "./prwatch.ts";
import { parsePhases, phaseOf, phasesStep } from "./prphases.ts";
import type { PhaseRule } from "./prphases.ts";
import { inScope, noAnswerRun, parsePrSources, runSource, sourceComments, sourceRuns } from "./prsources.ts";
import type { PrContext, SourceCfg, SourceResult } from "./prsources.ts";
import { openTrace } from "./trace.ts";
import { runSafeOp } from "./safeops.ts";
import type { SafeOpOutcome } from "./safeops.ts";
import { defaultSpawner } from "./spawn.ts";
import { ENDED_KEEP_MS, STATE_LOCK_STALE_MS, readTracked, storeKey, trackedCommentsFile, trackedStateFile, usableLine, withTrackedLock, writeTracked } from "./prstore.ts";
import type { BaselineEntry, CommentsDoc, StateDoc, StateEntry, StateMeta, StoredSnap, TrackedPr } from "./prstore.ts";
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
/** A stored baseline of the expected checks is asked again when it is older than this; one older than a day is dropped. */
const BASELINE_TTL_MS = 10 * 60_000;
const BASELINE_KEEP_MS = 24 * 3_600_000;
const MAX_BASELINE = 100;
/** The learning list of a baseline (`ran`): pr_ops.py omits `learn` when it would hold more names than this. */
const MAX_LEARN = 200;
export const DEADLINE = "deadline";

export const USAGE = "usage: foreman prs poll [--json]";

export interface PollResult {
  tracked: number;
  dropped: number;
  searched: boolean;
  /** Search entries dropped from open-prs.json by this poll (the search or the feature is off); absent when none. */
  cleared?: number;
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
  refresh(config: OpenPrsConfig, hosts?: GithubHosts, phases?: readonly PhaseRule[]): Promise<RefreshResult>;
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
  /** tools.prSettleSeconds in ms (the PR watch's key and default): how long a pass without a required-check set is held. */
  settleMs: number;
  cfgs: SourceCfg[];
  /** tools.prPhases (prphases.ts): the gate and not-counted checks per repository. */
  phases: PhaseRule[];
  /** radar.openPrs.hideRepos: entries of these repositories are marked `hiddenRepo`. */
  hide: string[];
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
  for (const [k, e] of Object.entries(j.prs)) {
    if (!isObj(e) || !validEntry(e)) continue;
    // a malformed `exp` would make every poll of the head throw: drop it, the entry is then treated like one from before the facts
    if (e.exp !== undefined && !validExp(e.exp)) delete e.exp;
    prs[k] = e as unknown as StateEntry;
  }
  const baselines: Record<string, BaselineEntry> = {};
  if (isObj(j.baselines))
    for (const [k, b] of Object.entries(j.baselines)) if (isObj(b) && finite(b.at) && Array.isArray(b.names)) baselines[k] = { names: b.names.filter((n): n is string => typeof n === "string").slice(0, MAX_BASELINE), at: b.at, ...learnOf(b.learn) };
  return { v: 1, trackedAt: finite(j.trackedAt) ? j.trackedAt : 0, ...(j.off === true ? { off: true as const } : {}), prs, ...(Object.keys(baselines).length ? { baselines } : {}), ...(finite(j.hostlessDroppedAt) ? { hostlessDroppedAt: j.hostlessDroppedAt } : {}) };
}

/** `{learn}` of a baseline answer when it is well formed (`ran` a string list of at most MAX_LEARN names, `merged` a whole number of at least 1); else `{}` (the base is not learnable). */
const learnOf = (v: unknown): { learn?: { ran: string[]; merged: number } } =>
  isObj(v) && Array.isArray(v.ran) && v.ran.length <= MAX_LEARN && v.ran.every((n) => typeof n === "string") && finite(v.merged) && Number.isInteger(v.merged) && v.merged >= 1 ? { learn: { ran: v.ran as string[], merged: v.merged } } : {};

const validEntry = (e: Record<string, unknown>): boolean => typeof e.repo === "string" && finite(e.number) && finite(e.at);

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= MAX_BASELINE && v.every((n) => typeof n === "string");
const validExp = (x: unknown): boolean => isObj(x) && typeof x.head === "string" && strings(x.prev) && (x.names === undefined || strings(x.names)) && finite(x.since) && typeof x.sig === "string" && typeof x.draft === "boolean";

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

/** Every entry gets `hiddenRepo: true` when its repo matches `globs` and loses it otherwise. */
function markHidden(prs: Record<string, StateEntry>, globs: string[]): void {
  for (const e of Object.values(prs)) {
    if (hiddenRepo(globs, e.repo)) e.hiddenRepo = true;
    else delete e.hiddenRepo;
  }
}

function setOff(agentDir: string, now: number, off: boolean): void {
  try {
    withStateLock(agentDir, now, () => {
      const st = readState(agentDir) ?? { v: 1 as const, trackedAt: 0, prs: {} };
      if ((st.off === true) === off) return;
      const next: StateDoc = { v: 1, trackedAt: st.trackedAt, prs: st.prs, ...(st.baselines ? { baselines: st.baselines } : {}), ...(st.hostlessDroppedAt !== undefined ? { hostlessDroppedAt: st.hostlessDroppedAt } : {}), ...(off ? { off: true as const } : {}) };
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
      const dropped = clearOpenPrs(openPrsFile(deps.agentDir), deps.now());
      return { ...res, skipped: "off", ...(dropped > 0 ? { cleared: dropped } : {}) };
    }
    setOff(deps.agentDir, deps.now(), false);
    const hosts = deps.githubHosts ? deps.githubHosts(config.config) : DEFAULT_HOSTS;
    if ("error" in hosts) res.error = hosts.error;
    else if (!py.ok) res.error = `no Python >= 3.13 found (${py.rejected.join("; ") || "none tried"}). ${NO_PYTHON_FIX}`;
    if (oc.hideError) res.error ??= oc.hideError;
    const phases = parsePhases(get(config.config, "tools.prPhases"));
    if (phases.errors.length > 0) res.error ??= phases.errors[0];
    if (!("error" in hosts) && py.ok) {
      try {
        const ps = parsePrSources(get(config.config, "tools.prSources"));
        if (ps.errors.length > 0) res.error ??= ps.errors[0];
        const settle = get(config.config, "tools.prSettleSeconds");
        const sx: SourceEnv = { settleMs: settleMsOf(settle), cfgs: ps.sources, phases: phases.rules, hide: oc.hideRepos, run: deps.runSource ?? (async () => ({ outcome: "program_missing", error: "no runner", checks: [], comments: [] })), trace: deps.trace?.(config.config) ?? (() => undefined) };
        if (!deps.runSource) sx.cfgs = [];
        await trackedStep(deps, py.info.executable, res, hosts.hosts, sx);
      } catch (err) {
        res.error = msg(err);
      }
    }
    try {
      const refreshed = await deps.refresh(oc, hosts, phases.rules);
      res.searched = refreshed === "refreshed";
      if (refreshed === "off") {
        const dropped = clearOpenPrs(openPrsFile(deps.agentDir), deps.now());
        if (dropped > 0) res.cleared = dropped;
      }
    } catch (err) {
      res.error ??= msg(err);
    }
    remarkOpenPrs(openPrsFile(deps.agentDir), oc.hideRepos, deps.now());
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
  let listed = readTracked(agentDir);
  if (listed.kind === "bad") {
    res.skipped = "list_unreadable";
    markHidden(state.prs, sx.hide);
    if (ownsLock(lock, token)) writeAtomic(trackedStateFile(agentDir), { v: 1, trackedAt: t0, prs: state.prs, ...(state.baselines ? { baselines: state.baselines } : {}), ...(state.hostlessDroppedAt !== undefined ? { hostlessDroppedAt: state.hostlessDroppedAt } : {}) });
    return;
  }
  // once, with more than one host configured: the lines without a `host` field go (they were polled as github.com, and an older default may have put them on the wrong host);
  // the marker is written with the state, so a line a session on older code adds later stays
  let hostlessDroppedAt = state.hostlessDroppedAt;
  if (hosts.length > 1 && hostlessDroppedAt === undefined) {
    const done = await withTrackedLock(agentDir, () => {
      const cur = readTracked(agentDir);
      if (cur.kind !== "ok") return 0;
      const keep = cur.lines.filter((l) => !(usableLine(l) && isObj(l) && l.host === undefined));
      if (keep.length === cur.lines.length) return 0;
      writeTracked(agentDir, keep);
      return cur.lines.length - keep.length;
    }, deps.now);
    if (done) {
      hostlessDroppedAt = t0;
      if (done.value > 0) {
        const note = `removed ${done.value} tracked PR line${done.value === 1 ? "" : "s"} without a host (several hosts are configured); follow ${done.value === 1 ? "it" : "them"} again`;
        res.error = res.error ? `${res.error}; ${note}` : note;
      }
      listed = readTracked(agentDir);
      if (listed.kind === "bad") return;
    }
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
  // the baseline of the expected checks (design/pr-ops.md): one flagged entry per repository and base, only when the stored one is missing or old
  const baselines: Record<string, BaselineEntry> = {};
  for (const [bk, b] of Object.entries(state.baselines ?? {})) if (t0 - b.at < BASELINE_KEEP_MS) baselines[bk] = b;
  const flagged = flagBaselines(pick, prs, baselines, t0);
  const run: RunOp = async (op, args) => {
    if (deps.now() > deadline) return { kind: "error", message: DEADLINE } as SafeOpOutcome;
    const startedAt = deps.now();
    const host = typeof args.host === "string" ? args.host.toLowerCase() : "github.com";
    const sent = op === "pr_batch" && Array.isArray(args.prs) ? { ...args, prs: (args.prs as { repo: string; n: number }[]).map((e) => (flagged.has(rowKey(host, e.repo, String(e.n))) ? { ...e, baseline: true } : e)) } : args;
    const out = await inner(op, sent);
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
  // the host's required list as polled: the phase sort (prphases.ts) takes the gate and not-counted names out of the stored one, and sorts again after the source merge
  const rawRequired = new Map<string, string[] | null | undefined>();
  pick.forEach((p, i) => {
    const k = storeKey(p.repo, p.number, p.host);
    const rk = rowKey(p.host ?? "github.com", p.repo, String(p.number));
    const r = polls[i];
    const prev = prs[k];
    if ("snap" in r) {
      const { comments: fetched, ...polled } = r.snap;
      const snap: StoredSnap = polled.state === "open" ? { ...polled, ...phasesStep(sx.phases, p.repo, polled.runs, polled.required) } : polled;
      if (snap.state !== "open") {
        prs[k] = { repo: p.repo, number: p.number, snap, okAt: rows.get(rk)?.startedAt ?? now, endedAt: prev?.endedAt ?? now, at: now };
        delete newComments[k];
        drop.add(k);
        return;
      }
      rawRequired.set(k, polled.required);
      const row = rows.get(rk);
      const meta = row ? metaOf(row.row) : prev?.meta;
      const s = settledOf(snap.runs, snap.required);
      const hold = s.result === "pass" && sx.settleMs > 0 && !snap.required?.length ? holdPass(prev?.passSince, snap.head, snap.runs, now, sx.settleMs) : null;
      const held = hold?.held ?? false;
      // a PR whose only missing runs are required names is decided again after the baseline step (expectSteps: merge-time, pre-merge or not learnable)
      const unsettled = s.result !== "fail" && snap.runs.some((x) => x.bucket === "passed" && x.phase === undefined) && (!s.settled || held);
      prs[k] = { repo: p.repo, number: p.number, snap, ...(meta ? { meta } : {}), okAt: row?.startedAt ?? now, ...(hold ? { passSince: hold.since } : {}), ...(unsettled ? { unsettled: true as const } : {}), at: now };
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
  await sourceStep(deps, sx, pick, polls, state.prs, prs, newComments, deadline, (k, repo, snap) => ({ ...snap, ...phasesStep(sx.phases, repo, snap.runs, rawRequired.get(k)) }));
  expectSteps(pick, polls, rows, flagged, state.prs, prs, baselines, deps.now(), sx.settleMs, sx.phases);

  if (!ownsLock(lock, token)) return; // another run took the lock over: discard
  markHidden(prs, sx.hide);
  if (JSON.stringify(newComments) !== commentsBefore) writeAtomic(trackedCommentsFile(agentDir), { v: 1, prs: newComments });
  writeAtomic(trackedStateFile(agentDir), { v: 1, trackedAt: t0, prs, ...(Object.keys(baselines).length ? { baselines } : {}), ...(hostlessDroppedAt !== undefined ? { hostlessDroppedAt } : {}) });
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
async function sourceStep(deps: PollDeps, sx: SourceEnv, pick: TrackedPr[], polls: WatchPoll[], before: Record<string, StateEntry>, prs: Record<string, StateEntry>, newComments: CommentsDoc["prs"], deadline: number, reclass: (k: string, repo: string, snap: StoredSnap) => StoredSnap): Promise<void> {
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
    entry.snap = reclass(job.k, job.p.repo, { ...entry.snap, runs });
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

const baseKey = (host: string, repo: string, base: string): string => `${host}|${repo.toLowerCase()}|${base}`;

/**
 * The entries (row keys) whose pr_batch asks for the baseline: one per host, repository and base whose stored baseline is missing or older than 10 minutes. An entry whose
 * base is not known yet (no stored snap) is asked only when no other entry of its repository is, so a base never asked before is unknown on that poll and flagged on the next.
 */
function flagBaselines(pick: TrackedPr[], prs: Record<string, StateEntry>, baselines: Record<string, BaselineEntry>, now: number): Set<string> {
  const flagged = new Set<string>();
  const pairs = new Set<string>();
  const repos = new Set<string>();
  const unknown: TrackedPr[] = [];
  for (const p of pick) {
    const host = p.host ?? "github.com";
    const base = prs[storeKey(p.repo, p.number, p.host)]?.snap?.base;
    if (!base) {
      unknown.push(p);
      continue;
    }
    const b = baselines[baseKey(host, p.repo, base)];
    const pk = baseKey(host, p.repo, base);
    if ((b && now - b.at < BASELINE_TTL_MS) || pairs.has(pk)) continue;
    pairs.add(pk);
    repos.add(`${host}|${p.repo.toLowerCase()}`);
    flagged.add(rowKey(host, p.repo, String(p.number)));
  }
  for (const p of unknown) {
    const rk = `${p.host ?? "github.com"}|${p.repo.toLowerCase()}`;
    if (repos.has(rk)) continue;
    repos.add(rk);
    flagged.add(rowKey(p.host ?? "github.com", p.repo, String(p.number)));
  }
  return flagged;
}

/**
 * The expected-set step of every open PR polled this run (after the source merge): store the answered baselines, freeze each head's expected set, keep the facts in the snap
 * (only while they veto) and the state in the entry's `exp`, and mark the entry unsettled while expected checks are still to come and nothing failed.
 * A row without a `baseline` field is "not asked or not available" (an older answer, a host without the field, the fallback path): a known empty baseline.
 * An asked answer that failed carries `{error}`: unknown, asked again on the next poll, and the age of the stored one is not refreshed.
 */
function expectSteps(pick: TrackedPr[], polls: WatchPoll[], rows: Map<string, { row: Record<string, unknown>; startedAt: number }>, flagged: Set<string>, before: Record<string, StateEntry>, prs: Record<string, StateEntry>, baselines: Record<string, BaselineEntry>, now: number, settleMs: number, phases: readonly PhaseRule[]): void {
  // hosts whose flagged row came back without the field: the host does not have it (or the batch took the fallback path), so every other entry of that host with no stored
  // baseline counts as a known empty baseline in this poll too, not as unknown; a host that has the field answers every flagged row with it
  const none = new Set<string>();
  const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((n): n is string => typeof n === "string").slice(0, MAX_BASELINE) : []);
  for (const p of pick) {
    const host = p.host ?? "github.com";
    const rk = rowKey(host, p.repo, String(p.number));
    const hit = rows.get(rk);
    if (!hit || !flagged.has(rk)) continue;
    const b = hit.row.baseline;
    if (!isObj(b)) none.add(host);
    else if (Array.isArray(b.names) && typeof hit.row.baseRef === "string") baselines[baseKey(host, p.repo, hit.row.baseRef)] = { names: names(b.names), at: hit.startedAt, ...learnOf(b.learn) };
  }
  pick.forEach((p, i) => {
    const r = polls[i];
    if (!r || !("snap" in r) || r.snap.state !== "open") return;
    const k = storeKey(p.repo, p.number, p.host);
    const e = prs[k];
    if (!e?.snap) return;
    const host = p.host ?? "github.com";
    const rk = rowKey(host, p.repo, String(p.number));
    const row = rows.get(rk)?.row;
    const stored = row && typeof row.baseRef === "string" ? baselines[baseKey(host, p.repo, row.baseRef)] : undefined;
    // the gate and not-counted names are not expected checks of the next head (the stored baseline stays as the host gave it)
    const phaseOne = (ns: string[]): string[] => (phases.length > 0 ? ns.filter((n) => phaseOf(phases, p.repo, { name: n }) === 1) : ns);
    let baseline: { names: string[] } | null;
    if (!row) baseline = { names: [] };
    else if (isObj(row.baseline) && !Array.isArray(row.baseline.names)) baseline = stored ? { names: phaseOne(stored.names) } : null;
    else if (stored) baseline = { names: phaseOne(stored.names) };
    else baseline = flagged.has(rk) || none.has(host) ? { names: [] } : null;
    const old = before[k];
    const head = e.snap.head;
    const upgrade = !old?.exp && !!old?.snap && head !== "" && old.snap.head === head && settledOf(old.snap.runs, old.snap.required).result === "pass" && !old.unsettled;
    const { state, facts } = expectStep(old?.exp, { head, runs: e.snap.runs, required: e.snap.required, cut: e.snap.cut === true, draft: e.meta?.draft === true, ...(old?.snap && old.snap.head !== head ? { prevRuns: old.snap.runs } : {}), upgrade, baseline }, now);
    e.exp = state;
    const { expect: _drop, learn: _old, ...rest } = e.snap;
    const open = settledOf(e.snap.runs, e.snap.required).result !== "fail" && e.snap.runs.some((x) => x.bucket === "passed" && x.phase === undefined);
    // every gating run passed and only required names have no run: merge-time (the base's recent merged PRs ran none of the missing names before their merge), pre-merge (one of them did)
    // or not learnable (no complete answer); a source run merged in is counted, a failure is none of these (it is immediate)
    const waiting = waitingOf(e.snap.runs, e.snap.required);
    const ran = waiting.length > 0 && facts && !facts.unknown && stored?.learn ? phaseOne(stored.learn.ran) : undefined;
    const mergeTime = ran ? (e.snap.required ?? []).filter((n) => !ran.includes(n)) : [];
    if (ran && waiting.every((n) => mergeTime.includes(n))) {
      // case 1: the merge-time names do not veto; the pass stands at once and the names ride along
      e.snap = { ...rest, learn: "merge-time" };
      e.waiting = waiting.slice(0, 10).map((n) => oneLine(n, 120));
      delete e.unsettled;
    } else if (ran && facts) {
      // case 2: a missing name ran before the merge on a recent merged PR, a real check still to come; only those names veto
      e.snap = { ...rest, learn: "pre-merge", expect: { ...facts, missing: facts.missing.filter((n) => !mergeTime.includes(n)) } };
      e.unsettled = true;
    } else if (waiting.length > 0) {
      // case 3: not learnable; the veto stands, the pass is not claimed, and after the settle hold the PR shows the waiting names instead of `unsettled`
      const hold = settleMs > 0 ? holdPass(old?.passSince, head, e.snap.runs, now, settleMs) : null;
      if (hold) e.passSince = hold.since;
      e.snap = facts ? { ...rest, expect: facts } : rest;
      if (hold?.held) e.unsettled = true;
      else {
        delete e.unsettled;
        e.waiting = waiting.slice(0, 10).map((n) => oneLine(n, 120));
      }
    } else {
      e.snap = facts ? { ...rest, expect: facts } : rest;
      if (facts && open) e.unsettled = true;
    }
  });
}

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
    refresh: (config, hosts, phases) => refreshOpenPrs({ file: openPrsFile(agentDir), config, gh: realGh(agentDir, env), ...(hosts ? { hosts } : {}), ...(phases ? { phases } : {}) }),
    githubHosts: resolveGithubHosts,
    runSource: (cfg, ctx) => runSource(cfg, ctx, { stateDir: path.join(agentDir, "pi-foreman", "state"), env, platform: process.platform }),
    trace: (config) => {
      const w = openTrace({ enabled: get(config, "trace.enabled"), dir: get(config, "trace.dir"), stateDir: path.join(agentDir, "pi-foreman", "state"), sessionId: "pr-tracker" });
      return (rec) => w?.emit(rec);
    },
  };
}

export function line(r: PollResult): string {
  return `prs poll: tracked ${r.tracked}, dropped ${r.dropped}, searched ${r.searched ? "yes" : "no"}${r.skipped ? `, skipped ${r.skipped}` : ""}${r.cleared ? `, search off, cleared ${r.cleared} ${r.cleared === 1 ? "entry" : "entries"}` : ""}${r.error ? `, error ${r.error}` : ""}`;
}

/** The CLI: argv after `prs`. Returns the exit code. */
export async function main(argv: string[], out: (s: string) => void, err: (s: string) => void, deps: () => PollDeps = realDeps): Promise<number> {
  if (argv[0] !== "poll" || argv.slice(1).some((a) => a !== "--json")) {
    err(`${USAGE}\n`);
    return 2;
  }
  const r = await pollPrs(deps());
  const { tracked, dropped, searched, skipped, error, cleared } = r;
  out(argv.includes("--json") ? `${JSON.stringify({ tracked, dropped, searched, ...(cleared ? { cleared } : {}), ...(skipped ? { skipped } : {}), ...(error ? { error } : {}) })}\n` : `${line(r)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), (s) => process.stdout.write(s), (s) => process.stderr.write(s));
}
