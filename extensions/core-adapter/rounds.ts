// Revision rounds (H2, plan D3/D4): how often the builder may go back over reviewed work.
//
// What the adapter sees of a finished child: pi-subagents 0.75.0 delivers every detached
// completion to the foreman as a custom message `subagent-notify` (runs/background/notify.js
// sendCompletion), before the run that message triggers. Its first line is
// `Background task <status>: **<agent>**` (grouped: `Background tasks completed (n): **a**, **b**`),
// followed by the child's output preview. The verdict is read from that text: the reviewer's
// `Overall verdict: PASS|FAIL` and the senior reviewer's `Verdict: APPROVE|BLOCK`
// (agents/*.md output contracts). FAIL/BLOCK opens a round, PASS/APPROVE does not; with no
// verdict in the text (preview cut, contract not followed) the order alone counts.
//
// A builder launch while a review of built work is open is a revision round. Limit per tier:
// `ceremony.revisionRounds` (trivial 0). Rounds reset on a user prompt and on a tier change.

import type { Tier } from "./ceremony.ts";

export const NOTIFY_TYPE = "subagent-notify";
export const REVIEW_ROLES = ["reviewer", "senior-reviewer"];
const DEFAULT_LIMITS: Record<Tier, number> = { trivial: 0, standard: 1, heavy: 2 };

export interface RoundState {
  /** A builder was launched since the last reset. */
  built: boolean;
  /** A review of built work finished (FAIL or no verdict) after the last builder launch. */
  reviewOpen: boolean;
  /** Revision rounds launched since the last reset. */
  used: number;
}

export type Verdict = "pass" | "fail";

export function initialRounds(): RoundState {
  return { built: false, reviewOpen: false, used: 0 };
}

/** Agents a completion notice reports as completed, or [] when the text is not one. */
export function completedAgents(content: string): string[] {
  const first = content.split(/\r?\n/, 1)[0] ?? "";
  const single = /^(?:Background task|Detached foreground task) (completed|failed|paused|stopped): \*\*(.+?)\*\*/.exec(first);
  if (single) return single[1] === "completed" ? [single[2]] : [];
  const grouped = /^Background tasks completed \(\d+\): (.*)$/.exec(first);
  if (!grouped) return [];
  return [...grouped[1].matchAll(/\*\*(.+?)\*\*/g)].map((m) => m[1]);
}

/** Verdict in a review's text: any FAIL/BLOCK wins, else PASS/APPROVE, else null. */
export function verdictOf(text: string): Verdict | null {
  const all = [...text.matchAll(/\b(?:overall\s+)?verdict\s*\**\s*:\s*\**\s*(pass|fail|approve|block)\b/gi)].map((m) => m[1].toLowerCase());
  if (all.some((v) => v === "fail" || v === "block")) return "fail";
  return all.length > 0 ? "pass" : null;
}

/** A review run finished. Only a review after a builder launch can open a round. */
export function onReviewDone(s: RoundState, verdict: Verdict | null): RoundState {
  if (!s.built) return s;
  return { ...s, reviewOpen: verdict !== "pass" };
}

export function revisionLimit(configured: unknown, tier: Tier): number {
  if (tier === "trivial") return 0;
  const v = configured && typeof configured === "object" ? (configured as Record<string, unknown>)[tier] : undefined;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : DEFAULT_LIMITS[tier];
}

/** Check a builder launch: is it a revision round, and is it over the tier's limit? */
export function checkBuilderLaunch(s: RoundState, tier: Tier, configured: unknown): { revision: boolean; block?: string } {
  if (!s.reviewOpen) return { revision: false };
  const limit = revisionLimit(configured, tier);
  if (s.used + 1 <= limit) return { revision: true };
  return {
    revision: true,
    block: `pi-foreman: revision limit for ${tier} reached (${limit}): this builder launch would be revision round ${s.used + 1} after a review. Report the open findings to the owner and ask how to go on; the owner can raise the tier with /ceremony. A new user prompt starts the count again.`,
  };
}

/** A builder launch passed every check. */
export function afterBuilderLaunch(s: RoundState, revision: boolean): RoundState {
  return { built: true, reviewOpen: false, used: s.used + (revision ? 1 : 0) };
}
