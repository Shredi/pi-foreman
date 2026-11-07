// Cost guard (R6 lane 3): ceremony.budgetUsd on the summed estimate (the foreman
// plus all its runs), and the item-only re-review line.
import { verdictItemsOf } from "./reviewmarks.ts";
import { verdictOf } from "./rounds.ts";

export const BUDGET_WARN_SHARE = 0.8;

const usd = (v: number): string => `$${v.toFixed(2)}`;

/** ceremony.budgetUsd: a positive number, else null (no cap). */
export function budgetCap(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
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
