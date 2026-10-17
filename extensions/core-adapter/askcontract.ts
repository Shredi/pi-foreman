// Ask contract for a parent that is not a Pi session (R3b point 3). When the foreman writes `<own handoff>/ask.md`
// (first line `# Ask <n>: <topic>`), the adapter touches `<handoff>/.ask` and shows the session as blocked in Herdr
// (the BlockedTracker, never `herdr agent prompt`); the parent polls `*.md` and `.ask`, answers `ruling-<n>.md`, and
// the foreman writes `.seen` (the ruling file name) after reading it, which ends the blocked state.
import * as fs from "node:fs";
import * as path from "node:path";
import { askOpen, isRulingName, NEEDS_RULING_NO_RE } from "./ruling.ts";

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

  /** A successful write/edit of `file`: "ask" (marker + signal), "seen" (signal released), "note" (ask.md with `needs_ruling: no`: no marker, no signal) or null (not ours). */
  onFileWritten(file: string): "ask" | "seen" | "note" | null {
    const base = path.basename(file);
    if (base !== ASK_FILE && base !== SEEN_FILE) return null;
    const real = realOf(file);
    const dir = path.dirname(real);
    if (!this.d.ownDirs().some((o) => realOf(path.join(o, base)) === real)) return null;
    if (base === SEEN_FILE) {
      this.sync(dir);
      return "seen";
    }
    const text = (this.d.read ?? ((f) => fs.readFileSync(f, "utf8")))(real);
    const head = text === null ? null : parseAskHeader(text);
    if (!head) return null;
    if (text !== null && NEEDS_RULING_NO_RE.test(text)) {
      this.release(dir); // an informational ask supersedes an open one: the hand never stays up for it
      return "note";
    }
    try {
      (this.d.touch ?? ((f, t) => fs.writeFileSync(f, t, "utf8")))(path.join(dir, ASK_MARKER), `ask-${head.n}\n`);
    } catch {
      // the signal below still goes out
    }
    this.release(dir);
    this.open.set(dir, this.d.block(`ask ${head.n}: ${head.topic}`));
    return "ask";
  }

  /**
   * A ruling wait woke on `file` (ruling.md / ruling-<n>.md in an own handoff dir): the harness writes `.seen`
   * (the ruling file name) itself, then recomputes the blocked state. Idempotent with a `.seen` the child wrote.
   */
  onRulingWake(file: string): boolean {
    const name = path.basename(file);
    if (!isRulingName(name)) return false;
    const real = realOf(file);
    const dir = path.dirname(real);
    if (!this.d.ownDirs().some((o) => realOf(path.join(o, name)) === real)) return false;
    const seen = path.join(dir, SEEN_FILE);
    try {
      let have = "";
      try {
        have = fs.readFileSync(seen, "utf8").trim();
      } catch {
        // no .seen yet
      }
      if (have !== name) fs.writeFileSync(seen, `${name}\n`, "utf8");
    } catch {
      return false;
    }
    this.sync(dir);
    return true;
  }

  /** Recompute the blocked state of every own handoff dir with an `.ask` (a `.seen` may have been written by bash). */
  recheck(): void {
    for (const o of this.d.ownDirs()) {
      const dir = path.dirname(realOf(path.join(o, ASK_MARKER)));
      if (this.open.has(dir) || fs.existsSync(path.join(dir, ASK_MARKER))) this.sync(dir);
    }
  }

  /** Release every open ask signal (session shutdown). */
  releaseAll(): void {
    for (const dir of [...this.open.keys()]) this.release(dir);
  }

  /** Blocked = `.ask` present and no `.seen` naming its ruling (ruling.ts askOpen); never a sticky flag. */
  private sync(dir: string): void {
    if (!askOpen(dir)) return this.release(dir);
    if (this.open.has(dir)) return;
    let n = "?";
    let topic = "";
    try {
      n = fs.readFileSync(path.join(dir, ASK_MARKER), "utf8").trim().replace(/^ask-/, "") || n;
      topic = parseAskHeader(fs.readFileSync(path.join(dir, ASK_FILE), "utf8"))?.topic ?? "";
    } catch {
      // label only
    }
    this.open.set(dir, this.d.block(`ask ${n}${topic ? `: ${topic}` : ""}`));
  }

  private release(dir: string): void {
    const r = this.open.get(dir);
    this.open.delete(dir);
    r?.();
  }
}
