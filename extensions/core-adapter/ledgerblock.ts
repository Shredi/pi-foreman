// Ledger items for builders (retro-harvest item 2): a fresh builder launch whose task cites ledger
// items ("item 3", "items 1 and 2", "#5") gets their ledger text prepended, so the brief and the
// ledger cannot drift apart. No block when the task cites none or the ledger has none of them.
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

/**
 * Prepend the block to the task of every fresh builder step of a `subagent` input (single, tasks,
 * chain, parallel); a resume and the entries in `skip` (rung-up handoff) get none. Returns trace records.
 */
export function applyLedgerItems(input: Record<string, unknown>, ledger: string | null, skip: ReadonlySet<unknown> = new Set()): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (typeof input.action === "string") return out;
  const visit = (e: unknown): void => {
    if (!isObj(e)) return;
    if (e.agent === "builder" && typeof e.task === "string" && !skip.has(e)) {
      const block = ledgerItemsBlock(ledger, e.task);
      if (block) {
        e.task = block + e.task;
        out.push({ event: "ledger_block", role: "builder", chars: block.length });
      }
    }
    for (const k of ["tasks", "chain", "parallel"]) if (Array.isArray(e[k])) e[k].forEach(visit);
  };
  visit(input);
  return out;
}
