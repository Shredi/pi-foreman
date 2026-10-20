// Reload-safe round state (R14 item 6): `<handoff dir>/round-state.json`, written by the adapter itself in a round
// session (PI_FOREMAN_HANDOFF_DIR; none = nothing written, nothing restored).
//
// The file keeps the handoff dir, the checkpointed plan's topic and version hash, the plan-review lineage of that plan,
// the review counters and the revision rounds per chain. It never keeps an approval: on session_start the checkpoint
// approval comes back only from the parent's `ruling.md` (parentApproval restore mode: first line APPROVED, ctime newer
// than the ctime of both `<scratch>/plan-<topic>.md` and `<handoff>/plan.md`, and both plan files of one version hash). Any other field (`approved: true`) is
// ignored. A different handoff dir or plan hash discards the whole file (re-ceremony). Counters restore only as
// non-negative integers; a chain with a bad one starts fresh. The rulings a chain used and its last refusal are not kept; the caps-reset
// watermark (`capsResetAt`, ms epoch of the last parent ruling/brief that lifted the caps) is, so a reload does not apply it twice.
import * as fs from "node:fs";
import * as path from "node:path";
import { planVersionHash } from "./checkpoint.ts";
import type { Verdict } from "./rounds.ts";
import { initialRounds } from "./rounds.ts";
import type { RoundState } from "./rounds.ts";
import { parentApproval } from "./ruling.ts";
import type { SelfRulings } from "./ruling.ts";

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
  chain: string;
  chains: Record<string, { revisions: number; exempt: number; built: boolean; reviewOpen: boolean }>;
  reviewCount: number;
  planReviewCount: number;
  /** Watermark of the last caps reset by a parent ruling/brief (index.ts capsReset); absent = none. */
  capsResetAt?: number;
}

/** The session's handoff dir: PI_FOREMAN_HANDOFF_DIR when absolute, else null. */
export function roundStateDir(env: NodeJS.ProcessEnv): string | null {
  const d = env.PI_FOREMAN_HANDOFF_DIR?.trim();
  return d && path.isAbsolute(d) ? path.resolve(d) : null;
}

/** The persisted form of the chains: revision counters and the open-review state, no security flag. */
export function chainsOf(all: Map<string, RoundState>): PersistedRounds["chains"] {
  return Object.fromEntries([...all].map(([k, s]) => [k, { revisions: s.used, exempt: s.exempt ?? 0, built: s.built, reviewOpen: s.reviewOpen }]));
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
const CHAIN_KEY = /^(?:main|P\d{1,6})$/;
const TOPIC = /^[A-Za-z0-9._-]{1,64}$/;

export interface Restored {
  chain: string;
  chains: Map<string, RoundState>;
  reviewCount: number;
  planReviewCount: number;
  capsResetAt: number;
  /** The checkpoint approval, granted by the parent's ruling.md; null = re-ceremony. */
  approval: { topic: string; path: string; hash: string; ruling: string; at: number; review: PersistedReview | null } | null;
}

/**
 * Read `<dir>/round-state.json` and decide what comes back. `currentPlan(topic)`: the plan file now (checkpoint.ts
 * readPlan rules), or null. Returns null when nothing is restored: no file, unreadable, another handoff dir, or a plan
 * whose hash changed or that is gone.
 */
export function restoreRoundState(dir: string, currentPlan: (topic: string) => { path: string; hash: string } | null, self?: SelfRulings): Restored | null {
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
  let plan: { topic: string; path: string; hash: string } | null = null;
  if (p !== null && p !== undefined) {
    if (typeof p !== "object" || typeof p.topic !== "string" || !TOPIC.test(p.topic) || typeof p.hash !== "string") return null;
    const now = currentPlan(p.topic);
    if (!now || now.hash !== p.hash) return null;
    plan = { topic: p.topic, ...now };
  }
  const chains = new Map<string, RoundState>();
  const rc = raw.chains && typeof raw.chains === "object" && !Array.isArray(raw.chains) ? (raw.chains as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(rc)) {
    if (!CHAIN_KEY.test(k) || !v || typeof v !== "object") continue;
    const c = v as Record<string, unknown>;
    const used = count(c.revisions);
    const exempt = count(c.exempt);
    if (used === null || exempt === null) continue;
    chains.set(k, { ...initialRounds(), built: c.built === true, reviewOpen: c.reviewOpen === true, used, ...(exempt > 0 ? { exempt } : {}) });
  }
  const chain = typeof raw.chain === "string" && CHAIN_KEY.test(raw.chain) ? raw.chain : "main";
  return { chain, chains, reviewCount: count(raw.reviewCount) ?? 0, planReviewCount: count(raw.planReviewCount) ?? 0, capsResetAt: count(raw.capsResetAt) ?? 0, approval: plan ? approvalOf(dir, plan, raw.planReview, self) : null };
}

const ctimeOf = (f: string): number | null => {
  try {
    return fs.statSync(f).ctimeMs;
  } catch {
    return null;
  }
};

/**
 * The parent's ruling.md approves `plan` when it is newer (ctime) than both plan files and the scratch plan has the
 * version hash of the handoff plan.md the parent ruled on (planVersionHash: the body above any appendix); never a stored flag.
 */
function approvalOf(dir: string, plan: { topic: string; path: string; hash: string }, review: unknown, self?: SelfRulings): Restored["approval"] {
  const handoffPlan = path.join(dir, "plan.md");
  const a = ctimeOf(plan.path);
  const b = ctimeOf(handoffPlan);
  if (a === null || b === null) return null;
  let parentHash: string;
  try {
    parentHash = planVersionHash(fs.readFileSync(handoffPlan));
  } catch {
    return null;
  }
  if (parentHash !== plan.hash) return null;
  const ruling = parentApproval([dir], Math.max(a, b), self, true);
  const at = ruling ? ctimeOf(ruling) : null;
  if (!ruling || at === null) return null;
  const r = review as Record<string, unknown> | null | undefined;
  const rounds = r && typeof r === "object" ? count(r.rounds) : null;
  const ok = r && rounds !== null && rounds >= 1 && r.hash === plan.hash && (r.verdict === "pass" || r.verdict === "fail") && (r.model === null || typeof r.model === "string");
  return { ...plan, ruling, at, review: ok ? { hash: plan.hash, verdict: r.verdict as Verdict, model: r.model as string | null, rounds } : null };
}
