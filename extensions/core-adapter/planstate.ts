// Ceremony state that survives /reload and resume (R46 item 2): one custom session entry `pi-foreman-ceremony-state`
// (appended with pi.appendEntry, read back from the branch like idlemodel.ts latestIdleEntry), keyed on the plan version hash.
//
//   { v: 1, plan: {topic, path, hash, status, by, at, source} | null, lineages: [{path, hash, verdict, model, rounds, reviews}],
//     userTier: tier | null, tier: tier | null, tierSource: source | null, planPhase: boolean, planPhaseOrigin?: "parent" }
//
// `tier` is the effective tier and `tierSource` the source of its last change; a reload never lowers it (index.ts restoreCeremonyState).
//
// An approval comes back only when the plan file's version hash still equals the recorded one (an Addendum below the body keeps
// it) and it came from the owner's dialog; no file from a parent approves a plan. The session file is write-protected for the
// foreman and its children (the gate), so only the adapter writes this entry. `planPhase` is the plan phase (index.ts);
// `planPhaseOrigin` is `parent` when a parent's launch started it, absent (the owner's origin) otherwise and in an older entry.
import { isTier } from "./ceremony.ts";
import type { Tier, TierSource } from "./ceremony.ts";
import type { PlanRecord } from "./checkpoint.ts";
import type { Verdict } from "./rounds.ts";
import { hsEmpty, hsStateOfEntry, type HsState } from "./highstakes.ts";
import { reviewsOfEntry } from "./reviews.ts";
import type { ReviewRecord } from "./reviews.ts";
import type { LoopStop } from "./reviewloop.ts";
import type { PassMark, ReviewGate, StepCounts } from "./bound.ts";
import { combined, type ReviewGates } from "./reviewgates.ts";

export const CEREMONY_ENTRY = "pi-foreman-ceremony-state";

export type PlanSource = "dialog";
/** Who started the plan phase: a parent's launch (`--plan-first`) or the owner (`/foreman plan`). */
export type PlanPhaseOrigin = "parent" | "owner";

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

/**
 * The finish gate's progress (index.ts Session.steps, reviewGates, passMarks): restored on /reload of the same session, never on a fork. `reviewGate` (all entries combined)
 * and `passMark` (the newest) are still written for an older build, which reads a strict single view; `reviewGates` and `passMarks` (per checkout, key "" = session-wide)
 * are absent in an entry from before the per-checkout gate: it is restored as the session-wide entry.
 */
export interface PersistedGate {
  steps: StepCounts;
  reviewGate: ReviewGate;
  passMark: (PassMark & { cwd: string }) | null;
  reviewGates?: ReviewGates;
  passMarks?: Record<string, PassMark & { cwd: string }>;
}

/** The persisted gate of the session's per-checkout state. */
export function persistedGate(steps: StepCounts, reviewGates: ReviewGates, passMarks: Record<string, PassMark & { cwd: string }>): PersistedGate {
  const marks = Object.values(passMarks);
  const newest = marks.reduce<(PassMark & { cwd: string }) | null>((best, m) => (!best || m.at >= best.at ? m : best), null);
  return { steps, reviewGate: combined(reviewGates), passMark: newest, reviewGates, passMarks };
}

/** The foreman's work in a session: builder launches or builder run ends, and project-file edits through its tools (index.ts Session.work). */
export interface WorkCount {
  builders: number;
  edits: number;
}

