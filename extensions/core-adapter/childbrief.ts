// Roots block of a child brief (R41 Ruling), appended to the task: every fresh `subagent` step gets the Pi install root, the types path under it, the global npm root,
// the bundled package roots and the rule that whole-filesystem scans are always denied, so a child reads them directly instead of scanning for them.
// A builder step also gets the ABSOLUTE paths of the approved plan and the ledger: a managed worktree has no `.workflow/` of its own.
// Foreman side, in memory; a resume carries nothing (its task is not rewritten).
import { BUNDLED_PACKAGE_ROOTS, rootsLines } from "./orient.ts";
import type { PiRoots } from "./orient.ts";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const WORKTREE_LINE = "You run in your own worktree (your cwd). The plan and ledger above live in the foreman's checkout: read them there, never cd into or edit that checkout, and commit on your worktree's branch. Write scratch and project files with the write and edit tools at absolute paths.";

/** The block text; `plan` and `ledger` are absolute paths or null (only passed for a builder); `worktree`: the entry is launched into an isolation worktree. */
export function rootsBlock(roots: PiRoots, files: { plan?: string | null; ledger?: string | null; worktree?: boolean } = {}): string {
  const where = [...(files.plan ? [`Plan file (absolute path, readable from any directory): ${files.plan}`] : []), ...(files.ledger ? [`Ledger file (absolute path, readable from any directory): ${files.ledger}`] : [])];
  return ["[pi-foreman roots]", ...rootsLines(roots), `Bundled package roots (below the pi-foreman package root): ${BUNDLED_PACKAGE_ROOTS.map((r) => `\`${r}\``).join(", ")}.`, ...where, ...(files.worktree ? [WORKTREE_LINE] : []), "[end of roots]", ""].join("\n");
}

/** Append the roots block to the task of every step of a fresh `subagent` input (single, tasks, chain, parallel). Returns the trace records. */
export function applyRootsBlock(input: Record<string, unknown>, roots: PiRoots, files: { plan: string | null; ledger: string | null }): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (typeof input.action === "string") return out;
  const visit = (e: unknown, inherited = false): void => {
    if (!isObj(e)) return;
    const worktree = e.worktree === true || inherited;
    if (typeof e.agent === "string" && typeof e.task === "string") {
      const block = rootsBlock(roots, { ...(e.agent === "builder" ? files : {}), worktree });
      e.task = `${e.task}\n\n${block}`;
      out.push({ event: "roots_block", role: e.agent, chars: block.length });
    }
    for (const k of ["tasks", "chain", "parallel"]) if (Array.isArray(e[k])) e[k].forEach((x) => visit(x, worktree));
  };
  visit(input);
  return out;
}
