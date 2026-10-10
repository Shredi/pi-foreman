// A reviewer PASS marks its items (retro-harvest item 1). The reviewer's output contract
// (agents/reviewer.md) has one `N. PASS|FAIL <evidence>` line per ledger item; on an overall PASS
// of a `reviewer` run (never `senior-reviewer`, whose APPROVE/BLOCK verdict is not per item) the
// harness ticks each `N. PASS` item that is still open in the foreman's bound ledger, with no model
// turn. V is never marked here: it stays with the fresh verifier. Each review run marks at most
// once, whether its result arrives inline (launch-wait) or as a detached completion notice.
import * as fs from "node:fs";
import { completedAgents, verdictOf } from "./rounds.ts";
import { noticeRuns } from "./launchwait.ts";

export const MARK_NOTE = "verified by reviewer PASS";

// Same item line as ladder.ts / core/scripts/ledger.py ITEM_RE.
const ITEM_LINE = /^\s*[-*] \[(.)\]\s+(?:deferred:.*? — )?(\d+|V)\.(?:\s+|$)/;

/** A line without leading decoration: list markers (`-`, `*`), backticks and bold (`**`), in any mix. */
export function stripLineDecoration(line: string): string {
  return line.replace(/^(?:\s+|[-*]\s+|`+|\*\*+|__)+/, "");
}

/**
 * Item numbers of the review's per-item `N. <word>` lines (word PASS or FAIL), in order, without
 * repeats. Each line may carry decoration (`- 1. PASS`, `**1. PASS**`, `` `1. PASS` ``, `1) PASS`)
 * and the doubled bench form "1. `1. PASS`". Lines inside ``` fences and `PASSED` do not count.
 */
export function verdictItemsOf(text: string, word: "PASS" | "FAIL"): string[] {
  const out: string[] = [];
  let fenced = false;
  const re = new RegExp(`^${word}\\b`);
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    let rest = stripLineDecoration(line);
    let n: string | null = null;
    // one number, or two (outside and inside the backticks): the inner one counts
    for (let i = 0; i < 2; i++) {
      const m = /^(\d+)[.)]\s*/.exec(rest);
      if (!m) break;
      n = m[1];
      rest = stripLineDecoration(rest.slice(m[0].length));
    }
    if (n !== null && re.test(rest)) out.push(String(Number(n)));
  }
  return [...new Set(out)];
}

/** Item numbers of the review's per-item `N. PASS` lines, in order, without repeats. */
export function passItemsOf(text: string): string[] {
  return verdictItemsOf(text, "PASS");
}

/** Numbered items that are open (`- [ ]`) in a ledger, outside ``` fences. */
export function openItemsOf(ledger: string): Set<string> {
  const open = new Set<string>();
  let fenced = false;
  for (const line of ledger.split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    const m = fenced ? null : ITEM_LINE.exec(line);
    if (m && m[1] === " " && m[2] !== "V") open.add(String(Number(m[2])));
  }
  return open;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

/** The output of the completed `reviewer` results with an overall PASS in a run-end event ("" = none). */
export function reviewerPassOfRunEnd(data: unknown): string {
  if (!isObj(data)) return "";
  const results = Array.isArray(data.results) && data.results.length > 0 ? data.results : [data];
  const out: string[] = [];
  for (const r of results) {
    if (!isObj(r)) continue;
    const role = typeof r.agent === "string" ? r.agent : typeof data.agent === "string" ? data.agent : "";
    if (role !== "reviewer") continue;
    const completed = (r.status === undefined ? r.success === true : r.status === "completed") && r.success !== false && r.timedOut !== true && r.stopped !== true && !r.error;
    const text = [r.output, r.summary].filter((t): t is string => typeof t === "string").join("\n");
    if (completed && verdictOf(text) === "pass") out.push(text);
  }
  return out.join("\n");
}

/** A completion notice of exactly one `reviewer` run with an overall PASS: its run id and text, else null. */
export function reviewerPassOfNotice(text: string): { runId: string; text: string } | null {
  const agents = completedAgents(text);
  const runs = noticeRuns(text);
  if (agents.length !== 1 || agents[0] !== "reviewer" || !runs || runs.ids.length !== 1 || verdictOf(text) !== "pass") return null;
  return { runId: runs.ids[0], text };
}

/** Tick each open `N. PASS` item of `text` through `mark`; null when the review names no PASS item. */
export async function markPassItems(text: string, ledgerFile: string, mark: (n: string) => Promise<boolean>): Promise<{ items: string[]; skipped: string[] } | null> {
  const wanted = passItemsOf(text);
  if (wanted.length === 0) return null;
  let open: Set<string>;
  try {
    open = openItemsOf(fs.readFileSync(ledgerFile, "utf8"));
  } catch {
    open = new Set();
  }
  const items: string[] = [];
  const skipped: string[] = [];
  for (const n of wanted) (open.has(n) && (await mark(n)) ? items : skipped).push(n);
  return { items, skipped };
}
