// Reviewer climb (ladder.reviewerClimb, docs/ladder.md): the reviewer's own rungs.
//
//   review_fail_repeat: the same ledger item FAILs in a second reviewer run -> the next reviewer
//     launch goes to roles.reviewer.strong (one rung; no-op without a strong rung).
//   security: the work diff the reviewer will see is security-shaped (diffscan.ts securityScan) ->
//     the reviewer launch goes to ladder.reviewerClimb.securityRung; unset, the next rank above the
//     reviewer's strong rung (providers.<p>.ranks) among the mapped models, else no extra climb.
//   on_find (mode "on-find"): each ledger item climbs one rung of ladder.reviewerClimb.rungs per FAIL
//     or per PASS with located findings; a clean verdict ends its climb (climb_done reason clean), a
//     finding on the top rung too (reason exhausted). A launch goes to the highest open item's rung.
// Only `reviewer` launches the foreman passed no model for; `senior-reviewer` never climbs here.
// Off unless ladder.reviewerClimb.enabled is true (the generic default is false).
// The different-model rule (applyReviewModelRule) applies to every `reviewer` launch, climb or not.
import { get, type Json } from "./config.ts";
import { clampLevel, splitLevel } from "./launchmodel.ts";
import { ranksOf, tierOf } from "./ranks.ts";
import { hasStrongRung, launchEntries } from "./ladder.ts";
import { securityScan } from "./diffscan.ts";
import { verdictItemsOf } from "./reviewmarks.ts";

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

export type ClimbMode = "repeat-fail" | "on-find";

export interface ReviewerClimbConfig {
  enabled: boolean;
  securityRung: string | null;
  mode: ClimbMode;
  /** ladder.reviewerClimb.rungs as given ([] = the role map's reviewer rungs; see climbRungs). */
  rungs: string[];
}

export function reviewerClimbConfig(config: Json | undefined): ReviewerClimbConfig {
  const rung = get(config, "ladder.reviewerClimb.securityRung");
  const rungs = get(config, "ladder.reviewerClimb.rungs");
  return {
    enabled: get(config, "ladder.reviewerClimb.enabled") === true,
    securityRung: typeof rung === "string" && rung.trim() ? rung.trim() : null,
    mode: get(config, "ladder.reviewerClimb.mode") === "on-find" ? "on-find" : "repeat-fail",
    rungs: Array.isArray(rungs) ? rungs.filter((m): m is string => typeof m === "string" && m.trim() !== "").map((m) => m.trim()) : [],
  };
}

/** A role-map rung `{model, thinking}` as `<model>[:<level>]`, or null. */
function rungOf(o: unknown): string | null {
  if (!isObj(o) || typeof o.model !== "string" || !o.model) return null;
  const lvl = typeof o.thinking === "string" ? o.thinking : null;
  return lvl && !splitLevel(o.model).level ? `${o.model}:${lvl}` : o.model;
}

/** The reviewer's climb rungs, bottom first: ladder.reviewerClimb.rungs as given, else [roles.reviewer, roles.reviewer.strong]. */
export function climbRungs(config: Json | undefined, roles: Record<string, Json>): string[] {
  const given = reviewerClimbConfig(config).rungs;
  if (given.length > 0) return given;
  const r = roles.reviewer;
  return [rungOf(r), isObj(r) ? rungOf(r.strong) : null].filter((m): m is string => m !== null);
}

const baseOf = (m: string): string => splitLevel(m).base;

/**
 * Item numbers of the review's per-item `N. FAIL` lines, in order, without repeats. Accepts a list
 * marker (`-`, `*`), backticks or `**` around the number or the line, `N.` or `N)`, and the doubled
 * form "1. `1. FAIL`". Lines inside ``` fences are skipped.
 */
export const failItemsOf = (text: string): string[] => verdictItemsOf(text, "FAIL");

/** Completed `reviewer` children of a run-end event: text and model (when the result names one). */
export function reviewerRunsOfRunEnd(data: unknown): { text: string; model: string | null }[] {
  if (!isObj(data)) return [];
  const results = Array.isArray(data.results) && data.results.length > 0 ? data.results.filter(isObj) : [data];
  const out: { text: string; model: string | null }[] = [];
  for (const r of results) {
    const role = typeof r.agent === "string" ? r.agent : typeof data.agent === "string" ? data.agent : "";
    if (role !== "reviewer") continue;
    const completed = (r.status === undefined ? r.success === true : r.status === "completed") && r.success !== false && r.timedOut !== true && r.stopped !== true && !r.error;
    if (completed) out.push({ text: [r.output, r.summary].filter((t): t is string => typeof t === "string").join("\n"), model: typeof r.model === "string" ? r.model : null });
  }
  return out;
}

