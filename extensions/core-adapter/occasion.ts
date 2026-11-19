// Review occasions (docs/review.md): one launch path, climb rung, model rule and extractor for every
// review, told apart by the launch field `occasion` or a marker at the head of the reviewer's task text (launchOccasion):
//   [plan-review]    the plan before the checkpoint (ceremony.planReview),
//   [high-stakes]    the extra whole-change pass of a risky change (highstakes.ts; not config-facing, never counts),
//   [pre-pr]         the whole branch diff before a pull request,
//   [second-opinion] optional advice on unchanged work (bound.ts dupReview exemption; never blocks),
//   none             "item": the review of built ledger items.
// The occasion is taken at launch (tool_call, before the facts block is appended) and carried to
// the run end by launch bookkeeping (tool call id, then run id), entry by entry in launch order.
// Only primary results of an `item` or `pre-pr` review count for item marks, the review gate,
// ReviewerFails and the PR gate; second opinions, plan reviews and panel
// shadows are recorded as findings only.
import { launchEntries } from "./ladder.ts";
import { REVIEW_ROLES, type Verdict } from "./rounds.ts";
import type { VerdictFinding, VerdictItem, VerdictRecord } from "./verdict.ts";

export type Occasion = "plan-review" | "pre-pr" | "second-opinion" | "item" | "high-stakes";
/** The config-facing occasions (reviewByOccasion keys, panel gates); `high-stakes` is not one of them. */
export const OCCASIONS: readonly Occasion[] = ["plan-review", "pre-pr", "second-opinion", "item"];

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** The task text with fenced blocks, backtick code spans and `[pi-foreman ...]` harness lines removed: a tag there is a mention, not an occasion. */
function prose(text: string): string {
  return text.replace(/(```|~~~)[\s\S]*?\1/g, " ").replace(/`[^`\n]*`/g, " ").replace(/^[ \t]*\[pi-foreman[^\n]*/gim, "");
}

/** A tag is standalone when the start of the text, whitespace or an opening bracket comes before it. */
const tagIn = (text: string, tag: string): boolean => new RegExp(`(^|[\\s(\\[])\\[${tag}\\]`, "i").test(text);

/** The occasion a task text (or a launch's `reason`) names; `[second-opinion]` wins over the others, then plan-review, then high-stakes, then pre-pr. */
export function occasionOf(text: unknown, reason?: unknown): Occasion {
  if (reason === "second-opinion") return "second-opinion";
  const t = typeof text === "string" ? prose(text) : "";
  if (tagIn(t, "second-opinion")) return "second-opinion";
  if (tagIn(t, "plan-review")) return "plan-review";
  if (tagIn(t, "high-stakes")) return "high-stakes";
  if (tagIn(t, "pre-pr")) return "pre-pr";
  return "item";
}

/** The values of the launch field `occasion` (a reviewer entry's review kind), in the precedence order of `occasionOf`. */
export const LAUNCH_OCCASIONS = ["second-opinion", "plan-review", "high-stakes", "pre-pr"] as const;
export type LaunchOccasion = (typeof LAUNCH_OCCASIONS)[number];
export const isLaunchOccasion = (v: unknown): v is LaunchOccasion => typeof v === "string" && (LAUNCH_OCCASIONS as readonly string[]).includes(v);

/** The occasion tags of the head run: the leading bracket tokens of the prose, each `[x]` or `[[x]]`; other tokens (`[panel-shadow:m]`, `[[replay:id]]`, `[re-review items]`) are skipped. */
function headTags(task: string): Set<LaunchOccasion> {
  const out = new Set<LaunchOccasion>();
  let rest = prose(task);
  for (;;) {
    const m = /^\s*(?:\[\[([^[\]\n]*)\]\]|\[([^[\]\n]*)\])/.exec(rest);
    if (!m) return out;
    const name = (m[1] ?? m[2] ?? "").trim().toLowerCase();
    if (isLaunchOccasion(name)) out.add(name);
    rest = rest.slice(m[0].length);
  }
}

/** The occasion the head run names with the precedence of `occasionOf`; "ambiguous" for `[pre-pr]` with `[high-stakes]` and neither `[second-opinion]` nor `[plan-review]`; null for none. */
function headOccasion(tags: ReadonlySet<LaunchOccasion>): LaunchOccasion | "ambiguous" | null {
  const first = LAUNCH_OCCASIONS.find((t) => tags.has(t)) ?? null;
  return first === "high-stakes" && tags.has("pre-pr") ? "ambiguous" : first;
}

export type OccasionRefusal = "review_occasion_ambiguous" | "review_occasion_late";
export type LaunchOccasionResult = { occasion: Occasion; prepend: boolean } | { refused: OccasionRefusal; text: string };

/**
 * The occasion of one launch entry. A non-reviewer entry is `item` without any text check. A reviewer entry takes it from its sources: the launch
 * field `taken` (the validated `occasion` value), `reason: "second-opinion"` (the entry's, else the launch's) and the head run of its task; all
 * present sources must agree. With none, a tag later in the text is refused (`review_occasion_late`); with a source, later tags are mentions.
 * `prepend` is true when the field names a kind the head run does not: the caller puts `[<kind>] ` in front of the task.
 */
export function launchOccasion(entry: Json, taken: unknown, launchReason?: unknown): LaunchOccasionResult {
  if (typeof entry.agent !== "string" || !REVIEW_ROLES.includes(entry.agent)) return { occasion: "item", prepend: false };
  const task = typeof entry.task === "string" ? entry.task : "";
  const tags = headTags(task);
  const head = headOccasion(tags);
  if (head === "ambiguous") return { refused: "review_occasion_ambiguous", text: "pi-foreman: launch refused [review_occasion_ambiguous]: the head of the reviewer task names both [pre-pr] and [high-stakes]; keep one (or set occasion on the launch and quote the other in backticks)." };
  const sources: [string, LaunchOccasion][] = [];
  if (isLaunchOccasion(taken)) sources.push([`occasion: "${taken}"`, taken]);
  if ((entry.reason ?? launchReason) === "second-opinion") sources.push(['reason: "second-opinion"', "second-opinion"]);
  if (head) sources.push([`[${head}] at the head of the task`, head]);
  if (sources.length === 0) {
    const t = prose(task);
    const kind = LAUNCH_OCCASIONS.find((k) => tagIn(t, k));
    if (!kind) return { occasion: "item", prepend: false };
    return { refused: "review_occasion_late", text: `pi-foreman: launch refused [review_occasion_late]: the reviewer task names [${kind}] only later in the text, where it could be a mention. Fix: set occasion: "${kind}" on the launch (or put [${kind}] first in the task).` };
  }
  if (new Set(sources.map((x) => x[1])).size > 1) return { refused: "review_occasion_ambiguous", text: `pi-foreman: launch refused [review_occasion_ambiguous]: the reviewer launch names different review kinds (${sources.map((x) => x[0]).join(", ")}); keep one.` };
  const occasion = sources[0][1];
  return { occasion, prepend: isLaunchOccasion(taken) && !tags.has(occasion) && typeof entry.task === "string" };
}

/** Put the `[<kind>] ` marker of a launch field in front of a reviewer task (the head run already naming the kind: nothing). */
export const withOccasionMarker = (task: string, kind: LaunchOccasion): string => (headTags(task).has(kind) ? task : `[${kind}] ${task}`);

/** Whether a review of this occasion counts for items, the review gate, the climb and the PR gate. */
export const countsForItems = (o: Occasion): boolean => o === "item" || o === "pre-pr";

const OCCASION_LINES: Partial<Record<Occasion, string>> = {
  "second-opinion": "occasion: second-opinion (advisory: marks no items, does not open the review gate)",
  "plan-review": "occasion: plan-review (plan only: marks no items)",
  "pre-pr": "occasion: pre-pr (counts for items and the PR gate)",
  "high-stakes": "occasion: high-stakes (the whole change on the high-stakes model: marks no items, opens no gate)",
};

/** The launch-result line of each non-item occasion the review children of the launch were recorded with (taken at the launch, not from the rewritten task). */
export function occasionLinesOf(occasions: Iterable<Occasion>, hsRequired = false, reminderText: string | null = null): string[] {
  const named = new Set(occasions);
  // `hsRequired`: a high-stakes review is due; `reminderText` only reminds, on an item or `[pre-pr]` review, the steps before the late ones (the finish hold, the PR tools).
  const reminder = hsRequired ? reminderText : null;
  const lines = [...named].flatMap((o) => (o === "pre-pr" && reminder ? `${OCCASION_LINES[o]}; ${reminder}` : OCCASION_LINES[o] ?? []));
  return reminder && named.has("item") ? [...lines, reminder] : lines;
}

/** One launched child, in launch order (launchEntries entries that name an agent). */
export interface LaunchEntry {
  role: string;
  occasion: Occasion;
  /** The model the entry launched with, when known. */
  model: string | null;
  /** Panel shadow: the shadow model; null for the primary. */
  shadow: string | null;
  /** 1 when a repeat-fail or security climb raised the entry to the strong rung, else 0 (findings --rung). */
  rung: number;
}

/** A launch with at least one review child, kept from tool_call to its run end. */
export interface ReviewLaunch {
  entries: LaunchEntry[];
  /** ms epoch at the tool_call. */
  started: number;
  /** Changed files the review covers (the facts diff; plan + ledger for a plan review). */
  files: string[];
  /** Changed lines of the reviewed diff (retro critique counter); unset for a plan review. */
  lines?: number;
  /** Panel launch: the gate and the models (panel.ts); set on a gate primary and on a shadow launch. */
  panel: { gate: Occasion; primary: string; shadows: string[] } | null;
  /** Gate primary of a panel: its task text before the facts block (a shadow launch gets the same). */
  task?: string;
  /** Shadow launch: the primary's run id (the pending panel it reports to). */
  bind?: string;
}

/** The occasion of every agent entry of a launch, keyed by entry object (taken before any rewrite). */
export function entryOccasions(input: Json): Map<Json, Occasion> {
  const out = new Map<Json, Occasion>();
  for (const e of launchEntries(input)) if (typeof e.agent === "string") out.set(e, occasionOf(e.task, e.reason ?? input.reason));
  return out;
}

/** The bookkeeping of a launch after every rewrite; null without a review child. */
export function reviewLaunchOf(input: Json, occasions: Map<Json, Occasion>, shadows: Map<Json, string>, o: { started: number; files: string[]; panel: ReviewLaunch["panel"]; climbed?: Set<Json> }): ReviewLaunch | null {
  const entries: LaunchEntry[] = [];
  for (const e of launchEntries(input)) {
    if (typeof e.agent !== "string") continue;
    entries.push({ role: e.agent, occasion: occasions.get(e) ?? occasionOf(e.task), model: typeof e.model === "string" && e.model ? e.model : null, shadow: shadows.get(e) ?? null, rung: o.climbed?.has(e) ? 1 : 0 });
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
  /** From the verdict record (verdict.ts): pass or fail; null for no record, an invalid one, or `incomplete`. */
  verdict: Verdict | null;
  /** The record's per-item results (ids the launch's `items` named); [] without a record. */
  items: VerdictItem[];
  /** The record's findings (defect, now, later); [] without a record. */
  findings: VerdictFinding[];
  /** The reviewer recorded `incomplete` (it could not run its checks): no verdict for the gates. */
  incomplete: boolean;
  /** The reason of an `incomplete` record. */
  reason: string | null;
  model: string | null;
  cwd: string | null;
  occasion: Occasion;
  shadow: string | null;
  primary: boolean;
  /** The launch entry's rung (LaunchEntry.rung); 0 without bookkeeping. */
  rung: number;
  /** Counts for items, review gate, ReviewerFails and PR gate. */
  counts: boolean;
}

const completed = (r: Json): boolean => (r.status === undefined ? r.success === true : r.status === "completed") && r.success !== false && r.timedOut !== true && r.stopped !== true && !r.error;
const childrenOf = (data: Json): Json[] => (Array.isArray(data.results) && data.results.length > 0 ? data.results.filter(isObj) : [data]);

/**
 * The completed reviewer children of a run-end event with their occasion. Results
 * map to the launch entries by position (pi-subagents keeps launch order); a role mismatch or a run
 * without bookkeeping (a resume) reads the occasion from nothing: `item`, primary. `record` is the run's verdict record (read once by the
 * caller): a review launch is a single launch (review_single_launch), so it belongs to the one result of the event; with more results it is ignored.
 */
export function reviewResultsOfRunEnd(data: unknown, launch?: ReviewLaunch | null, record?: VerdictRecord | null): ReviewResult[] {
  if (!isObj(data)) return [];
  const out: ReviewResult[] = [];
  const kids = childrenOf(data);
  kids.forEach((r, index) => {
    const role = typeof r.agent === "string" ? r.agent : typeof data.agent === "string" ? data.agent : "";
    if (!REVIEW_ROLES.includes(role) || !completed(r)) return;
    const entry = launch?.entries[index]?.role === role ? launch.entries[index] : undefined;
    const text = [r.output, r.summary].filter((t): t is string => typeof t === "string").join("\n");
    const occasion = entry?.occasion ?? "item";
    const shadow = entry?.shadow ?? null;
    const cwd = typeof r.cwd === "string" && r.cwd ? r.cwd : typeof data.cwd === "string" && data.cwd ? data.cwd : null;
    const rec = kids.length === 1 ? record ?? null : null;
    const verdict: Verdict | null = rec && rec.verdict !== "incomplete" ? rec.verdict : null;
    out.push({ index, role, text, verdict, items: rec?.items ?? [], findings: rec?.findings ?? [], incomplete: rec?.verdict === "incomplete", reason: rec?.reason ?? null, model: typeof r.model === "string" && r.model ? r.model : entry?.model ?? shadow, cwd, occasion, shadow, primary: shadow === null, rung: entry?.rung ?? 0, counts: shadow === null && countsForItems(occasion) });
  });
  return out;
}

/** The children of a run-end event in result order (the event itself when it has no results). */
export const runEndChildren = childrenOf;