/** The pause and refusal-cap state (index.ts): work now, work at the last owner prompt, the finish refusals of the unchanged state `key`. */
export interface PersistedWork {
  work: WorkCount;
  atPrompt: WorkCount;
  /** `done`: the "ceremony incomplete" message of the state `key` is in the transcript. */
  refusals: { n: number; key: string; done?: boolean } | null;
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
  /** `parent`: a parent's launch started the plan phase; absent: the owner's origin (also in an entry from before it was recorded). */
  planPhaseOrigin?: "parent";
  /** Reviewer verdicts with the head they covered (reviews.ts), so the PR gate survives compaction, /reload and resume. */
  reviews: ReviewRecord[];
  /** The loop guard's stop (reviewloop.ts), absent when none is set. */
  loopStop?: LoopStop;
  /** Absent in an entry from before the gate progress was recorded (index.ts rebuilds it from the PASS reviews). */
  gate?: PersistedGate;
  /** A parent sent the work back (a `rework-<k>` marker, index.ts reworkScan) and no `[pre-pr]` PASS followed; absent: false. */
  sentBack?: boolean;
  /** The heads a send-back covered and no later `[pre-pr]` PASS on that head has cleared (sentBackMark); absent: none (an entry with the flag and no set is converted, sentBackRestore). */
  sentBackHeads?: string[];
  /** The highest handled `rework-<k>` number (its own watermark); absent: none handled. */
  reworkSeen?: number;
  /** The session-wide high-stakes state (highstakes.ts); absent in an older entry (loads as empty); an array of per-checkout records is migrated on load. */
  highStakes?: HsState;
  /** The pause window and the refusal count (D27, D28); absent in an older entry or while all of it is empty (loads as zero). */
  pause?: PersistedWork;
  /** `foreman_hold`: the session waits for the owner on purpose (index.ts `hold`); absent: no hold. */
  hold?: { note: string; since: string };
  /** The sorted reason set the finish gate held once for with a high-stakes reminder (index.ts ceremonyFinishGate); absent: none. */
  hsReminded?: string[];
  /** The findings of the last normal-review FAIL for the next re-review task (ledgerblock.ts failFindingsText); absent: none. */
  lastFailFindings?: string;
  /** The count of subject changes to the bound ledger (index.ts ledgerRev, bound.ts PassMark.ledger); absent: 0. */
  ledgerRev?: number;
  /** The checkout fingerprint taken at session start (trivial.ts checkoutBaseline) for the no-change rule; absent: none. */
  baseline?: string;
}

/** Heads whose newest code verdict is a `[pre-pr]` PASS. */
function prePassHeads(reviews: readonly ReviewRecord[]): string[] {
  const last = new Map<string, ReviewRecord>();
  for (const r of reviews) if (r.head && r.kind !== "plan") last.set(r.head, r);
  return [...last].filter(([, r]) => r.verdict === "pass" && r.occasion === "pre-pr").map(([h]) => h);
}

/** A send-back: every head whose newest verdict is a `[pre-pr]` PASS joins the sent-back heads. */
export function sentBackMark(heads: readonly string[], reviews: readonly ReviewRecord[]): string[] {
  return [...new Set([...heads, ...prePassHeads(reviews)])];
}

/** A `[pre-pr]` PASS recorded for a head takes that head, and only that head, out of the sent-back heads. */
export function sentBackUnmark(heads: readonly string[], rec: ReviewRecord): string[] {
  return rec.verdict === "pass" && rec.occasion === "pre-pr" && rec.head ? heads.filter((h) => h !== rec.head) : [...heads];
}

/** The sent-back heads an entry brings back; an entry with the flag and no set (older) sends back every head whose newest verdict is a `[pre-pr]` PASS. */
export function sentBackRestore(e: Pick<CeremonyStateEntry, "sentBack" | "sentBackHeads" | "reviews">): string[] {
  if (e.sentBackHeads) return [...e.sentBackHeads];
  return e.sentBack === true ? prePassHeads(e.reviews) : [];
}

export function emptyCeremonyState(): CeremonyStateEntry {
  return { v: 1, plan: null, lineages: [], userTier: null, tier: null, tierSource: null, planPhase: false, reviews: [] };
}

