// Cost guard and review cap (R6 lane 3): ceremony.budgetUsd on the summed estimate (the foreman
// plus all its runs), ceremony.reviewRuns per user prompt, and the item-only re-review line.
import { verdictItemsOf } from "./reviewmarks.ts";
import { verdictOf } from "./rounds.ts";

export const BUDGET_WARN_SHARE = 0.8;
export const DEFAULT_REVIEW_RUNS = 3;

const usd = (v: number): string => `$${v.toFixed(2)}`;

/** ceremony.budgetUsd: a positive number, else null (no cap). */
export function budgetCap(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** ceremony.reviewRuns: an integer of at least 1, else the default 3. */
export function reviewRunsCap(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : DEFAULT_REVIEW_RUNS;
}

export type BudgetDecision = { kind: "refuse"; reason: string; text: string } | { kind: "warn"; text: string } | null;

/** Refuse a launch once the summed estimate reaches the cap; warn (once, the caller tracks it) from 80 %. */
export function budgetCheck(foreman: number, runs: number, cap: number | null, warned: boolean): BudgetDecision {
  if (cap === null) return null;
  const total = foreman + runs;
  const parts = `summed estimate ${usd(total)} (foreman ${usd(foreman)} + runs ${usd(runs)}) against ceremony.budgetUsd ${usd(cap)}`;
  if (total >= cap) return { kind: "refuse", reason: "budget_exceeded", text: `pi-foreman: launch refused [budget_exceeded]: ${parts}. Finish with what exists, or ask the user to raise ceremony.budgetUsd.` };
  if (!warned && total >= cap * BUDGET_WARN_SHARE) return { kind: "warn", text: `pi-foreman: budget warning: ${parts} (80 % reached).` };
  return null;
}

/**
 * Refuse a review launch past the per-prompt cap; `count` = review runs of the same kind already launched since the
 * user's prompt. Plan reviews (`[plan-review]`) and the other (fix-round) reviews are counted apart, each against `cap`.
 */
export function reviewCapCheck(count: number, adding: number, cap: number, kind: "review" | "plan" = "review"): { reason: string; text: string } | null {
  if (adding === 0 || count + adding <= cap) return null;
  const what = kind === "plan" ? "plan review" : "review";
  return { reason: "review_cap", text: `pi-foreman: review launch refused [review_cap]: ${count} ${what} run(s) already ran for this prompt (ceremony.reviewRuns ${cap}). Finish, or get the cap reset: the parent writes the line \`review-cap: +N\` in a ruling*.md of this session's handoff dir (newer than its ask.md or plan.md), or the owner sends a new prompt.` };
}

const MARK = "[re-review items:";

/** Failed item numbers of a FAIL review text (`N. FAIL` lines); [] for a pass or a text with none. */
export function failedItemsOf(text: string): string[] {
  return verdictOf(text) === "fail" ? verdictItemsOf(text, "FAIL") : [];
}

/** The re-review line: `[re-review items: 2, 5]`. */
export const reReviewLine = (items: readonly string[]): string => `${MARK} ${items.join(", ")}]`;

/** Prepend the line to a review task; unchanged when there are no items or the task already carries one. */
export function prependReReview(task: string, items: readonly string[]): string {
  if (items.length === 0 || task.includes(MARK)) return task;
  return `${reReviewLine(items)}\nReview only these failed items again; the verdict must list each of them as N. PASS or N. FAIL.\n\n${task}`;
}
