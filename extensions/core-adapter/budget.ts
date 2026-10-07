// Foreman read budgets (ceremony.foremanReads, ceremony.recheckBudget). Pure logic; index.ts
// wires it into tool_call / tool_result and keeps the state in memory only, per session.
//
// Read class: bash, read, grep, find, ls, codemode. A call counts by its distinct top-level
// call id: a nested codemode call `<outer>/<n>` maps to `<outer>`, so a script is one unit.
// Phase `before` lasts until the first child launch that started, `after` from the latest one;
// the count restarts at each started launch. At `warn` the result carries a notice; above `deny`
// the call is refused. After a deny, only an explorer run that started lifts it, once per phase;
// then only the user's `/foreman budget lift`. Knob 2: after a reviewer PASS the foreman gets
// `recheckBudget` read-class calls, then is told to finish (the read budget does not apply).

export type Phase = "before" | "after";
export interface PhaseLimits {
  warn: number;
  deny: number;
}
export type ReadLimits = Record<Phase, PhaseLimits>;

export const READ_CLASS: ReadonlySet<string> = new Set(["bash", "read", "grep", "find", "ls", "codemode"]);
export const DEFAULT_READ_LIMITS: ReadLimits = { before: { warn: 6, deny: 12 }, after: { warn: 4, deny: 8 } };
export const DEFAULT_RECHECK = 3;
const MAX_FILES = 200;

const posInt = (v: unknown, min: number): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= min ? v : undefined);

/** `ceremony.foremanReads` with coded defaults for anything missing or malformed. */
export function readLimits(v: unknown): ReadLimits {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const one = (p: Phase): PhaseLimits => {
    const e = o[p] && typeof o[p] === "object" ? (o[p] as Record<string, unknown>) : {};
    const deny = posInt(e.deny, 1) ?? DEFAULT_READ_LIMITS[p].deny;
    return { warn: Math.min(posInt(e.warn, 1) ?? DEFAULT_READ_LIMITS[p].warn, deny), deny };
  };
  return { before: one("before"), after: one("after") };
}

export function recheckLimit(v: unknown): number {
  return posInt(v, 0) ?? DEFAULT_RECHECK;
}

/** `<outer>/<n>` -> `<outer>`. */
export function topLevelId(id: string): string {
  const i = id.indexOf("/");
  return i < 0 ? id : id.slice(0, i);
}

export type BudgetDecision =
  | { kind: "allow" }
  | { kind: "warn"; phase: Phase; count: number; text: string }
  | { kind: "deny"; reason: string; event: "read_budget" | "recheck_budget"; phase?: Phase; count: number };

export interface LaunchEffect {
  /** The launch lifted a deny (an explorer run started). */
  lift?: { phase: Phase; count: number };
}

export class ReadBudget {
  phase: Phase = "before";
  private ids = new Set<string>();
  private denied = false;
  private liftUsed: Record<Phase, boolean> = { before: false, after: false };
  private post: { ids: Set<string> } | null = null;

  get count(): number {
    return this.ids.size;
  }
  get postPass(): boolean {
    return this.post !== null;
  }
  get recheckCount(): number {
    return this.post ? this.post.ids.size : 0;
  }

  /** Decide one tool call. `exempt`: supervisor reply window or a read of a recorded child result file. */
  check(toolName: string, toolCallId: string, limits: ReadLimits, recheck: number, exempt: boolean): BudgetDecision {
    if (!READ_CLASS.has(toolName) || exempt) return { kind: "allow" };
    const top = topLevelId(toolCallId);
    const nested = top !== toolCallId;
    if (this.post) {
      if (this.post.ids.has(top)) return { kind: "allow" };
      if (this.post.ids.size >= recheck) {
        return { kind: "deny", event: "recheck_budget", count: this.post.ids.size + 1, reason: `pi-foreman: [recheck_budget_exceeded] the reviewer passed; finish now. You have used your ${recheck} own check${recheck === 1 ? "" : "s"} after the pass; report the result instead of checking again.` };
      }
      this.post.ids.add(top);
      return { kind: "allow" };
    }
    if (this.ids.has(top)) {
      // a nested call of a script admitted earlier: refused once the window is over deny
      return nested && this.denied ? this.deny(limits, this.ids.size) : { kind: "allow" };
    }
    const n = this.ids.size + 1;
    const lim = limits[this.phase];
    if (this.denied || n > lim.deny) return this.deny(limits, n - 1);
    this.ids.add(top);
    if (n >= lim.warn) {
      const since = this.phase === "before" ? "before the first launch" : "since the last launch";
      return { kind: "warn", phase: this.phase, count: n, text: `pi-foreman: read budget ${n} of ${lim.deny} read calls ${since}. Launch the explorer for the rest of the research instead of reading yourself.` };
    }
    return { kind: "allow" };
  }

  private deny(limits: ReadLimits, count: number): BudgetDecision {
    this.denied = true;
    const lim = limits[this.phase];
    const since = this.phase === "before" ? "before the first launch" : "since the last launch";
    const how = this.liftUsed[this.phase] ? "The explorer already lifted this once in this phase; ask the owner to run /foreman budget lift." : "Launch the explorer: a started explorer run lifts the limit.";
    return { kind: "deny", event: "read_budget", phase: this.phase, count, reason: `pi-foreman: [read_budget_exceeded] ${count} read calls ${since} (limit ${lim.deny}). ${how}` };
  }

  /** A child launch recorded as started. */
  onLaunch(roles: readonly string[]): LaunchEffect {
    const was = this.phase;
    const effect: LaunchEffect = {};
    this.phase = "after";
    if (this.denied) {
      // only an explorer run lifts a deny, once per phase; any other launch leaves it standing
      if (!roles.includes("explorer") || this.liftUsed[was]) return effect;
      this.liftUsed[was] = true;
      effect.lift = { phase: was, count: this.ids.size };
    }
    this.ids = new Set();
    this.denied = false;
    return effect;
  }

  /** `/foreman budget lift`: the user starts a fresh window in the current phase. */
  userLift(): { phase: Phase; count: number } {
    const r = { phase: this.phase, count: this.ids.size };
    this.ids = new Set();
    this.denied = false;
    return r;
  }

  /** Reviewer PASS: enter the post-PASS state (knob 2). */
  enterPost(): void {
    this.post = { ids: new Set() };
  }

  /** Leave the post-PASS state; returns the checks used, or null when it was not active. */
  resetPost(): number | null {
    if (!this.post) return null;
    const n = this.post.ids.size;
    this.post = null;
    return n;
  }
}

/** Absolute file paths named in a child result or notice text (the files the adapter records). */
export function pathsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\w.\-/\\])(?:[A-Za-z]:[\\/]|\/)[^\s"'`<>|*?()[\]]+\.[A-Za-z0-9]{1,6}\b/g)) out.add(m[0]);
  return [...out];
}

/** Remember paths, newest kept, at most MAX_FILES. */
export function recordFiles(files: Set<string>, paths: string[], normalise: (p: string) => string): void {
  for (const p of paths) {
    files.delete(normalise(p));
    files.add(normalise(p));
    if (files.size > MAX_FILES) files.delete(files.values().next().value as string);
  }
}
