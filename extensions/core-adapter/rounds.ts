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
// A builder run started while a review of built work is open is a revision round. Limit per
// tier: `ceremony.revisionRounds` (trivial 0). Every launch call is walked step by step
// (`launchSteps`): in a `chain`, each builder entry after a reviewer/senior-reviewer step counts
// as one round, and a call whose rounds would exceed the limit is refused as a whole. A review
// of built work counts as open from its launch until a PASS/APPROVE completion closes it, so a
// builder launched while that review is still running is a revision round too. A `resume` of a
// builder run counts like a builder launch (index.ts). Rounds reset on a user prompt and on a
// tier change by the user (`/ceremony`), not on a raise by the foreman, a ledger or a signal.

import type { Tier } from "./ceremony.ts";

export const NOTIFY_TYPE = "subagent-notify";
export const REVIEW_ROLES = ["reviewer", "senior-reviewer"];
const DEFAULT_LIMITS: Record<Tier, number> = { trivial: 0, standard: 1, heavy: 2 };

export interface RoundState {
  /** A builder was launched since the last reset. */
  built: boolean;
  /** A review of built work was launched after the last builder launch and no PASS/APPROVE closed it. */
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

type Json = Record<string, unknown>;

/** The agents of one launch call in run order; the agents of one inner list run at the same time. */
export function launchSteps(input: Json): string[][] {
  const names = (list: unknown[]): string[] => list.map((e) => (e && typeof e === "object" ? (e as Json).agent : undefined)).filter((a): a is string => typeof a === "string" && a !== "");
  const steps: string[][] = [];
  if (typeof input.agent === "string" && input.agent) steps.push([input.agent]);
  if (Array.isArray(input.tasks)) steps.push(names(input.tasks));
  if (Array.isArray(input.chain)) {
    for (const step of input.chain) {
      if (!step || typeof step !== "object") continue;
      const st = step as Json;
      steps.push(Array.isArray(st.parallel) ? names(st.parallel) : names([st]));
    }
  }
  return steps.filter((g) => g.length > 0);
}

export interface LaunchRounds {
  /** Builder runs in this call that are revision rounds. */
  revisions: number;
  block?: string;
  /** Round state once the call is allowed. */
  next: RoundState;
}

/**
 * Walk a launch call's steps: each builder entry while a review is open is a revision round;
 * a review step after built work opens one. Refused when the call would exceed the tier's limit.
 */
export function checkLaunch(s: RoundState, steps: string[][], tier: Tier, configured: unknown): LaunchRounds {
  let { built, reviewOpen } = s;
  let revisions = 0;
  for (const group of steps) {
    const builders = group.filter((a) => a === "builder").length;
    if (builders > 0) {
      if (reviewOpen) revisions += builders;
      built = true;
      reviewOpen = false;
    }
    if (built && group.some((a) => REVIEW_ROLES.includes(a))) reviewOpen = true;
  }
  const next = { built, reviewOpen, used: s.used + revisions };
  if (revisions === 0) return { revisions, next };
  const limit = revisionLimit(configured, tier);
  if (next.used <= limit) return { revisions, next };
  return {
    revisions,
    next,
    block: `pi-foreman: revision limit for ${tier} reached (${limit}): this launch would bring the revision rounds to ${next.used} (a builder run after a review, also one in the same chain or while a review is still running). Report the open findings to the owner and ask how to go on; the owner can raise the tier with /ceremony. A new user prompt starts the count again.`,
  };
}

/** A tier change: only the user's own (`/ceremony`) starts the count again; a raise by the foreman, a ledger header or a signal does not. */
export function onTierChange(s: RoundState, source: string): RoundState {
  return source === "user" ? initialRounds() : s;
}
