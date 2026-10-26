// Ceremony state that survives /reload and resume (R46 item 2): one custom session entry `pi-foreman-ceremony-state`
// (appended with pi.appendEntry, read back from the branch like idlemodel.ts latestIdleEntry), keyed on the plan version hash.
//
//   { v: 1, plan: {topic, path, hash, status, by, at, source} | null, lineages: [{path, hash, verdict, model, rounds, reviews}],
//     planReviews: {<topic>: n}, userTier: tier | null, planPhase: boolean }
//
// An approval comes back only when the plan file's version hash still equals the recorded one (an Addendum below the body keeps
// it) and, for a verdict from the parent, the verdict file still reads APPROVED. The session file is write-protected for the
// foreman and its children (permoverlay.ts), so only the adapter writes this entry. `planPhase` is reserved (not enforced yet).
import * as fs from "node:fs";
import * as path from "node:path";
import { isTier } from "./ceremony.ts";
import type { Tier } from "./ceremony.ts";
import type { PlanRecord } from "./checkpoint.ts";
import { PLAN_MAX_BYTES, PLAN_VERDICT_FILE } from "./checkpoint.ts";
import type { Verdict } from "./rounds.ts";

export const CEREMONY_ENTRY = "pi-foreman-ceremony-state";

export type PlanSource = "dialog" | "ruling-plan" | "ruling";

export interface PersistedPlan {
  topic: string;
  path: string;
  hash: string;
  status: PlanRecord["status"];
  by: PlanRecord["by"];
  at: string | null;
  source: PlanSource;
}

export interface PersistedLineage {
  path: string;
  hash: string;
  verdict: Verdict;
  model: string | null;
  rounds: number;
  reviews: number;
}

export interface CeremonyStateEntry {
  v: 1;
  plan: PersistedPlan | null;
  lineages: PersistedLineage[];
  planReviews: Record<string, number>;
  userTier: Tier | null;
  /** Reserved for the plan phase; not enforced yet. */
  planPhase: boolean;
}

export function emptyCeremonyState(): CeremonyStateEntry {
  return { v: 1, plan: null, lineages: [], planReviews: {}, userTier: null, planPhase: false };
}

export function buildCeremonyState(o: { plan: PlanRecord | null; lineages: PersistedLineage[]; planReviews: Record<string, number>; userTier?: Tier; planPhase: boolean }): CeremonyStateEntry {
  const p = o.plan;
  return {
    v: 1,
    plan: p ? { topic: p.topic, path: p.path, hash: p.hash, status: p.status, by: p.by, at: p.approvedAt, source: p.source ?? "dialog" } : null,
    lineages: o.lineages,
    planReviews: { ...o.planReviews },
    userTier: o.userTier ?? null,
    planPhase: o.planPhase,
  };
}

const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const STATUS = new Set(["pending", "approved", "revise", "rejected"]);
const SOURCES = new Set(["dialog", "ruling-plan", "ruling"]);

/** The newest ceremony-state entry of a branch, validated field by field (a bad field is dropped, not trusted), or null. */
export function latestCeremonyState(entries: unknown[]): CeremonyStateEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type?: unknown; customType?: unknown; data?: unknown } | null;
    if (!e || e.type !== "custom" || e.customType !== CEREMONY_ENTRY) continue;
    const d = e.data as Record<string, unknown> | null | undefined;
    if (!d || typeof d !== "object" || d.v !== 1) return null;
    const out = emptyCeremonyState();
    const p = d.plan as Record<string, unknown> | null | undefined;
    if (p && typeof p === "object" && typeof p.topic === "string" && typeof p.path === "string" && typeof p.hash === "string" && typeof p.status === "string" && STATUS.has(p.status) && typeof p.source === "string" && SOURCES.has(p.source)) {
      out.plan = { topic: p.topic, path: p.path, hash: p.hash, status: p.status as PlanRecord["status"], by: p.by === "user" || p.by === "rig" ? p.by : null, at: typeof p.at === "string" ? p.at : null, source: p.source as PlanSource };
    }
    if (Array.isArray(d.lineages)) {
      for (const l of d.lineages as Record<string, unknown>[]) {
        const rounds = count(l?.rounds);
        const reviews = count(l?.reviews);
        if (l && typeof l.path === "string" && typeof l.hash === "string" && (l.verdict === "pass" || l.verdict === "fail") && (l.model === null || typeof l.model === "string") && rounds !== null && rounds >= 1) {
          out.lineages.push({ path: l.path, hash: l.hash, verdict: l.verdict, model: l.model as string | null, rounds, reviews: reviews ?? rounds });
        }
      }
    }
    if (d.planReviews && typeof d.planReviews === "object" && !Array.isArray(d.planReviews)) {
      for (const [k, v] of Object.entries(d.planReviews as Record<string, unknown>)) {
        const n = count(v);
        if (n !== null) out.planReviews[k] = n;
      }
    }
    out.userTier = isTier(d.userTier) ? d.userTier : null;
    out.planPhase = d.planPhase === true;
    return out;
  }
  return null;
}

/** True when `<dir>/<name>` is a regular file whose first line is APPROVED (no ctime binding: an Addendum edit does not void it). */
export function readsApproved(dir: string, name: string): boolean {
  try {
    const file = path.join(dir, name);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > PLAN_MAX_BYTES) return false;
    return fs.readFileSync(file, "utf8").split(/\r?\n/, 1)[0].trim() === "APPROVED";
  } catch {
    return false;
  }
}

/**
 * The approval an entry may bring back: only `approved`, only while the plan file's version hash (`currentHash`, null = gone) still
 * equals the recorded one, and for a verdict from the parent only while that file still reads APPROVED in the handoff dir.
 */
export function restorableApproval(plan: PersistedPlan | null, currentHash: string | null, handoffDir: string | null): PlanRecord | null {
  if (!plan || plan.status !== "approved" || currentHash === null || currentHash !== plan.hash) return null;
  if (plan.source !== "dialog" && !(handoffDir && readsApproved(handoffDir, plan.source === "ruling-plan" ? PLAN_VERDICT_FILE : "ruling.md"))) return null;
  return { topic: plan.topic, path: plan.path, hash: plan.hash, status: "approved", approvedAt: plan.at, by: plan.by, source: plan.source, note: "restored after reload" };
}
