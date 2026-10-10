// Review occasions (docs/review-climb.md): one launch path, climb rung, model rule and extractor for every
// review, told apart by a marker in the reviewer's task text:
//   [plan-review]    the plan before the checkpoint (ceremony.planReview),
//   [pre-pr]         the whole branch diff before a pull request,
//   [second-opinion] optional advice on unchanged work (bound.ts dupReview exemption; never blocks),
//   none             "item": the review of built ledger items.
// The occasion is taken at launch (tool_call, before the facts block is appended) and carried to
// the run end by launch bookkeeping (tool call id, then run id), entry by entry in launch order.
// Only primary results of an `item` or `pre-pr` review count for item marks, the review gate,
// ReviewerFails, the on-find climb and the PR gate; second opinions, plan reviews and panel
// shadows are recorded as findings only.
import { launchEntries } from "./ladder.ts";
import { REVIEW_ROLES, verdictOf, type Verdict } from "./rounds.ts";

export type Occasion = "plan-review" | "pre-pr" | "second-opinion" | "item";
export const OCCASIONS: readonly Occasion[] = ["plan-review", "pre-pr", "second-opinion", "item"];

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** The occasion a task text (or a launch's `reason`) names; `[second-opinion]` wins over the others, then plan-review, then pre-pr. */
export function occasionOf(text: unknown, reason?: unknown): Occasion {
  const t = typeof text === "string" ? text.toLowerCase() : "";
  if (reason === "second-opinion" || t.includes("[second-opinion]")) return "second-opinion";
  if (t.includes("[plan-review]")) return "plan-review";
  if (t.includes("[pre-pr]")) return "pre-pr";
  return "item";
}

/** Whether a review of this occasion counts for items, the review gate, the climb and the PR gate. */
export const countsForItems = (o: Occasion): boolean => o === "item" || o === "pre-pr";

/** One launched child, in launch order (launchEntries entries that name an agent). */
export interface LaunchEntry {
  role: string;
  occasion: Occasion;
  /** The model the entry launched with, when known. */
  model: string | null;
  /** Panel shadow: the shadow model; null for the primary. */
  shadow: string | null;
}

/** A launch with at least one review child, kept from tool_call to its run end. */
export interface ReviewLaunch {
  entries: LaunchEntry[];
  /** ms epoch at the tool_call. */
  started: number;
  /** Changed files the review covers (the facts diff; plan + ledger for a plan review). */
  files: string[];
  /** Panel launch: the gate and the models (panel.ts). */
  panel: { gate: Occasion; primary: string; shadows: string[] } | null;
}

/** The occasion of every agent entry of a launch, keyed by entry object (taken before any rewrite). */
export function entryOccasions(input: Json): Map<Json, Occasion> {
  const out = new Map<Json, Occasion>();
  for (const e of launchEntries(input)) if (typeof e.agent === "string") out.set(e, occasionOf(e.task, e.reason ?? input.reason));
  return out;
}

/** The bookkeeping of a launch after every rewrite; null without a review child. */
export function reviewLaunchOf(input: Json, occasions: Map<Json, Occasion>, shadows: Map<Json, string>, o: { started: number; files: string[]; panel: ReviewLaunch["panel"] }): ReviewLaunch | null {
  const entries: LaunchEntry[] = [];
  for (const e of launchEntries(input)) {
    if (typeof e.agent !== "string") continue;
    entries.push({ role: e.agent, occasion: occasions.get(e) ?? occasionOf(e.task), model: typeof e.model === "string" && e.model ? e.model : null, shadow: shadows.get(e) ?? null });
  }
  if (!entries.some((e) => REVIEW_ROLES.includes(e.role))) return null;
  return { entries, started: o.started, files: o.files, panel: o.panel };
}

/** A completed review child of a run end, with its launch facts. */
export interface ReviewResult {
  /** Position among the run's results. */
  index: number;
  role: string;
  text: string;
  verdict: Verdict | null;
  model: string | null;
  cwd: string | null;
  occasion: Occasion;
  shadow: string | null;
  primary: boolean;
  /** Counts for items, review gate, ReviewerFails, on-find climb and PR gate. */
  counts: boolean;
}

const completed = (r: Json): boolean => (r.status === undefined ? r.success === true : r.status === "completed") && r.success !== false && r.timedOut !== true && r.stopped !== true && !r.error;
const childrenOf = (data: Json): Json[] => (Array.isArray(data.results) && data.results.length > 0 ? data.results.filter(isObj) : [data]);

/**
 * The completed reviewer / senior-reviewer children of a run-end event with their occasion. Results
 * map to the launch entries by position (pi-subagents keeps launch order); a role mismatch or a run
 * without bookkeeping (a resume) reads the occasion from nothing: `item`, primary.
 */
export function reviewResultsOfRunEnd(data: unknown, launch?: ReviewLaunch | null): ReviewResult[] {
  if (!isObj(data)) return [];
  const out: ReviewResult[] = [];
  childrenOf(data).forEach((r, index) => {
    const role = typeof r.agent === "string" ? r.agent : typeof data.agent === "string" ? data.agent : "";
    if (!REVIEW_ROLES.includes(role) || !completed(r)) return;
    const entry = launch?.entries[index]?.role === role ? launch.entries[index] : undefined;
    const text = [r.output, r.summary].filter((t): t is string => typeof t === "string").join("\n");
    const occasion = entry?.occasion ?? "item";
    const shadow = entry?.shadow ?? null;
    const cwd = typeof r.cwd === "string" && r.cwd ? r.cwd : typeof data.cwd === "string" && data.cwd ? data.cwd : null;
    out.push({ index, role, text, verdict: verdictOf(text), model: typeof r.model === "string" && r.model ? r.model : entry?.model ?? shadow, cwd, occasion, shadow, primary: shadow === null, counts: shadow === null && countsForItems(occasion) });
  });
  return out;
}

/**
 * The run-end event as the verdict consumers (item marks, review gate, ReviewerFails, on-find
 * climb, PR gate) see it: review children that do not count are dropped. With none left the
 * event names no child at all, so no consumer falls back to the event itself.
 */
export function countingView(data: unknown, results: readonly ReviewResult[]): unknown {
  if (!isObj(data)) return data;
  const drop = new Set(results.filter((r) => !r.counts).map((r) => r.index));
  if (drop.size === 0) return data;
  const kept = childrenOf(data).filter((_, i) => !drop.has(i));
  return kept.length > 0 ? { ...data, results: kept } : { runId: data.runId, agent: "", status: "excluded", results: [] };
}
