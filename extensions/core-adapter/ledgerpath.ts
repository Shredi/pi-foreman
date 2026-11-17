// A launch task that names a ledger by path (D31): `.workflow/LEDGER-<topic>.md`, relative to the launch cwd or absolute.
// The named ledger drives the items block, the roots block, the PASS marks and the ledger hints of that launch; no
// path (or a path that cannot be used) leaves the session-bound ledger in charge.
import fs from "node:fs";
import path from "node:path";
import { isLedgerTarget, isLiveLedgerName } from "./marker.ts";

export interface TaskLedger {
  /** The ledger path in charge for the task; null when there is none at all. */
  path: string | null;
  /** True when the task named it. */
  named: boolean;
  /** Why a path the task names was not used. */
  notice?: string;
}

const PATH_RE = /[^\s`'"()<>[\]]*\.workflow\/[A-Za-z0-9._-]+\.md/g;

const real = (p: string): string | null => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

/** The ledger a task names (see above); `bound` is the session-bound ledger, `checkouts` the dirs whose `.workflow/` may hold one. */
export function taskLedger(task: string, cwd: string, bound: string | null, checkouts: readonly string[]): TaskLedger {
  const named = [...new Set([...task.matchAll(PATH_RE)].map((m) => m[0]).filter((p) => isLiveLedgerName(path.basename(p))))];
  if (named.length === 0) return { path: bound, named: false };
  const fallback = (reason: string): TaskLedger => ({ path: bound, named: false, notice: `ledger path not used: ${reason}` });
  const found = new Map<string, string>();
  for (const p of named) {
    const abs = path.resolve(cwd, p);
    const r = real(abs);
    if (r === null) return fallback(`${p} does not exist`);
    found.set(r, abs);
  }
  if (found.size > 1) return fallback("the task names more than one ledger");
  const [[r, abs]] = [...found];
  if (!isLedgerTarget(abs)) return fallback(`${path.basename(abs)} is not a ledger in a .workflow directory`);
  const boundReal = bound ? real(bound) : null;
  const dirs = [...checkouts, ...(bound ? [path.dirname(path.dirname(bound))] : [])].map((d) => real(path.join(d, ".workflow"))).filter((d): d is string => d !== null);
  // the resolved path, so a symlink swapped after this check cannot redirect a later write
  if (r === boundReal) return { path: bound, named: true };
  if (dirs.includes(path.dirname(r))) return { path: r, named: true };
  return fallback("it is not in the .workflow directory of this checkout or of the bound ledger");
}
