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
  /** The ledger is the one of the launch's own checkout, not the session-bound one (D171); the route of the launch keeps it like a named path. */
  viaCheckout?: boolean;
}

// Either separator: a Windows foreman names the ledger with backslashes (and a drive letter).
const PATH_RE = /[^\s`'"()<>[\]]*\.workflow[\\/][A-Za-z0-9._-]+\.md/g;

/** The distinct `.workflow/LEDGER-*.md` paths a task text names, in either separator style. */
export function namedLedgerPaths(task: string): string[] {
  const base = (p: string): string => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
  return [...new Set([...task.matchAll(PATH_RE)].map((m) => m[0]).filter((p) => isLiveLedgerName(base(p))))];
}

/** Path equality for resolved paths: case-insensitive on win32 (drive letter and names), exact elsewhere. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const real = (p: string): string | null => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

/**
 * The ledger of a launch's own checkout (D171), when the task names none: the session-bound ledger when it lies in that checkout's `.workflow/`; else the only live
 * `LEDGER-*.md` there; else the session-bound one. `checkout` is the git top level of the launch's directory (null = unknown: the session-bound one).
 */
function checkoutLedger(bound: string | null, checkout: string | null): TaskLedger {
  const own: TaskLedger = { path: bound, named: false };
  const dir = checkout ? real(path.join(checkout, ".workflow")) : null;
  if (dir === null) return own;
  const boundReal = bound ? real(bound) : null;
  if (boundReal !== null && samePath(path.dirname(boundReal), dir)) return own;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter(isLiveLedgerName);
  } catch {
    return own;
  }
  if (names.length !== 1) return own;
  const r = real(path.join(dir, names[0]));
  return r !== null && isLedgerTarget(r) ? { path: r, named: false, viaCheckout: true } : own;
}

/** The ledger a task names (see above); `bound` is the session-bound ledger, `checkouts` the dirs whose `.workflow/` may hold one, `checkout` the launch's own checkout (D171; none named: its ledger, else the bound one). */
export function taskLedger(task: string, cwd: string, bound: string | null, checkouts: readonly string[], checkout: string | null = null): TaskLedger {
  const named = namedLedgerPaths(task);
  if (named.length === 0) return checkoutLedger(bound, checkout);
  const fallback = (reason: string): TaskLedger => ({ ...checkoutLedger(bound, checkout), notice: `ledger path not used: ${reason}` });
  const found = new Map<string, [string, string]>();
  for (const p of named) {
    const abs = path.resolve(cwd, p);
    const r = real(abs);
    if (r === null) return fallback(`${p} does not exist`);
    found.set(process.platform === "win32" ? r.toLowerCase() : r, [abs, r]);
  }
  if (found.size > 1) return fallback("the task names more than one ledger");
  const [[abs, r]] = [...found.values()];
  if (!isLedgerTarget(abs)) return fallback(`${path.basename(abs)} is not a ledger in a .workflow directory`);
  const boundReal = bound ? real(bound) : null;
  const dirs = [...checkouts, ...(bound ? [path.dirname(path.dirname(bound))] : [])].map((d) => real(path.join(d, ".workflow"))).filter((d): d is string => d !== null);
  // the resolved path, so a symlink swapped after this check cannot redirect a later write
  if (boundReal !== null && samePath(r, boundReal)) return { path: bound, named: true };
  if (dirs.some((d) => samePath(d, path.dirname(r)))) return { path: r, named: true };
  return fallback("it is not in the .workflow directory of this checkout or of the bound ledger");
}
