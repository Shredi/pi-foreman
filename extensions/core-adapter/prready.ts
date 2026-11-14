// The readiness rule of a pull request (docs/review.md), one pure function over recorded facts, none set by hand:
//   review facts (reviewFactsForHead): the newest code review recorded for the host's head is a `[pre-pr]` PASS and the head was not sent back;
//     a FAIL on the head or a send-back is work in progress, anything else is not reviewed;
//   checks: every gating check finished green (the watch's settle rule), or no checks confirmed;
//   the host says mergeable and the merge state is not behind, dirty, unknown (blocked and draft only keep it from being ready).
// The result drives the report line (prwatch.ts) and the draft target (a PR leaves draft when the rule holds, goes back on wip or unreviewed).
// With ceremony.reviewBeforePr off the caller never asks: no rule, no draft handling.
import type { ReviewRecord } from "./reviews.ts";

export type ReviewFacts = "ok" | "wip" | "unreviewed";
export type Readiness = "wip" | "running" | "red" | "unreviewed" | "ready";

/**
 * The review facts for the host's `head`. `revised`: work started after the last verdict (Session.reviewGate.revised); `sentBack`: the parent sent the
 * work back (phase B sets it; false until then). Plan reviews never count.
 */
export function reviewFactsOf(records: readonly ReviewRecord[], head: string, revised: boolean, sentBack: boolean): ReviewFacts {
  const newest = records.findLast((r) => r.kind !== "plan");
  if (revised || sentBack || newest?.verdict === "fail") return "wip";
  return newest && newest.verdict === "pass" && newest.occasion === "pre-pr" && head !== "" && newest.head === head ? "ok" : "unreviewed";
}

/**
 * The review facts of one PR's own head (the wiring of the PR watch, index.ts): only the records of that head count, the session-wide revision flag does not,
 * and a head in `sentBackHeads` (planstate.ts sentBackMark) is work in progress until a `[pre-pr]` PASS on that head clears it.
 */
export function reviewFactsForHead(records: readonly ReviewRecord[], head: string, sentBackHeads: readonly string[]): ReviewFacts {
  return reviewFactsOf(records.filter((r) => r.head === head), head, false, head !== "" && sentBackHeads.includes(head));
}

export interface RuleInput {
  facts: ReviewFacts;
  /** `green`: every gating check finished green, or no checks confirmed; `red`: a settled failure; else `running`. */
  checks: "green" | "red" | "running";
  /** The host says mergeable. */
  mergeable: boolean;
  /** The forge's merge state, lowercase; "" when not reported. */
  mergeState: string;
  draft: boolean;
}

/** Merge states that keep a PR from leaving draft; `blocked` and `draft` do not (a draft is blocked by definition). */
const HOLDS_DRAFT = new Set(["behind", "dirty", "unknown"]);

export interface LabelInput {
  facts: ReviewFacts;
  checks: "green" | "red" | "running";
  /** The host's mergeable value as reported. */
  mergeable: "mergeable" | "conflicting" | "unknown";
  /** The forge's merge state, lowercase; "" when not reported. */
  mergeState: string;
  draft: boolean;
  /** The host's review decision (`approved`, `changes_requested`, `review_required`); absent: the host gave none, no effect. */
  reviewDecision?: string;
}

/**
 * The ready label's target: true (on), false (off), null (no change). Off: head not reviewed or sent back, draft, failing checks, conflict, changes requested.
 * No change: checks running, mergeable or merge state unknown, behind (they pass by themselves or have their own line). Else on; `blocked` counts as on
 * (a PR that waits for a required review is the one to look at). Always needs the review facts, whatever ceremony.reviewBeforePr says.
 */
export function labelTarget(i: LabelInput): boolean | null {
  if (i.facts !== "ok" || i.draft || i.mergeState === "draft" || i.checks === "red") return false;
  if (i.mergeable === "conflicting" || i.mergeState === "dirty" || i.reviewDecision === "changes_requested") return false;
  if (i.checks === "running" || i.mergeable !== "mergeable" || i.mergeState === "unknown" || i.mergeState === "behind") return null;
  return true;
}

/**
 * The result and the draft target. `draft` is the target: true (go back to draft), false (leave draft), null (no change). A PR goes back to draft only on
 * `wip` or `unreviewed`, never because checks run or fail; it leaves draft when the rule holds apart from the draft state itself.
 */
export function readiness(i: RuleInput): { result: Readiness; draft: boolean | null } {
  if (i.facts === "wip") return { result: "wip", draft: true };
  if (i.facts === "unreviewed") return { result: "unreviewed", draft: true };
  if (i.checks === "red") return { result: "red", draft: null };
  if (i.checks === "running" || !i.mergeable || HOLDS_DRAFT.has(i.mergeState)) return { result: "running", draft: null };
  if (i.draft || i.mergeState === "blocked" || i.mergeState === "draft") return { result: "running", draft: false };
  return { result: "ready", draft: false };
}
