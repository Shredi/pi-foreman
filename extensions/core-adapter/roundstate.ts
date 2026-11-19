// Reload-safe round state (R14 item 6): `<handoff dir>/round-state.json`, written by the adapter itself in a round
// session (PI_FOREMAN_HANDOFF_DIR; none = nothing written, nothing restored).
//
// The file keeps the handoff dir, the checkpointed plan's topic and version hash, the plan-review lineage of that plan
// and the round state (built, review open). It never keeps or brings back an approval: the session's own dialog approval returns from
// its ceremony-state entry only, never the approval store (index.ts), and no parent file (`ruling.md`, `ruling-plan.md`) approves a plan. Any other
// field (`approved: true`) is ignored. A different handoff dir or plan hash discards the whole file (re-ceremony). A file of an older version (`chains`, review
// counters) restores its main chain's state and drops the counters. The caps-reset
// watermark (`capsResetAt`, ms epoch of the last parent brief that lifted the loop stop and the budgets) is kept, so a reload does not apply it twice.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Verdict } from "./rounds.ts";
import { initialRounds } from "./rounds.ts";
import type { RoundState } from "./rounds.ts";

export const ROUND_STATE_FILE = "round-state.json";

export interface PersistedReview {
  hash: string;
  verdict: Verdict;
  model: string | null;
  rounds: number;
}

export interface PersistedRounds {
  handoffDir: string;
  /** The checkpointed plan (any status but rejected), or null. */
  plan: { topic: string; hash: string } | null;
  /** The plan-review lineage of that plan, or null. */
  planReview: PersistedReview | null;
  round: RoundState;
  /** The session's tier, whether its newest plan review passed (needs no checkpoint) and whether its plan's checkpoint is still open (false only once approved), for the parent's wait line only (planWait); a restore ignores all three. */
  tier?: string;
  reviewPassed?: boolean;
  planOpen?: boolean;
  /** Watermark of the last caps reset by a parent brief (index.ts capsReset); absent = none. */
  capsResetAt?: number;
}

/** The session's handoff dir: PI_FOREMAN_HANDOFF_DIR when absolute, else null. */
export function roundStateDir(env: NodeJS.ProcessEnv): string | null {
  const d = env.PI_FOREMAN_HANDOFF_DIR?.trim();
  return d && path.isAbsolute(d) ? path.resolve(d) : null;
}

/** Write the file (temp file + rename); a failure leaves the old file and is not fatal. */
export function writeRoundState(data: PersistedRounds): void {
  const file = path.join(data.handoffDir, ROUND_STATE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data) + "\n");
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
  }
}

const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const TOPIC = /^[A-Za-z0-9._-]{1,64}$/;

export interface Restored {
  round: RoundState;
  capsResetAt: number;
}

/**
 * Read `<dir>/round-state.json` and decide what comes back. `currentPlan(topic)`: the plan file now (checkpoint.ts
 * readPlan rules), or null. Returns null when nothing is restored: no file, unreadable, another handoff dir, or a plan
 * whose hash changed or that is gone.
 */
export function restoreRoundState(dir: string, currentPlan: (topic: string) => { path: string; hash: string } | null): Restored | null {
  let raw: Record<string, unknown>;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, ROUND_STATE_FILE), "utf8")) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    raw = v as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof raw.handoffDir !== "string" || path.resolve(raw.handoffDir) !== path.resolve(dir)) return null;
  const p = raw.plan as Record<string, unknown> | null | undefined;
  if (p !== null && p !== undefined) {
    if (typeof p !== "object" || typeof p.topic !== "string" || !TOPIC.test(p.topic) || typeof p.hash !== "string") return null;
    const now = currentPlan(p.topic);
    if (!now || now.hash !== p.hash) return null;
  }
  const old = raw.chains && typeof raw.chains === "object" && !Array.isArray(raw.chains) ? (raw.chains as Record<string, unknown>).main : undefined;
  const rs = raw.round && typeof raw.round === "object" && !Array.isArray(raw.round) ? raw.round : old;
  const c = (rs && typeof rs === "object" ? rs : {}) as Record<string, unknown>;
  const round: RoundState = { ...initialRounds(), built: c.built === true, reviewOpen: c.reviewOpen === true, ...(c.revisionAnswered === true ? { revisionAnswered: true } : {}) };
  return { round, capsResetAt: count(raw.capsResetAt) ?? 0 };
}

const WAIT_UNKNOWN = "waits for: unknown (no state); nothing from you is required";

/**
 * What a child waits for at its plan, from its own `<dir>/round-state.json` (fixed words only; nothing the child wrote). `open`: the plan phase is open
 * (nothing built, plan not approved); false when the state is unreadable. The text carries no label and no closing period.
 */
export function planWait(dir: unknown): { open: boolean; text: string } {
  let raw: Record<string, unknown>;
  if (typeof dir !== "string" || !path.isAbsolute(dir)) return { open: false, text: WAIT_UNKNOWN };
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, ROUND_STATE_FILE), "utf8")) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return { open: false, text: WAIT_UNKNOWN };
    raw = v as Record<string, unknown>;
  } catch {
    return { open: false, text: WAIT_UNKNOWN };
  }
  const round = raw.round && typeof raw.round === "object" && !Array.isArray(raw.round) ? (raw.round as Record<string, unknown>) : {};
  const approved = raw.planOpen === false;
  const open = round.built !== true && !approved;
  const tier = raw.tier;
  if (typeof tier !== "string" || !tier) return { open, text: WAIT_UNKNOWN };
  const passed = raw.reviewPassed === true;
  if (tier === "heavy") {
    if (approved) return { open, text: "waits for: nothing; it goes on to build" };
    return { open, text: passed ? "waits for: the owner's approval at its pane; nothing from you" : "waits for: its own plan review and the owner's approval at its pane; nothing from you" };
  }
  return { open, text: passed ? "waits for: nothing; it goes on to build" : "waits for: its own plan review, then it goes on to build; nothing from you" };
}
