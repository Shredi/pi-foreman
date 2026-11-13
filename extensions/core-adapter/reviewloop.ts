// Loop guard (docs/ceremony.md "Loop guard"): reviews run until clean, with no count. A review round is recorded with a
// `state` (what was reviewed: the working tree of the review's checkout, or the plan version) and a `sig` (the
// deterministic finding set of its report). A FAIL round stops the loop when, against the round before of the same kind:
//   repeat:  the sig is non-empty and equal, or
//   stalled: the state is unchanged (no diff) and the sig brings nothing new (a subset).
// A PASS restarts the comparison; a FAIL with an empty sig fires nothing (there is nothing to compare). The stop
// (`LoopStop`) refuses builder and reviewer launches (index.ts) until an owner prompt, a parent ruling or brief, or a
// `/ceremony` tier change clears it.
// Plan reviews (`loopVerdictOf`): an equal set across two different plan versions is a repeat only when it holds an `at:` key; an
// unknown state ("") equals only another unknown state. A session with a parent gets `loopRefusalParented` instead of `loopRefusal`.
import { failedItemsOf } from "./costguard.ts";
import type { PanelFinding } from "./panel.ts";
import type { Verdict } from "./rounds.ts";

export type ReviewKind = "plan" | "code";
export type LoopRule = "repeat" | "stalled";

/** One counting review round as the guard sees it (the loop part of a ReviewRecord). */
export interface LoopRound {
  verdict: Verdict;
  /** Hash of what was reviewed; "" = unknown (never equal to another state). */
  state: string;
  /** Sorted, de-duplicated finding keys of the report; empty for a PASS. */
  sig: readonly string[];
}

export interface LoopStop {
  rule: LoopRule;
  kind: ReviewKind;
  sig: string[];
}

/** The located finding's key: the `finding_id` triple of scripts/foreman_findings.py (file, line // 5, class); the note is not part of it. */
export const findingKey = (f: PanelFinding): string => `at:${f.file}:${f.line === null ? "-" : Math.floor(f.line / 5)}:${f.class}`;

/** The finding set of a FAIL report: `item:<N>` per `N. FAIL` line, `at:<file>:<line/5>:<class>` per located finding. [] for anything but a FAIL. */
export function sigOf(text: string, findings: readonly PanelFinding[]): string[] {
  const items = failedItemsOf(text);
  if (items.length === 0 && findings.length === 0) return [];
  return [...new Set([...items.map((n) => `item:${n}`), ...findings.map(findingKey)])].sort();
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
  return `pi-foreman: launch refused [review_loop]: ${why} (${stop.sig.join(", ")}). Stop and report the open findings, then ask the owner with ask_user_question (an answer lifts this stop) or wait for a new prompt. A parent ruling or brief, or a /ceremony tier change, also lifts this; a [second-opinion] review is still allowed.`;
}

/** `loopVerdict` per review kind. A plan review that fails again on a revised plan (a new plan version) with only `item:<N>` keys in common is not a repeat: new findings under the same ledger item are progress. A located key (`at:`) in the set still stops it. Code reviews and same-version plan rounds are `loopVerdict` unchanged. */
export function loopVerdictOf(kind: ReviewKind, prev: LoopRound | null, cur: LoopRound): LoopRule | null {
  const rule = loopVerdict(prev, cur);
  if (kind === "plan" && rule === "repeat" && prev && cur.state !== prev.state && !cur.sig.some((k) => k.startsWith("at:"))) return null;
  return rule;
}

/** The `[review_loop]` refusal text in a session a parent opened: the open findings go to the parent by file; the owner is asked only for a decision of theirs. */
export function loopRefusalParented(stop: LoopStop): string {
  const what = stop.kind === "plan" ? "plan" : "work";
  const why = stop.rule === "repeat" ? `the last two ${stop.kind} review rounds failed with the same findings` : `the last ${stop.kind} review failed again with no new finding and no change to the ${what} since the round before`;
  return `pi-foreman: launch refused [review_loop]: ${why} (${stop.sig.join(", ")}). Stop and report the open findings to the parent by file (ask.md in the handoff dir) and wait for its ruling, which lifts this stop. Ask the owner with ask_user_question only when a finding needs the owner's decision (an answer lifts this stop too). A parent brief, a new owner prompt, or a /ceremony tier change also lifts this; a [second-opinion] review is still allowed.`;
}
