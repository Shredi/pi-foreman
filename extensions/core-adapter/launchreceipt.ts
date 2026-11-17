// The rung note of a `subagent` launch receipt: the triggers the ladder and sizing already computed for the launch (Climb[] and
// the sizing plans), put in one short phrase per role. Nothing is recalculated here.
import type { Json } from "./config.ts";
import { ABOVE_STRONG_REASON, RANK_CAPPED_REASON, type Climb } from "./ladder.ts";
import type { EntryPlan, SizingConfig } from "./sizing.ts";

const HANDOFF = new Set(["context", "turns", "stuck", "checks_failed"]);

function sizingText(p: EntryPlan | undefined, cfg: SizingConfig): string | null {
  if (!p) return "sizing";
  if (p.rule === "risk_top") return `risk ${p.risk.filter((r) => cfg.topRisks.includes(r)).join(", ")}`;
  if (p.rule === "risk_strong") return `risk ${p.probe.join(", ")}`;
  if (p.rule === "large_file") return `file over ${cfg.largeFileLines} lines`;
  if (p.rule === "modules") return `over ${cfg.maxModules} modules`;
  return null;
}

function triggerOf(c: Climb, p: EntryPlan | undefined, cfg: SizingConfig): string | null {
  const source = c.source ?? "";
  if (c.reason === RANK_CAPPED_REASON) {
    if (source.startsWith("sizing")) return sizingText(p, cfg);
    if (source === "heavy") return "heavy tier";
    if (c.handoff) return `${c.handoff.cause} handoff`;
    return c.revisionReason === "review_fail" ? "revision after FAIL" : "revision";
  }
  if (HANDOFF.has(c.reason)) return `${c.reason} handoff`;
  switch (c.reason) {
    case "foreman": return "explicit strong";
    case "sizing": return sizingText(p, cfg);
    case "heavy": return "heavy tier";
    case "review_fail": return "revision after FAIL";
    case ABOVE_STRONG_REASON: return "already above strong rung";
    default: return c.reason;
  }
}

/** The one parenthetical of a receipt entry: the bottom-rung reason and the climb triggers, either or both; empty with neither. */
export function rungNote(bottom: string | undefined, climb: string | undefined): string {
  const parts = [...(bottom !== undefined ? [`bottom rung: ${bottom}`] : []), ...(climb ? [climb] : [])];
  return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

/** Per role, the receipt phrase (`strong rung: risk parser, revision after FAIL`); a role with no climb has none. */
export function climbNotesOf(climbs: readonly Climb[], plans: readonly EntryPlan[], cfg: SizingConfig, heavy: readonly Json[] = []): Map<string, string> {
  const parts = new Map<string, { rung: string; skipped: boolean; why: Set<string> }>();
  // the heavy tier's default strong launch has no Climb record; it enters as a climb of reason `heavy`
  const all: Climb[] = [...climbs, ...heavy.map((entry) => ({ entry, role: "builder", from: "", to: "", reason: "heavy" }))];
  for (const c of all) {
    const p = plans.find((x) => x.entry === c.entry);
    const skipped = c.reason === RANK_CAPPED_REASON;
    const cur = parts.get(c.role) ?? { rung: "strong", skipped, why: new Set<string>() };
    if (p?.target === "top" && !skipped) cur.rung = "top";
    cur.skipped &&= skipped;
    const t = triggerOf(c, p, cfg);
    if (t) cur.why.add(t);
    // a handoff, reason or revision climb that sizing also rated at or above the launch rung names the sizing trigger too
    if (!skipped && c.reason !== "sizing" && p && p.target !== "default" && !p.combo.refuse && !p.combo.note.some((n) => n === "override" || n === "capped")) {
      const s = sizingText(p, cfg);
      if (s) cur.why.add(s);
    }
    parts.set(c.role, cur);
  }
  const out = new Map<string, string>();
  for (const [role, v] of parts) if (v.why.size > 0) out.set(role, `${v.skipped ? "strong rung skipped by rank policy" : `${v.rung} rung`}: ${[...v.why].join(", ")}`);
  return out;
}
