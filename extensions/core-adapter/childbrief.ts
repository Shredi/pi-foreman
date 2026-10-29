// Roots block of a child brief (R41 Ruling), appended to the task: every fresh `subagent` step gets the Pi install root, the types path under it, the global npm root,
// the bundled package roots and the rule that whole-filesystem scans are always denied, so a child reads them directly instead of scanning for them.
// A builder step also gets the ABSOLUTE paths of the approved plan and the ledger: a managed worktree has no `.workflow/` of its own.
// Foreman side, in memory; a resume carries nothing (its task is not rewritten).
import { BUNDLED_PACKAGE_ROOTS, rootsLines } from "./orient.ts";
import type { PiRoots } from "./orient.ts";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The block text; `plan` and `ledger` are absolute paths or null (only passed for a builder). */
export function rootsBlock(roots: PiRoots, files: { plan?: string | null; ledger?: string | null } = {}): string {
  const where = [...(files.plan ? [`Plan file (absolute path, readable from any directory): ${files.plan}`] : []), ...(files.ledger ? [`Ledger file (absolute path, readable from any directory): ${files.ledger}`] : [])];
  return ["[pi-foreman roots]", ...rootsLines(roots), `Bundled package roots (below the pi-foreman package root): ${BUNDLED_PACKAGE_ROOTS.map((r) => `\`${r}\``).join(", ")}.`, ...where, "[end of roots]", ""].join("\n");
}

/** Append the roots block to the task of every step of a fresh `subagent` input (single, tasks, chain, parallel). Returns the trace records. */
export function applyRootsBlock(input: Record<string, unknown>, roots: PiRoots, files: { plan: string | null; ledger: string | null }): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (typeof input.action === "string") return out;
  const visit = (e: unknown): void => {
    if (!isObj(e)) return;
    if (typeof e.agent === "string" && typeof e.task === "string") {
      const block = rootsBlock(roots, e.agent === "builder" ? files : {});
      e.task = `${e.task}\n\n${block}`;
      out.push({ event: "roots_block", role: e.agent, chars: block.length });
    }
    for (const k of ["tasks", "chain", "parallel"]) if (Array.isArray(e[k])) e[k].forEach(visit);
  };
  visit(input);
  return out;
}