/** Completed `reviewer` children's texts of a run-end event. */
export const reviewerTextsOfRunEnd = (data: unknown): string[] => reviewerRunsOfRunEnd(data).map((r) => r.text);

/** FAIL counts per ledger item across reviewer runs (one count per run), keyed by the bound ledger. */
export class ReviewerFails {
  private readonly counts = new Map<string, number>();
  private readonly seen = new Set<string>();
  private ledger: string | null = null;

  /** A reviewer run ended: count each item it FAILs once. */
  onRun(runId: string, texts: string[], ledger: string | null): void {
    if (this.seen.has(runId) || texts.length === 0) return;
    this.seen.add(runId);
    if (ledger !== this.ledger) {
      this.counts.clear();
      this.ledger = ledger;
    }
    for (const n of new Set(texts.flatMap(failItemsOf))) this.counts.set(n, (this.counts.get(n) ?? 0) + 1);
  }

  /** The first item that failed in two or more reviewer runs, or null. */
  repeated(): string | null {
    for (const [n, c] of this.counts) if (c >= 2) return n;
    return null;
  }
}

/** One ledger item's open on-find climb (an item without an entry has no open climb). */
interface ItemClimb {
  rung: number;
  /** Base models of the reviews this climb has seen, in order. */
  visited: string[];
  /** ms epoch of the climb's first review. */
  start: number;
}

/**
 * The on-find climb per ledger item (mode "on-find"), per session, cleared when the bound ledger
 * changes. A FAIL or a PASS with located findings moves the item one rung up (rung_up reason
 * on_find), or ends its climb on the top rung (climb_done reason exhausted); a clean PASS ends it
 * (climb_done reason clean). Each item counts once per reviewer run.
 */
