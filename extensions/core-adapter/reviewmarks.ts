// A reviewer PASS marks its items (retro-harvest item 1). The reviewer hands its per-item results over in its
// `review_verdict` record (verdict.ts): on a `pass` of a counting occasion the harness ticks each item with result `pass` that is still open in the
// ledger the review launch routed to, with no model turn, and notes each open item that carries a note. V is marked only when the launch's `items`
// field named it (verdict.ts checks that); it goes with `--verifier` under the ledger's own V rules. Each review run marks at most once,
// whether its result arrives inline (launch-wait) or as a detached completion notice.
import * as fs from "node:fs";
import { openLedgerItems, type VerdictItem } from "./verdict.ts";

export const MARK_NOTE = "verified by reviewer PASS";

// Same item line as ladder.ts / core/scripts/ledger.py ITEM_RE.
const ITEM_LINE = /^\s*[-*] \[(.)\]\s+(?:deferred:.*? — )?(\d+|V)\.(?:\s+|$)/;

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

/** True when a ledger holds an open item line (`- [ ]`, the V item included), outside ``` fences. */
export function hasOpenLedgerLine(ledger: string): boolean {
  let fenced = false;
  for (const line of ledger.split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    if (!fenced && ITEM_LINE.exec(line)?.[1] === " ") return true;
  }
  return false;
}

/** The note a record item carries for an open item (one line, at most 200 characters, as the tool checked it). */
const noteOf = (i: VerdictItem): string | null => (i.result === "open" && i.note ? i.note : null);

/**
 * Tick each open item of `items` with result `pass` through `mark` (numbers first, V last) and note each open item with a note through `note`;
 * null when there is nothing to mark or note. An item that is no longer open is skipped.
 */
export async function markPassItems(
  items: readonly VerdictItem[],
  ledgerFile: string,
  mark: (id: string) => Promise<boolean>,
  note: (id: string, text: string) => Promise<boolean> = async () => false,
): Promise<{ items: string[]; skipped: string[]; noted: string[] } | null> {
  const passed = items.filter((i) => i.result === "pass");
  const notes = items.filter((i) => noteOf(i) !== null && i.id !== "V");
  if (passed.length === 0 && notes.length === 0) return null;
  let open: { nums: number[]; v: boolean };
  try {
    open = openLedgerItems(fs.readFileSync(ledgerFile, "utf8"));
  } catch {
    open = { nums: [], v: false };
  }
  const isOpen = (id: VerdictItem["id"]): boolean => (id === "V" ? open.v : open.nums.includes(id));
  const marked: string[] = [];
  const skipped: string[] = [];
  const ordered = [...passed.filter((i) => i.id !== "V"), ...passed.filter((i) => i.id === "V")];
  for (const i of ordered) (isOpen(i.id) && (await mark(String(i.id))) ? marked : skipped).push(String(i.id));
  const noted: string[] = [];
  for (const i of notes) if (isOpen(i.id) && (await note(String(i.id), noteOf(i) ?? ""))) noted.push(String(i.id));
  return { items: marked, skipped, noted };
}
