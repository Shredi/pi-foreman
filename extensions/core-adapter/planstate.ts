// Ceremony state that survives /reload and resume (R46 item 2): one custom session entry `pi-foreman-ceremony-state`
// (appended with pi.appendEntry, read back from the branch like idlemodel.ts latestIdleEntry), keyed on the plan version hash.
//
//   { v: 1, plan: {topic, path, hash, status, by, at, source} | null, lineages: [{path, hash, verdict, model, rounds, reviews}],
//     userTier: tier | null, tier: tier | null, tierSource: source | null, planPhase: boolean }
//
// `tier` is the effective tier and `tierSource` the source of its last change; a reload never lowers it (index.ts restoreCeremonyState).
//
// An approval comes back only when the plan file's version hash still equals the recorded one (an Addendum below the body keeps
// it) and, for a verdict from the parent, the verdict file still reads APPROVED. The session file is write-protected for the
// foreman and its children (permoverlay.ts), so only the adapter writes this entry. `planPhase` is the plan phase (index.ts).
import * as fs from "node:fs";
import * as path from "node:path";
import { isTier } from "./ceremony.ts";
import type { Tier, TierSource } from "./ceremony.ts";
import type { PlanRecord } from "./checkpoint.ts";
import { PLAN_MAX_BYTES, PLAN_VERDICT_FILE } from "./checkpoint.ts";
import type { Verdict } from "./rounds.ts";
import { reviewsOfEntry } from "./reviews.ts";
import type { ReviewRecord } from "./reviews.ts";
import type { LoopStop } from "./reviewloop.ts";
import type { PassMark, ReviewGate, StepCounts } from "./bound.ts";

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

/** The finish gate's progress (index.ts Session.steps, reviewGate, passMark): restored on /reload of the same session, never on a fork. */
export interface PersistedGate {
  steps: StepCounts;
  reviewGate: ReviewGate;
  passMark: (PassMark & { cwd: string }) | null;
}

export interface CeremonyStateEntry {
  v: 1;
  plan: PersistedPlan | null;
  lineages: PersistedLineage[];
  userTier: Tier | null;
  /** The effective tier and the source of its last change (null in an entry from before they were recorded). */
  tier: Tier | null;
  tierSource: TierSource | null;
  /** The plan phase is on (index.ts): .workflow-only writes, no builder launch. */
  planPhase: boolean;
  /** Reviewer verdicts with the head they covered (reviews.ts), so the PR gate survives compaction, /reload and resume. */
  reviews: ReviewRecord[];
  /** The loop guard's stop (reviewloop.ts), absent when none is set. */
  loopStop?: LoopStop;
  /** Absent in an entry from before the gate progress was recorded (index.ts rebuilds it from the PASS reviews). */
  gate?: PersistedGate;
}

export function emptyCeremonyState(): CeremonyStateEntry {
  return { v: 1, plan: null, lineages: [], userTier: null, tier: null, tierSource: null, planPhase: false, reviews: [] };
}

export function buildCeremonyState(o: { plan: PlanRecord | null; lineages: PersistedLineage[]; userTier?: Tier; tier?: Tier; tierSource?: TierSource; planPhase: boolean; reviews?: readonly ReviewRecord[]; loopStop?: LoopStop | null; gate?: PersistedGate }): CeremonyStateEntry {
  const p = o.plan;
  return {
    v: 1,
    plan: p ? { topic: p.topic, path: p.path, hash: p.hash, status: p.status, by: p.by, at: p.approvedAt, source: p.source ?? "dialog" } : null,
    lineages: o.lineages,
    userTier: o.userTier ?? null,
    tier: o.tier ?? null,
    tierSource: o.tierSource ?? null,
    planPhase: o.planPhase,
    reviews: (o.reviews ?? []).map((r) => ({ role: r.role, verdict: r.verdict, head: r.head, ...(r.cwd ? { cwd: r.cwd } : {}), ...(r.why ? { why: r.why } : {}), ...(r.kind ? { kind: r.kind } : {}), ...(r.state !== undefined ? { state: r.state } : {}), ...(r.sig ? { sig: r.sig } : {}) })),
    ...(o.loopStop ? { loopStop: o.loopStop } : {}),
    ...(o.gate ? { gate: o.gate } : {}),
  };
}

const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const STATUS = new Set(["pending", "approved", "revise", "rejected"]);
const SOURCES = new Set(["dialog", "ruling-plan", "ruling"]);
const TIER_SOURCES = new Set(["default", "ledger", "user", "auto", "foreman"]);

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
    out.userTier = isTier(d.userTier) ? d.userTier : null;
    out.tier = isTier(d.tier) ? d.tier : null;
    out.tierSource = typeof d.tierSource === "string" && TIER_SOURCES.has(d.tierSource) ? (d.tierSource as TierSource) : null;
    out.planPhase = d.planPhase === true;
    out.reviews = reviewsOfEntry(d.reviews);
    const ls = d.loopStop as Record<string, unknown> | null | undefined;
    if (ls && typeof ls === "object" && (ls.rule === "repeat" || ls.rule === "stalled") && (ls.kind === "plan" || ls.kind === "code") && Array.isArray(ls.sig) && ls.sig.every((x) => typeof x === "string")) out.loopStop = { rule: ls.rule, kind: ls.kind, sig: ls.sig as string[] };
    const g = gateOfEntry(d.gate);
    if (g) out.gate = g;
    return out;
  }
  return null;
}

const nullable = (v: unknown): v is string | null => v === null || typeof v === "string";

/** The gate progress of an entry, shape-checked; null (the field is ignored) when anything is off. */
function gateOfEntry(v: unknown): PersistedGate | null {
  const g = v as Record<string, unknown> | null | undefined;
  if (!g || typeof g !== "object") return null;
  const st = g.steps as Record<string, unknown> | null | undefined;
  const rg = g.reviewGate as Record<string, unknown> | null | undefined;
  const builder = count(st?.builder);
  const reviewer = count(st?.reviewer);
  if (builder === null || reviewer === null || !rg || typeof rg !== "object") return null;
  if (!(rg.last === null || rg.last === "pass" || rg.last === "fail" || rg.last === "none") || typeof rg.revised !== "boolean") return null;
  const reviewGate: ReviewGate = { last: rg.last as ReviewGate["last"], revised: rg.revised, ...(typeof rg.failAt === "number" && Number.isFinite(rg.failAt) ? { failAt: rg.failAt } : {}), ...(typeof rg.passRun === "string" ? { passRun: rg.passRun } : {}) };
  const m = g.passMark as Record<string, unknown> | null | undefined;
  const br = count(m?.builderRuns);
  const passMark = m && typeof m === "object" && typeof m.cwd === "string" && typeof m.at === "number" && Number.isFinite(m.at) && nullable(m.head) && nullable(m.tree) && nullable(m.ledger) && br !== null
    ? { cwd: m.cwd, at: m.at, head: m.head as string | null, tree: m.tree as string | null, ledger: m.ledger as string | null, builderRuns: br }
    : null;
  return { steps: { builder, reviewer }, reviewGate, passMark };
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
