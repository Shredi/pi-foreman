// Loop guard (docs/ceremony.md "Loop guard"): reviews run until clean, with no count. A review round is recorded with a
// `state` (what was reviewed: the working tree of the review's checkout, or the plan version) and a `sig` (the
// deterministic finding set of its report). A FAIL round stops the loop when, against the round before of the same kind:
//   repeat:  the sig is non-empty and equal, or
//   stalled: the state is unchanged (no diff) and the sig brings nothing new (a subset).
// A PASS restarts the comparison; a FAIL with an empty sig fires nothing (there is nothing to compare). The stop
// (`LoopStop`) refuses builder and reviewer launches (index.ts) until an owner prompt, an answered ask_user_question, a parent brief,
// or a `/ceremony` tier change clears it.
// Code reviews (`loopVerdictOf`): an item-only repeat (no `at:` key) is not a repeat when both rounds carry a `work` count that grew and the known state changed.
// Plan reviews (`loopVerdictOf`): an equal set across two different plan versions is a repeat only when it holds an `at:` key; an
// unknown state ("") equals only another unknown state. A session with a parent gets `loopRefusalParented` instead of `loopRefusal`.
import type { Verdict } from "./rounds.ts";
import { defectsOf, failedItemIds, type VerdictFinding, type VerdictItem } from "./verdict.ts";

export type ReviewKind = "plan" | "code";
export type LoopRule = "repeat" | "stalled";

/** One counting review round as the guard sees it (the loop part of a ReviewRecord). */
export interface LoopRound {
  verdict: Verdict;
  /** Hash of what was reviewed; "" = unknown (never equal to another state). */
  state: string;
  /** Sorted, de-duplicated finding keys of the report; empty for a PASS. */
  sig: readonly string[];
  /** Foreman work count (`s.work.builders + s.work.edits`) when the round was recorded; absent in a record from before it. */
  work?: number;
}

export interface LoopStop {
  rule: LoopRule;
  kind: ReviewKind;
  sig: string[];
}

/** The located finding's key: the `finding_id` triple of scripts/foreman_findings.py (file, line // 5, class); the note is not part of it. A line gives `-`, an absent class `""`. */
export const findingKey = (f: { file: string; line: number | null; class: string }): string => `at:${f.file}:${f.line === null ? "-" : Math.floor(f.line / 5)}:${f.class}`;

/** The finding set of a FAIL record: `item:<N>` per failed item, `at:<file>:<line/5>:<class>` per `defect` finding that names a file (advice kinds and a finding without a file give no key). */
export function sigOf(items: readonly VerdictItem[], findings: readonly VerdictFinding[]): string[] {
  const keys = defectsOf(findings).flatMap((f) => (f.file ? [findingKey({ file: f.file, line: f.line ?? null, class: f.class ?? "" })] : []));
  return [...new Set([...failedItemIds(items).map((n) => `item:${n}`), ...keys])].sort();
}

/** The rule a FAIL round `cur` trips against the round before it of the same kind (`prev`, null = none), or null. */
export function loopVerdict(prev: LoopRound | null, cur: LoopRound): LoopRule | null {
  if (cur.verdict !== "fail" || !prev || prev.verdict !== "fail" || cur.sig.length === 0) return null;
  const before = new Set(prev.sig);
  if (cur.sig.length === before.size && cur.sig.every((x) => before.has(x))) return "repeat";
  if (cur.state !== "" && cur.state === prev.state && cur.sig.every((x) => before.has(x))) return "stalled";
  return null;
}

/** The `[review_loop]` refusal text of a launch while a stop is set. */
export function loopRefusal(stop: LoopStop): string {
  const what = stop.kind === "plan" ? "plan" : "work";
  const why = stop.rule === "repeat" ? `the last two ${stop.kind} review rounds failed with the same findings` : `the last ${stop.kind} review failed again with no new finding and no change to the ${what} since the round before`;
  return `pi-foreman: launch refused [review_loop]: ${why} (${stop.sig.join(", ")}). Stop and report the open findings, then ask the owner with ask_user_question (an answer lifts this stop) or wait for a new prompt. A parent brief, or a /ceremony tier change, also lifts this; a review with occasion second-opinion is still allowed.`;
}

/** `loopVerdict` per review kind. A plan review that fails again on a revised plan (a new plan version) with only `item:<N>` keys in common is not a repeat: new findings under the same ledger item are progress. A located key (`at:`) in the set still stops it. A code review's item-only repeat is progress too when work (builder runs or project edits) happened between the two rounds and the reviewed state changed; a located key, no work, or an unchanged or unknown state still stops it. Same-version plan rounds are `loopVerdict` unchanged. */
export function loopVerdictOf(kind: ReviewKind, prev: LoopRound | null, cur: LoopRound): LoopRule | null {
  const rule = loopVerdict(prev, cur);
  if (kind === "code" && rule === "repeat" && prev && !cur.sig.some((k) => k.startsWith("at:")) && prev.work !== undefined && cur.work !== undefined && cur.work > prev.work && cur.state !== "" && prev.state !== "" && cur.state !== prev.state) return null;
  if (kind === "plan" && rule === "repeat" && prev && cur.state !== prev.state && !cur.sig.some((k) => k.startsWith("at:"))) return null;
  return rule;
}

/**
 * The `[review_loop]` refusal text in a session a parent opened: the open findings go to the parent in a message, and a brief lifts the stop; the owner is asked
 * only for a decision of theirs. `byFile`: intercom cannot reach the parent (a remote parent, `PI_FOREMAN_REMOTE_PARENT=1`): the findings go in `ask.md` and the parent's brief answers.
 */
export function loopRefusalParented(stop: LoopStop, byFile = false): string {
  const what = stop.kind === "plan" ? "plan" : "work";
  const why = stop.rule === "repeat" ? `the last two ${stop.kind} review rounds failed with the same findings` : `the last ${stop.kind} review failed again with no new finding and no change to the ${what} since the round before`;
  if (byFile) return `pi-foreman: launch refused [review_loop]: ${why} (${stop.sig.join(", ")}). Stop and report the open findings to the parent by file (ask.md in the handoff dir), say so at your pane and end your turn: the parent's brief answers it and lifts this stop; a ruling-<n>.md does not. Ask the owner with ask_user_question only when a finding needs the owner's decision (an answer lifts this stop too). A new owner prompt or a /ceremony tier change also lifts this; a review with occasion second-opinion is still allowed.`;
  return `pi-foreman: launch refused [review_loop]: ${why} (${stop.sig.join(", ")}). Stop, report the open findings to the parent in an intercom message whose first line starts with Question, and end your turn: the parent lifts this stop with a brief; a message does not, and neither does a ruling-<n>.md. If intercom cannot reach the parent (it is not a Pi session, or the send says Session not found), report by file (ask.md in the handoff dir), say so at your pane and end your turn: the parent's brief answers it and lifts the stop. Ask the owner with ask_user_question only when a finding needs the owner's decision (an answer lifts this stop too). A new owner prompt or a /ceremony tier change also lifts this; a review with occasion second-opinion is still allowed.`;
}
