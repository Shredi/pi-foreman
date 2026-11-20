// The one rule for a session's own `ask.md` (docs/sessions.md): where intercom cannot reach the parent, `ask.md` in the own handoff dir is the
// message and a brief is the answer. The ask is open when the dir holds an `ask.md` newer than every answer file (ruling.ts `isAnswerFile`)
// and whose version (its mtime) is not remembered as answered at the pane. Open sets one blocked source, not open releases it. No marker file:
// the state is recomputed from the files and two in-memory sets.
import * as fs from "node:fs";
import * as path from "node:path";
import { parseAskHeader } from "./childask.ts";
import { answerNewerThan } from "./ruling.ts";

export const OWN_ASK_FILE = "ask.md";

export interface OwnAskDeps {
  /** This session's own handoff dirs. */
  dirs: () => string[];
  /** Open the blocked source with `label`; returns its idempotent release. */
  block: (label: string) => () => void;
}

interface Version {
  key: string;
  label: string;
}

export class OwnAsk {
  private release: (() => void) | null = null;
  private openKey: string | null = null;
  /** `<dir>\0<mtime>` of the ask.md versions answered at the pane. */
  private readonly answered = new Set<string>();
  /** The versions that already set `waitingForParent`. */
  private readonly flagged = new Set<string>();
  private readonly d: OwnAskDeps;

  constructor(d: OwnAskDeps) {
    this.d = d;
  }

  /** The first own `ask.md` that is open by the rule, or null. */
  private find(): Version | null {
    for (const dir of this.d.dirs()) {
      try {
        const file = path.join(dir, OWN_ASK_FILE);
        const m = fs.statSync(file).mtimeMs;
        const key = `${dir}\0${m}`;
        if (this.answered.has(key) || answerNewerThan(dir, m, true)) continue;
        const head = parseAskHeader(fs.readFileSync(file, "utf8"));
        return { key, label: head ? `ask ${head.n}: ${head.topic}` : "ask" };
      } catch {
        // no ask.md, or an unreadable dir: not open
      }
    }
    return null;
  }

  /** Recompute from the files; sets or releases the blocked source. `fresh` is true when this call found a version that has not set the flag yet. */
  evaluate(): { open: boolean; fresh: boolean } {
    const v = this.find();
    if (!v) {
      this.drop();
      return { open: false, fresh: false };
    }
    if (this.openKey !== v.key) {
      this.drop();
      this.openKey = v.key;
      this.release = this.d.block(v.label);
    }
    const fresh = !this.flagged.has(v.key);
    this.flagged.add(v.key);
    return { open: true, fresh };
  }

  /** Typed input at the pane: the open version counts as answered. */
  typed(): void {
    if (this.openKey) this.answered.add(this.openKey);
    this.evaluate();
  }

  /** Release the source (session shutdown). */
  releaseAll(): void {
    this.drop();
  }

  private drop(): void {
    const r = this.release;
    this.release = null;
    this.openKey = null;
    r?.();
  }
}
