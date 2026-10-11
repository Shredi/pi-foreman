// Research launches (docs/ladder.md): a launch entry tagged in its task text routes to a stronger rung.
//   [research]       web or PDF research: the entry runs at least on its role's strong rung.
//   [fact-critical]  a wrong fact is costly: implies [research]; the rung is ladder.research.factCriticalRung,
//                    else the security rung (ladder.reviewerClimb.securityRung, else the default one), else
//                    the role's strong rung.
// The floor is written before the rank check (rank policy still applies); the fact-critical rung is
// explicit config, written after it, like the security rung. Both are no-ops for a role without a strong rung.
import { get, type Json } from "./config.ts";
import { launchEntries } from "./ladder.ts";
import { launchModel, splitLevel } from "./launchmodel.ts";
import { ranksOf, tierOf } from "./ranks.ts";
import { cappedRung, defaultSecurityRung, reviewerClimbConfig } from "./reviewerclimb.ts";

export type ResearchMarker = "research" | "fact-critical";

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** The marker a task text names (case-insensitive); `[fact-critical]` wins over `[research]`. */
export function researchMarkerOf(text: unknown): ResearchMarker | null {
  const t = typeof text === "string" ? text.toLowerCase() : "";
  if (t.includes("[fact-critical]")) return "fact-critical";
  if (t.includes("[research]")) return "research";
  return null;
}

export interface MarkedEntry {
  entry: Json;
  role: string;
  marker: ResearchMarker;
  /** The entry is part of tasks/chain (its usage line logs role "child", not its own role). */
  composite: boolean;
}

/** The launch entries (single, tasks, chain, parallel) that name an agent and carry a marker. */
export function markedEntries(input: Json): MarkedEntry[] {
  const out: MarkedEntry[] = [];
  const composite = Array.isArray(input.tasks) || Array.isArray(input.chain);
  for (const e of launchEntries(input)) {
    if (typeof e.agent !== "string" || e.agent === "") continue;
    const marker = researchMarkerOf(e.task);
    if (marker) out.push({ entry: e, role: e.agent, marker, composite });
  }
  return out;
}

/** `[research]` and `[fact-critical]` floor: an entry weaker than its role's strong rung (or any, without ranks) gets that rung. */
export function applyResearchFloor(marked: MarkedEntry[], roles: Record<string, Json>, config: Json | undefined, maxThinking: unknown, childMaxThinking: unknown): void {
  const ranks = ranksOf(config);
  for (const m of marked) {
    const strong = launchModel(m.role, roles, "strong", maxThinking, { childMaxThinking });
    const r = roles[m.role];
    if (!strong || !isObj(r) || !isObj(r.strong) || typeof r.strong.model !== "string" || r.strong.model === "") continue; // no strong rung mapped
    const have = typeof m.entry.model === "string" ? splitLevel(m.entry.model).base : "";
    const want = splitLevel(strong.model).base;
    if (have === want) continue;
    const a = have ? tierOf(ranks, have) : null;
    const b = tierOf(ranks, want);
    if (ranks.size > 0 && a !== null && b !== null && a <= b) continue; // already as strong or stronger
    m.entry.model = strong.model;
  }
}

/** The rung of a `[fact-critical]` entry of `role`: factCriticalRung, else the security rung, else the role's strong rung; null when none. */
export function factCriticalRung(config: Json | undefined, roles: Record<string, Json>, role: string): string | null {
  const own = get(config, "ladder.research.factCriticalRung");
  if (typeof own === "string" && own.trim()) return own.trim();
  const sec = reviewerClimbConfig(config).securityRung ?? defaultSecurityRung(config, roles);
  if (sec) return sec;
  const r = roles[role];
  return isObj(r) && isObj(r.strong) && typeof r.strong.model === "string" && r.strong.model ? (launchModel(role, roles, "strong", undefined)?.model ?? null) : null;
}

/** After the rank check: write each `[fact-critical]` entry's rung (level capped by maxThinking and childMaxThinking). */
export function applyFactCriticalRungs(marked: MarkedEntry[], roles: Record<string, Json>, config: Json | undefined, maxThinking: unknown, childMaxThinking: unknown): void {
  for (const m of marked) {
    if (m.marker !== "fact-critical") continue;
    const rung = factCriticalRung(config, roles, m.role);
    if (rung) m.entry.model = cappedRung(rung, maxThinking, childMaxThinking);
  }
}

/** One `research_rung` trace record per marked entry, with the model it launches on; `kind` tells retro a single launch (counted by its usage line) from a tasks/chain entry. */
export function researchTraces(marked: MarkedEntry[]): Record<string, unknown>[] {
  return marked.map((m) => ({ event: "research_rung", role: m.role, marker: m.marker, kind: m.composite ? "entry" : "single", model: typeof m.entry.model === "string" ? splitLevel(m.entry.model).base : null }));
}
