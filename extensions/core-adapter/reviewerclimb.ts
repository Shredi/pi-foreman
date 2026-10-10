// Reviewer climb (ladder.reviewerClimb, docs/ladder.md): the reviewer's own rungs.
//
//   review_fail_repeat: the same ledger item FAILs in a second reviewer run -> the next reviewer
//     launch goes to roles.reviewer.strong (one rung; no-op without a strong rung).
//   security: the work diff the reviewer will see is security-shaped (diffscan.ts securityScan) ->
//     the reviewer launch goes to ladder.reviewerClimb.securityRung; unset, the next rank above the
//     reviewer's strong rung (providers.<p>.ranks) among the mapped models, else no extra climb.
// Only `reviewer` launches the foreman passed no model for; `senior-reviewer` never climbs here.
// Off unless ladder.reviewerClimb.enabled is true (the generic default is false).
import { get, type Json } from "./config.ts";
import { clampLevel, splitLevel } from "./launchmodel.ts";
import { ranksOf, tierOf } from "./ranks.ts";
import { hasStrongRung, launchEntries } from "./ladder.ts";
import { securityScan } from "./diffscan.ts";
import { verdictItemsOf } from "./reviewmarks.ts";

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

export interface ReviewerClimbConfig {
  enabled: boolean;
  securityRung: string | null;
}

export function reviewerClimbConfig(config: Json | undefined): ReviewerClimbConfig {
  const rung = get(config, "ladder.reviewerClimb.securityRung");
  return { enabled: get(config, "ladder.reviewerClimb.enabled") === true, securityRung: typeof rung === "string" && rung.trim() ? rung.trim() : null };
}

/**
 * Item numbers of the review's per-item `N. FAIL` lines, in order, without repeats. Accepts a list
 * marker (`-`, `*`), backticks or `**` around the number or the line, `N.` or `N)`, and the doubled
 * form "1. `1. FAIL`". Lines inside ``` fences are skipped.
 */
export const failItemsOf = (text: string): string[] => verdictItemsOf(text, "FAIL");

/** Completed `reviewer` children's texts of a run-end event. */
export function reviewerTextsOfRunEnd(data: unknown): string[] {
  if (!isObj(data)) return [];
  const results = Array.isArray(data.results) && data.results.length > 0 ? data.results.filter(isObj) : [data];
  const out: string[] = [];
  for (const r of results) {
    const role = typeof r.agent === "string" ? r.agent : typeof data.agent === "string" ? data.agent : "";
    if (role !== "reviewer") continue;
    const completed = (r.status === undefined ? r.success === true : r.status === "completed") && r.success !== false && r.timedOut !== true && r.stopped !== true && !r.error;
    if (completed) out.push([r.output, r.summary].filter((t): t is string => typeof t === "string").join("\n"));
  }
  return out;
}

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
    if (!isObj(o) || typeof o.model !== "string" || !o.model) return;
    const lvl = typeof o.thinking === "string" ? o.thinking : null;
    cands.push(lvl && !splitLevel(o.model).level ? `${o.model}:${lvl}` : o.model);
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
  /** review_fail_repeat: the entry gets the `strong` keyword; security: the model is written after the rank check. */
  reason: "review_fail_repeat" | "security";
  model: string;
  trace: Record<string, unknown>;
}

export interface ReviewerClimbInput {
  config: Json | undefined;
  /** The live rung per role (ladder.ts LadderState.live). */
  live: Map<string, string>;
  fails: ReviewerFails;
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
