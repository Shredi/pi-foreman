// Ruling files of the ask contract (R6 lane 4): `ruling-<n>.md` / `ruling.md` next to an `ask.md` in a handoff dir.
// Pure file-state helpers: the harness writes `.seen` when a ruling wait wakes, the blocked state is recomputed from
// the files, a ruling older than its ask is ignored, and a parent ruling `APPROVED` / `SHIP` counts as a verdict.
import * as fs from "node:fs";
import * as path from "node:path";

const RULING_RE = /^ruling(?:-(\d{1,6}))?\.md$/;
const ASK_N_RE = /^ask-(\d{1,6})\s*$/;

/** True for a `ruling.md` / `ruling-<n>.md` file name. */
export const isRulingName = (name: string): boolean => RULING_RE.test(name);

const mtimeOf = (p: string): number | null => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
};

const readText = (p: string): string | null => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

/** A ruling file the wait may wake on: not older than the `ask.md` beside it (no ask.md, or no mtime = fresh). */
export function rulingFresh(file: string, mtime: (p: string) => number | null = mtimeOf): boolean {
  if (!isRulingName(path.basename(file))) return true;
  const ask = mtime(path.join(path.dirname(file), "ask.md"));
  const ruling = mtime(file);
  return ask === null || ruling === null || ruling >= ask;
}

/**
 * The ask in `dir` is unanswered: `.ask` is present and `.seen` does not name its ruling (`ruling-<n>.md` for
 * `ask-<n>`, or `ruling.md`; with no number in `.ask`, any `.seen` ends it). Never a stored flag.
 */
export function askOpen(dir: string): boolean {
  const ask = readText(path.join(dir, ".ask"));
  if (ask === null) return false;
  const seen = readText(path.join(dir, ".seen"));
  if (seen === null) return true;
  const named = seen.trim();
  const n = ASK_N_RE.exec(ask.trim())?.[1];
  if (n === undefined) return false;
  return !(named === `ruling-${Number(n)}.md` || named === "ruling.md");
}

/**
 * A parent ruling in `dirs` (`ruling.md` / `ruling-<n>.md`, first line `APPROVED` or `SHIP`) whose mtime is newer than
 * `afterMs` (the last FAIL verdict) counts as a verdict for the finish gate. Returns its path, or null.
 */
export function parentApproval(dirs: string[], afterMs: number): string | null {
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter(isRulingName);
    } catch {
      continue;
    }
    for (const n of names) {
      const m = mtimeOf(path.join(dir, n));
      if (m === null || m <= afterMs) continue;
      const first = (readText(path.join(dir, n)) ?? "").split(/\r?\n/, 1)[0].trim();
      if (first === "APPROVED" || first === "SHIP") return path.join(dir, n);
    }
  }
  return null;
}

/** What `/foreman close` adds when the ceremony is incomplete: what the parent would have to rule. */
export function rulingNeeded(missing: string[]): string {
  return missing.length === 0
    ? ""
    : `Missing: ${missing.join(", ")}. The parent can rule it done with ruling.md (or ruling-<n>.md) in the handoff dir whose first line is APPROVED or SHIP, newer than the last FAIL; the owner/chair override is /ceremony <tier>.`;
}
