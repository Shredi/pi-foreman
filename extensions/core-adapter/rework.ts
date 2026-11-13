// The send-back marker (docs/review.md): `foreman session brief <label> <path> --rework` makes the side that writes the delivered brief also
// write an empty file `rework-<k>` beside it in the child's handoff dir (k: the markers' own sequence, foreman_session.py new_rework, session.ts
// writeRework). The child scans for it (index.ts reworkScan); no brief text is read. A forged marker can only move a PR toward draft.
import * as fs from "node:fs";
import * as path from "node:path";

const REWORK_RE = /^rework-([1-9]\d{0,2})$/;

/** The highest `rework-<k>` regular file in `dir` (k at most 999), 0 when there is none or the dir is unreadable. */
export function highestRework(dir: string): number {
  let top = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const k = REWORK_RE.exec(name)?.[1];
    if (k === undefined || Number(k) <= top) continue;
    try {
      if (fs.lstatSync(path.join(dir, name)).isFile()) top = Number(k);
    } catch {
      // gone meanwhile
    }
  }
  return top;
}
