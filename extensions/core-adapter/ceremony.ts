// Proportional ceremony (design §6). The tier routes; the core spawn gate enforces.
//
// How a tier meets the gate (ledger item 62), through the gate's own knob
// LEDGER_GUARD_THRESHOLD (ledger_guard_spawn.py threshold()):
//   trivial, or no tier decided yet  -> core default threshold (1500 chars): one short
//                                       explorer launch passes without a ledger
//   standard / heavy                 -> threshold 0 (a bound ledger without a Tier: line
//                                       counts as standard): any launch with task text needs this
//                                       session's own ledger first
// A second launch, or a non-explorer launch, while trivial escalates to standard first.

export type Tier = "trivial" | "standard" | "heavy";
export type TierSource = "default" | "ledger" | "user" | "auto" | "foreman";

export const TIERS: readonly Tier[] = ["trivial", "standard", "heavy"];
const RANK: Record<Tier, number> = { trivial: 0, standard: 1, heavy: 2 };

export interface CeremonyState {
  tier: Tier;
  source: TierSource;
  spawns: number;
  files: string[];
  reasons: string[];
  /** The foreman, the user or a ledger header recorded a tier (a later escalation keeps it). */
  triaged?: boolean;
  /** The edit mode refused a foreman change (editmode.ts): the task needs a builder, so a trivial triage counts as standard. */
  needsChange?: boolean;
}

export function isTier(v: unknown): v is Tier {
  return typeof v === "string" && (TIERS as readonly string[]).includes(v);
}

export function initialCeremony(defaultTier: unknown): CeremonyState {
  return { tier: isTier(defaultTier) ? defaultTier : "standard", source: "default", spawns: 0, files: [], reasons: [] };
}

/** Automatic change: only upward. The config default is not a triage, so any tier replaces it. */
export function escalate(s: CeremonyState, tier: Tier, source: "ledger" | "auto", reason: string): CeremonyState {
  if (s.source === "default" && source === "ledger") {
    return { ...s, tier, source, reasons: [...s.reasons, reason], triaged: true };
  }
  if (RANK[tier] <= RANK[s.tier]) return source === "ledger" && !s.triaged ? { ...s, triaged: true } : s;
  return { ...s, tier, source, reasons: [...s.reasons, reason], triaged: s.triaged || source === "ledger" };
}

/** `/ceremony <tier>`: the user may move the tier either way. */
export function userOverride(s: CeremonyState, tier: Tier): CeremonyState {
  return { ...s, tier, source: "user", reasons: [...s.reasons, `user set ${tier}`], triaged: true };
}

/** `Tier: <tier>` in the ledger header (first 40 lines; markdown emphasis allowed). */
export function parseTierHeader(text: string): Tier | null {
  const head = text.split(/\r?\n/).slice(0, 40).join("\n");
  const m = /^[\s>*_-]*\**\s*Tier\s*\**\s*:\s*\**\s*(trivial|standard|heavy)\b/im.exec(head);
  return m ? (m[1].toLowerCase() as Tier) : null;
}

/**
 * Tier a bound ledger stands for: its `Tier:` header, or `standard` when it has none (decision
 * C12, the stricter option: a ledger means the task was not trivial). No ledger stays untriaged.
 */
export function ledgerTier(text: string): { tier: Tier; reason: string } {
  const tier = parseTierHeader(text);
  return tier ? { tier, reason: `ledger header Tier: ${tier}` } : { tier: "standard", reason: "bound ledger without a Tier: line" };
}

/** Before a subagent launch reaches the gate. */
export function beforeSpawn(s: CeremonyState, agents: string[]): CeremonyState {
  if (s.tier !== "trivial") return s;
  if (s.spawns >= 1) return escalate(s, "standard", "auto", "second child launch");
  if (agents.some((a) => a !== "explorer")) return escalate(s, "standard", "auto", `non-explorer launch (${agents.join(", ")})`);
  return s;
}

export function afterSpawn(s: CeremonyState): CeremonyState {
  return { ...s, spawns: s.spawns + 1 };
}

/** The file a successful tool call changed, counted toward `heavyFileCount`: write/edit `path`, foreman_copy/foreman_move `dst`. */
export function changedFileOf(toolName: string, input: Record<string, unknown>): unknown {
  if (toolName === "write" || toolName === "edit") return input.path;
  if (toolName === "foreman_copy" || toolName === "foreman_move") return input.dst;
  return undefined;
}

/** Count distinct files written/edited outside .workflow/; more than heavyFileCount -> heavy. */
export function onFileChanged(s: CeremonyState, file: string, heavyFileCount: number): CeremonyState {
  if (/[\\/]\.workflow[\\/]/i.test(file) || s.files.includes(file)) return s;
  const next = { ...s, files: [...s.files, file] };
  if (heavyFileCount > 0 && next.files.length > heavyFileCount) return escalate(next, "heavy", "auto", `more than ${heavyFileCount} files changed`);
  return next;
}

function signalPattern(signal: string): RegExp {
  const words = signal.trim().split(/[-\s_]+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Whole word plus simple inflections: delete -> deletes/deleted/deleting/deletion.
  const last = words.pop() ?? "";
  const inflected = /e$/i.test(last) ? `${last.slice(0, -1)}(?:e|es|ed|ing|ion|ions)` : `${last}(?:s|es|ed|ing)?`;
  return new RegExp(`\\b${[...words, inflected].join("[-\\s_]+")}\\b`, "i");
}

/** heavySignals named in a user prompt (whole words; `public-api` also matches "public api"). */
export function promptSignals(prompt: string, signals: unknown): string[] {
  if (!Array.isArray(signals)) return [];
  return signals.filter((s): s is string => typeof s === "string" && s.trim() !== "" && signalPattern(s).test(prompt));
}

/** LEDGER_GUARD_THRESHOLD for the spawn gate, or null to keep the core default. */
export function gateThreshold(s: CeremonyState): number | null {
  if (s.tier === "trivial" || s.source === "default") return null;
  return 0;
}

export function tierLine(s: CeremonyState): string {
  const how = s.source === "default" ? "config default, not triaged yet" : s.source === "user" ? "set by the user" : s.source === "ledger" ? "from the ledger header" : s.source === "foreman" ? "triaged by the foreman" : s.triaged ? "escalated automatically" : "escalated automatically, not triaged yet";
  return `Current ceremony tier: ${s.tier} (${how}).`;
}