export class OnFindClimb {
  private readonly items = new Map<string, ItemClimb>();
  private readonly seen = new Set<string>();
  private ledger: string | null = null;
  /** The resolved rungs (climbRungs), set by planReviewerClimbs at each reviewer launch plan. */
  rungs: string[] = [];

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * A reviewer run's verdict on `items`: `located` = the PASS report located defects (a FAIL
   * always climbs). Returns the trace records to emit.
   */
  onVerdict(runId: string, items: string[], verdict: "pass" | "fail", located: boolean, model: string, ledger: string | null): Record<string, unknown>[] {
    if (ledger !== this.ledger) {
      this.items.clear();
      this.ledger = ledger;
    }
    const top = Math.max(0, this.rungs.length - 1);
    const at = (i: number): string | null => (this.rungs[i] ? baseOf(this.rungs[i]) : null);
    const out: Record<string, unknown>[] = [];
    for (const item of new Set(items)) {
      const key = `${runId}\u0000${item}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const c = this.items.get(item) ?? { rung: 0, visited: [], start: this.now() };
      c.visited.push(baseOf(model));
      const done = (reason: string): void => {
        out.push({ event: "climb_done", role: "reviewer", rungs: c.visited.length, reason, item });
        this.items.delete(item);
      };
      if (verdict === "pass" && !located) done("clean");
      else if (c.rung >= top) done("exhausted");
      else {
        const from = c.rung++;
        this.items.set(item, c);
        out.push({ event: "rung_up", role: "reviewer", from: at(from), to: at(c.rung), reason: "on_find", item });
      }
    }
    return out;
  }

  /** ASSUMPTION A: the rung of the next reviewer launch, the highest among items with an open climb, else 0. */
  launchRung(): number {
    let rung = 0;
    for (const c of this.items.values()) rung = Math.max(rung, c.rung);
    return rung;
  }

  /** ms epoch of an item's open climb start, or null. */
  startOf(item: string): number | null {
    return this.items.get(item)?.start ?? null;
  }
}

/**
 * The default security rung: the mapped strong rung (of any role) in the next rank
 * above the reviewer's strong rung (its model without one), by providers.<p>.ranks; null without
 * ranks or such a model. A literal rank match (no `*`/`?`) counts as a model of its provider too.
 */
export function defaultSecurityRung(config: Json | undefined, roles: Record<string, Json>): string | null {
  const ranks = ranksOf(config);
  const r = roles.reviewer;
  if (ranks.size === 0 || !isObj(r) || typeof r.model !== "string") return null;
  const own = isObj(r.strong) && typeof r.strong.model === "string" && r.strong.model ? r.strong.model : r.model;
  const tier = tierOf(ranks, own);
  if (tier === null) return null;
  const cands: string[] = [];
  const add = (o: unknown): void => {
    const m = rungOf(o);
    if (m) cands.push(m);
  };
  // strong rungs and ranks only: a project layer may set a role's model, never its strong rung or the ranks
  for (const v of Object.values(roles)) if (isObj(v)) add(v.strong);
  for (const [p, list] of ranks) for (const e of list) if (!/[*?]/.test(e.match)) cands.push(e.match.includes("/") ? e.match : `${p}/${e.match}`);
  let best: { m: string; t: number } | null = null;
  for (const m of cands) {
    const t = tierOf(ranks, m);
    if (t !== null && t < tier && (!best || t > best.t)) best = { m, t };
  }
  return best ? best.m : null;
}

/** A security rung with its level capped by maxThinking and childMaxThinking. */
export function cappedRung(rung: string, maxThinking: unknown, childMaxThinking: unknown): string {
  const { base, level } = splitLevel(rung);
  return level ? `${base}:${clampLevel(clampLevel(level, maxThinking), childMaxThinking)}` : base;
}

export interface ReviewerClimb {
  entry: Json;
  /** review_fail_repeat: the entry gets the `strong` keyword; security: the model is written after the rank check; on_find: after the models, before the rank check. */
  reason: "review_fail_repeat" | "security" | "on_find";
  model: string;
  trace: Record<string, unknown>;
}

export interface ReviewerClimbInput {
  config: Json | undefined;
  /** The live rung per role (ladder.ts LadderState.live). */
  live: Map<string, string>;
  fails: ReviewerFails;
  /** The on-find climb (mode "on-find"); its rungs are set here. */
  climb?: OnFindClimb;
  /** The work diff a reviewer entry will review (taken once; diffscan.ts ReviewFacts.diffOf). */
  diffOf: (entry: Json) => Promise<string | null>;
}

/**
 * Before the models are written: the reviewer climbs of a `subagent` call (enabled only). A
 * review_fail_repeat climb sets the entry's model to the `strong` keyword here; a security climb's
 * model is written by applySecurityRungs after the rank check. Trace records come with each climb
 * (and a `security_rung_unset` record when a security hit finds no rung).
 */
export async function planReviewerClimbs(input: Json, roles: Record<string, Json>, o: ReviewerClimbInput): Promise<{ climbs: ReviewerClimb[]; traces: Record<string, unknown>[] }> {
  const cfg = reviewerClimbConfig(o.config);
  const climbs: ReviewerClimb[] = [];
  const traces: Record<string, unknown>[] = [];
  const r = roles.reviewer;
  if (!cfg.enabled || !isObj(r) || typeof r.model !== "string") return { climbs, traces };
  const composite = Array.isArray(input.tasks) || Array.isArray(input.chain);
  const from = splitLevel(o.live.get("reviewer") ?? r.model).base;
  const rungs = cfg.mode === "on-find" ? climbRungs(o.config, roles) : [];
  if (o.climb && cfg.mode === "on-find") o.climb.rungs = rungs;
  const onFind = rungs.length > 0 && o.climb ? Math.min(o.climb.launchRung(), rungs.length - 1) : 0;
  const rec = (to: string, reason: string, extra: Record<string, unknown>): Record<string, unknown> =>
    from === to ? { event: "rung_top", role: "reviewer", model: to, reason, ...extra } : { event: "rung_up", role: "reviewer", from, to, reason, ...extra };
  for (const e of launchEntries(input)) {
    if (e.agent !== "reviewer") continue;
    const passed = e.model ?? (composite ? input.model : undefined);
    if (typeof passed === "string" && passed.trim()) continue; // the foreman chose the model
    const hits = securityScan(await o.diffOf(e));
    if (hits.length > 0) {
      const rung = cfg.securityRung ?? defaultSecurityRung(o.config, roles);
      if (rung) {
        climbs.push({ entry: e, reason: "security", model: rung, trace: rec(splitLevel(rung).base, "security", { hits: hits.join(",") }) });
        continue;
      }
      traces.push({ event: "security_rung_unset", role: "reviewer", reason: "security", hits: hits.join(",") });
    }
    // on-find: the launch rung (ASSUMPTION A); above rung 0 it wins over the repeated-FAIL rule (one rung up at most).
    if (onFind > 0) {
      climbs.push({ entry: e, reason: "on_find", model: rungs[onFind], trace: rec(baseOf(rungs[onFind]), "on_find", { rung: onFind }) });
      continue;
    }
    const item = o.fails.repeated();
    if (item && hasStrongRung(roles, "reviewer")) {
      const strong = (r.strong as Json).model as string;
      e.model = "strong";
      climbs.push({ entry: e, reason: "review_fail_repeat", model: strong, trace: rec(splitLevel(strong).base, "review_fail_repeat", { item }) });
    }
  }
  return { climbs, traces };
}

/** At the rank check: a security climb whose rung the child rank policy would refuse gets `policy_override: true` in its trace. */
export function markPolicyOverrides(climbs: ReviewerClimb[], refused: (model: string) => boolean): void {
  for (const c of climbs) if (c.reason === "security" && refused(c.model)) c.trace.policy_override = true;
}

/** After the rank check: write each security climb's rung (level capped) into its entry. */
export function applySecurityRungs(climbs: ReviewerClimb[], maxThinking: unknown, childMaxThinking: unknown): void {
  for (const c of climbs) if (c.reason === "security") c.entry.model = cappedRung(c.model, maxThinking, childMaxThinking);
}

/** After the models are written, before the rank check: write each on-find climb's rung (level capped) into its entry. */
export function applyOnFindRungs(climbs: ReviewerClimb[], maxThinking: unknown, childMaxThinking: unknown): void {
  for (const c of climbs) if (c.reason === "on_find") c.entry.model = cappedRung(c.model, maxThinking, childMaxThinking);
}

export interface ReviewModelInput {
  config: Json | undefined;
  /** The foreman's model, `<provider>/<id>` (ctx.model), or null when unknown. */
  foreman: string | null;
  maxThinking: unknown;
  childMaxThinking: unknown;
  /** The child rank policy would refuse this model (marks policy_override on the trace). */
  refused?: (model: string) => boolean;
}

/**
 * The different-model rule, after every model is written (climbs and security rungs included):
 * a `reviewer` entry whose model is the foreman's (base ids, the level ignored) moves to the next
 * climb rung after its own that differs, else to ceremony.reviewModel; traced `review_model
 * {from, to, reason: same_as_foreman}` (policy_override when the rank policy would refuse it). With
 * neither, the launch stays (ASSUMPTION B): `review_model {from, to: from, reason: no_alternative}`.
 * Written after the rank check like the security rung: both are explicit user or overlay config.
 */
export function applyReviewModelRule(input: Json, roles: Record<string, Json>, o: ReviewModelInput): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (!o.foreman) return out;
  const foreman = baseOf(o.foreman);
  for (const e of launchEntries(input)) {
    if (e.agent !== "reviewer" || typeof e.model !== "string" || baseOf(e.model) !== foreman) continue;
    const from = baseOf(e.model);
    const rungs = climbRungs(o.config, roles);
    const own = rungs.findIndex((m) => baseOf(m) === from);
    const set = get(o.config, "ceremony.reviewModel");
    const fallback = typeof set === "string" && set.trim() && baseOf(set.trim()) !== foreman ? set.trim() : null;
    const pick = rungs.slice(own + 1).find((m) => baseOf(m) !== foreman) ?? fallback;
    if (!pick) {
      out.push({ event: "review_model", role: "reviewer", from, to: from, reason: "no_alternative" });
      continue;
    }
    const to = cappedRung(pick, o.maxThinking, o.childMaxThinking);
    e.model = to;
    const rec: Record<string, unknown> = { event: "review_model", role: "reviewer", from, to: baseOf(pick), reason: "same_as_foreman" };
    if (o.refused?.(to)) rec.policy_override = true;
    out.push(rec);
  }
  return out;
}
