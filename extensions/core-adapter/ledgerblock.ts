// Ledger items for builders (retro-harvest item 2): a fresh builder launch whose task cites ledger
// items ("item 3", "items 1 and 2", "#5") gets their ledger text prepended, so the brief and the
// ledger cannot drift apart. No block when the task cites none or the ledger has none of them.
// A reviewer or senior-reviewer entry gets the same prefix, or the whole ledger text when its task
// cites no item: the ledger is the scope source of a review (docs/review.md).
// The binding is the session marker, so a review launched with cwd = a worktree gets it too.
// The rung-up path already carries the same lines in its handoff (ladder.ts handoffBlock), so an
// entry that gets a handoff is skipped. Foreman side, in memory.
import { ledgerLines } from "./ladder.ts";

const CITES = /\bitems?\s+(?:\d+|V)\b|#\d+\b/i;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The block for `task`, or "" when it cites no ledger item that exists. */
export function ledgerItemsBlock(ledger: string | null, task: string): string {
  if (!CITES.test(task)) return "";
  const lines = ledgerLines(ledger, task);
  if (lines.length === 0) return "";
  return ["[pi-foreman ledger items] The ledger text of the items this task cites; it is the contract.", ...lines, "[end of ledger items]", ""].join("\n");
}

const REVIEW_AGENTS = new Set(["reviewer", "senior-reviewer"]);

/** The block of a review task: the cited items, else the whole ledger (header and items); "" without a ledger. */
export function reviewLedgerBlock(ledger: string | null, task: string): string {
  const cited = ledgerItemsBlock(ledger, task);
  if (cited) return cited;
  if (!ledger || !ledger.trim()) return "";
  return ["[pi-foreman ledger] The ledger of this round; a fact is in scope only when an item asks for it.", ledger.trim(), "[end of ledger]", ""].join("\n");
}

/**
 * Prepend the block to the task of every fresh builder, reviewer and senior-reviewer step of a `subagent` input (single, tasks,
 * chain, parallel); a resume and the entries in `skip` (rung-up handoff) get none. Returns trace records.
 */
export function applyLedgerItems(input: Record<string, unknown>, ledger: string | null, skip: ReadonlySet<unknown> = new Set()): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (typeof input.action === "string") return out;
  const visit = (e: unknown): void => {
    if (!isObj(e)) return;
    const role = typeof e.agent === "string" && (e.agent === "builder" || REVIEW_AGENTS.has(e.agent)) ? e.agent : null;
    if (role && typeof e.task === "string" && !skip.has(e)) {
      const block = role === "builder" ? ledgerItemsBlock(ledger, e.task) : reviewLedgerBlock(ledger, e.task);
      if (block) {
        e.task = block + e.task;
        out.push({ event: "ledger_block", role, chars: block.length });
      }
    }
    for (const k of ["tasks", "chain", "parallel"]) if (Array.isArray(e[k])) e[k].forEach(visit);
  };
  visit(input);
  return out;
}
