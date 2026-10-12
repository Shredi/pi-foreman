// Ask contract for a parent that is not a Pi session (R3b point 3). When the foreman writes `<own handoff>/ask.md`
// (first line `# Ask <n>: <topic>`), the adapter touches `<handoff>/.ask` and shows the session as blocked in Herdr
// (the BlockedTracker, never `herdr agent prompt`); the parent polls `*.md` and `.ask`, answers `ruling-<n>.md`, and
// the foreman writes `.seen` (the ruling file name) after reading it, which ends the blocked state.
import * as fs from "node:fs";
import * as path from "node:path";

export const ASK_FILE = "ask.md";
export const ASK_MARKER = ".ask";
export const SEEN_FILE = ".seen";
const ASK_HEADER_RE = /^# Ask (\d{1,6}): (\S.*)$/;

/** `# Ask <n>: <topic>` on the first line of ask.md; null for anything else. */
export function parseAskHeader(text: string): { n: number; topic: string } | null {
  const m = ASK_HEADER_RE.exec(text.split(/\r?\n/, 1)[0].trim());
  return m ? { n: Number(m[1]), topic: m[2].trim() } : null;
}

export interface AskDeps {
  /** This session's own handoff dirs (owned.ts ownHandoffDirs). */
  ownDirs: () => string[];
  /** Open a blocked source with `label`; returns its idempotent release. */
  block: (label: string) => () => void;
  read?: (file: string) => string | null;
  touch?: (file: string, text: string) => void;
}

const realOf = (p: string): string => {
  try {
    return path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p));
  } catch {
    return path.resolve(p);
  }
};

export class AskContract {
  private readonly open = new Map<string, () => void>();
  private readonly d: AskDeps;

  constructor(d: AskDeps) {
    this.d = d;
  }

  /** A successful write/edit of `file`: "ask" (marker + signal), "seen" (signal released) or null (not ours). */
  onFileWritten(file: string): "ask" | "seen" | null {
    const base = path.basename(file);
    if (base !== ASK_FILE && base !== SEEN_FILE) return null;
    const real = realOf(file);
    const dir = path.dirname(real);
    if (!this.d.ownDirs().some((o) => realOf(path.join(o, base)) === real)) return null;
    if (base === SEEN_FILE) {
      this.release(dir);
      return "seen";
    }
    const text = (this.d.read ?? ((f) => fs.readFileSync(f, "utf8")))(real);
    const head = text === null ? null : parseAskHeader(text);
    if (!head) return null;
    try {
      (this.d.touch ?? ((f, t) => fs.writeFileSync(f, t, "utf8")))(path.join(dir, ASK_MARKER), `ask-${head.n}\n`);
    } catch {
      // the signal below still goes out
    }
    this.release(dir);
    this.open.set(dir, this.d.block(`ask ${head.n}: ${head.topic}`));
    return "ask";
  }

  /** Release every open ask signal (session shutdown). */
  releaseAll(): void {
    for (const dir of [...this.open.keys()]) this.release(dir);
  }

  private release(dir: string): void {
    const r = this.open.get(dir);
    this.open.delete(dir);
    r?.();
  }
}