export function buildCeremonyState(o: { plan: PlanRecord | null; lineages: PersistedLineage[]; userTier?: Tier; tier?: Tier; tierSource?: TierSource; planPhase: boolean; planPhaseOrigin?: PlanPhaseOrigin; reviews?: readonly ReviewRecord[]; loopStop?: LoopStop | null; gate?: PersistedGate; sentBack?: boolean; sentBackHeads?: readonly string[]; reworkSeen?: number; highStakes?: HsState; pause?: PersistedWork; hold?: { note: string; since: string } | null; hsReminded?: readonly string[] | null; ledgerRev?: number; lastFailFindings?: string | null; baseline?: string | null }): CeremonyStateEntry {
  const p = o.plan;
  return {
    v: 1,
    plan: p ? { topic: p.topic, path: p.path, hash: p.hash, status: p.status, by: p.by, at: p.approvedAt, source: p.source ?? "dialog" } : null,
    lineages: o.lineages,
    userTier: o.userTier ?? null,
    tier: o.tier ?? null,
    tierSource: o.tierSource ?? null,
    planPhase: o.planPhase,
    ...(o.planPhase && o.planPhaseOrigin === "parent" ? { planPhaseOrigin: "parent" as const } : {}),
    reviews: (o.reviews ?? []).map((r) => ({ role: r.role, verdict: r.verdict, head: r.head, ...(r.cwd ? { cwd: r.cwd } : {}), ...(r.why ? { why: r.why } : {}), ...(r.kind ? { kind: r.kind } : {}), ...(r.state !== undefined ? { state: r.state } : {}), ...(r.sig ? { sig: r.sig } : {}), ...(r.work !== undefined ? { work: r.work } : {}), ...(r.occasion ? { occasion: r.occasion } : {}), ...(r.tree ? { tree: r.tree } : {}), ...(r.via ? { via: r.via } : {}), ...(r.at !== undefined ? { at: r.at } : {}) })),
    ...(o.loopStop ? { loopStop: o.loopStop } : {}),
    ...(o.gate ? { gate: o.gate } : {}),
    ...(o.sentBack ? { sentBack: true } : {}),
    ...(o.sentBackHeads && (o.sentBackHeads.length > 0 || o.sentBack) ? { sentBackHeads: [...o.sentBackHeads] } : {}),
    ...(o.reworkSeen ? { reworkSeen: o.reworkSeen } : {}),
    ...(o.highStakes && !hsEmpty(o.highStakes) ? { highStakes: JSON.parse(JSON.stringify(o.highStakes)) as HsState } : {}),
    ...(o.pause && !pauseEmpty(o.pause) ? { pause: { work: { ...o.pause.work }, atPrompt: { ...o.pause.atPrompt }, refusals: o.pause.refusals ? { ...o.pause.refusals } : null } } : {}),
    ...(o.hold ? { hold: { note: o.hold.note, since: o.hold.since } } : {}),
    ...(o.hsReminded && o.hsReminded.length > 0 ? { hsReminded: [...o.hsReminded] } : {}),
    ...(o.ledgerRev ? { ledgerRev: o.ledgerRev } : {}),
    ...(o.baseline ? { baseline: o.baseline } : {}),
    ...(o.lastFailFindings ? { lastFailFindings: o.lastFailFindings } : {}),
  };
}

const pauseEmpty = (p: PersistedWork): boolean => p.work.builders + p.work.edits + p.atPrompt.builders + p.atPrompt.edits === 0 && !p.refusals;

const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const STATUS = new Set(["pending", "approved", "revise", "rejected"]);
const SOURCES = new Set(["dialog"]);
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
    if (out.planPhase && d.planPhaseOrigin === "parent") out.planPhaseOrigin = "parent";
    out.reviews = reviewsOfEntry(d.reviews);
    const ls = d.loopStop as Record<string, unknown> | null | undefined;
    if (ls && typeof ls === "object" && (ls.rule === "repeat" || ls.rule === "stalled") && (ls.kind === "plan" || ls.kind === "code") && Array.isArray(ls.sig) && ls.sig.every((x) => typeof x === "string")) out.loopStop = { rule: ls.rule, kind: ls.kind, sig: ls.sig as string[] };
    const g = gateOfEntry(d.gate);
    if (g) out.gate = g;
    if (d.sentBack === true) out.sentBack = true;
    if (Array.isArray(d.sentBackHeads)) out.sentBackHeads = (d.sentBackHeads as unknown[]).filter((h): h is string => typeof h === "string" && h !== "");
    const rw = count(d.reworkSeen);
    if (rw) out.reworkSeen = rw;
    const hs = hsStateOfEntry(d.highStakes);
    if (hs && !hsEmpty(hs)) out.highStakes = hs;
    const pause = pauseOfEntry(d.pause);
    if (pause) out.pause = pause;
    if (Array.isArray(d.hsReminded)) {
      const r = (d.hsReminded as unknown[]).filter((x): x is string => typeof x === "string" && x !== "");
      if (r.length > 0) out.hsReminded = r;
    }
    if (typeof d.baseline === "string" && d.baseline !== "") out.baseline = d.baseline;
    const h = d.hold as Record<string, unknown> | null | undefined;
    if (h && typeof h === "object" && typeof h.note === "string" && h.note && typeof h.since === "string") out.hold = { note: h.note.slice(0, 200), since: h.since.slice(0, 40) };
    const rev = count(d.ledgerRev);
    if (rev) out.ledgerRev = rev;
    if (typeof d.lastFailFindings === "string" && d.lastFailFindings !== "") out.lastFailFindings = d.lastFailFindings;
    return out;
  }
  return null;
}

const workOf = (v: unknown): WorkCount | null => {
  const w = v as Record<string, unknown> | null | undefined;
  const builders = count(w?.builders);
  const edits = count(w?.edits);
  return w && typeof w === "object" && builders !== null && edits !== null ? { builders, edits } : null;
};

/** The pause state of an entry, shape-checked; null (the field is ignored) when anything is off. */
function pauseOfEntry(v: unknown): PersistedWork | null {
  const p = v as Record<string, unknown> | null | undefined;
  if (!p || typeof p !== "object") return null;
  const work = workOf(p.work);
  const atPrompt = workOf(p.atPrompt);
  if (!work || !atPrompt) return null;
  const r = p.refusals as Record<string, unknown> | null | undefined;
  const n = count(r?.n);
  return { work, atPrompt, refusals: r && typeof r === "object" && n !== null && typeof r.key === "string" ? { n, key: r.key, ...(r.done === true ? { done: true } : {}) } : null };
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
  const reviewGate = oneGate(rg);
  if (!reviewGate) return null;
  const out: PersistedGate = { steps: { builder, reviewer }, reviewGate, passMark: markOf(g.passMark) };
  const maps = mapsOf(g.reviewGates, g.passMarks);
  return maps ? { ...out, ...maps } : out;
}

/** One review gate, shape-checked; null when anything is off. */
function oneGate(rg: unknown): ReviewGate | null {
  const r = rg as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== "object") return null;
  if (!(r.last === null || r.last === "pass" || r.last === "fail" || r.last === "none") || typeof r.revised !== "boolean") return null;
  return { last: r.last as ReviewGate["last"], revised: r.revised, ...(typeof r.failAt === "number" && Number.isFinite(r.failAt) ? { failAt: r.failAt } : {}), ...(r.stoodAtFail === true ? { stoodAtFail: true } : {}), ...(typeof r.passRun === "string" ? { passRun: r.passRun } : {}) };
}

/** One pass mark, shape-checked; null when absent or off. */
function markOf(v: unknown): (PassMark & { cwd: string }) | null {
  const m = v as Record<string, unknown> | null | undefined;
  const br = count(m?.builderRuns);
  return m && typeof m === "object" && typeof m.cwd === "string" && typeof m.at === "number" && Number.isFinite(m.at) && nullable(m.head) && nullable(m.tree) && nullable(m.ledger) && br !== null
    ? { cwd: m.cwd, at: m.at, head: m.head as string | null, tree: m.tree as string | null, ledger: m.ledger as string | null, builderRuns: br }
    : null;
}

/** The per-checkout maps of an entry; one bad entry drops both maps (null: the old single gate stands in for them). */
function mapsOf(gates: unknown, marks: unknown): { reviewGates: ReviewGates; passMarks: Record<string, PassMark & { cwd: string }> } | null {
  if (gates === undefined) return null;
  if (!gates || typeof gates !== "object" || Array.isArray(gates) || (marks !== undefined && (!marks || typeof marks !== "object" || Array.isArray(marks)))) return null;
  const reviewGates: ReviewGates = {};
  for (const [k, v] of Object.entries(gates)) {
    const one = oneGate(v);
    if (!one) return null;
    reviewGates[k] = one;
  }
  const passMarks: Record<string, PassMark & { cwd: string }> = {};
  for (const [k, v] of Object.entries(marks ?? {})) {
    const one = markOf(v);
    if (!one) return null;
    passMarks[k] = one;
  }
  return { reviewGates, passMarks };
}

/**
 * The approval an entry may bring back: only `approved`, only from the owner's dialog (an entry from a parent's verdict file, `source`
 * `ruling-plan` or `ruling`, is dropped when read), and only while the plan file's version hash (`currentHash`, null = gone) still equals the recorded one.
 */
export function restorableApproval(plan: PersistedPlan | null, currentHash: string | null): PlanRecord | null {
  if (!plan || plan.status !== "approved" || plan.source !== "dialog" || currentHash === null || currentHash !== plan.hash) return null;
  return { topic: plan.topic, path: plan.path, hash: plan.hash, status: "approved", approvedAt: plan.at, by: plan.by, source: plan.source, note: "restored after reload" };
}
