// Review panel (ladder.reviewPanel, docs/review-climb.md): shadow models review next to the reviewer on
// the gate occasions. A `reviewer` entry whose occasion is in `gates` becomes a parallel group of
// the primary entry plus one entry per shadow model (same task text, `policy_override: true`: the
// shadows are explicit user or overlay config, written after the rank check like the security
// rung). Only the primary's verdict counts; the shadows' findings are recorded (source panel) and
// shown in an attributed block that never blocks (hidden with visible:false).
//
// pi-subagents 0.75.0 (the pinned version) accepts none of these shapes: top-level `tasks`/`chain`
// are refused as removed legacy inputs, and with `disabledFeatures: ["workflow-scripts"]` an entry
// may carry only agent and task, so no per-shadow model. Until a supported shape exists the panel
// degrades: the launch stays unchanged (the primary review runs as asked) and the trace says
// `panel {..., decision: "unsupported"}`. PANEL_REWRITE_SUPPORTED switches the rewrite back on.
import { get, type Json } from "./config.ts";
import { splitLevel } from "./launchmodel.ts";
import { cappedRung } from "./reviewerclimb.ts";
import { OCCASIONS, type Occasion, type ReviewLaunch } from "./occasion.ts";

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const baseOf = (m: string): string => splitLevel(m).base;

export interface PanelConfig {
  shadows: string[];
  gates: Occasion[];
  visible: boolean;
}

export function panelConfig(config: Json | undefined): PanelConfig {
  const sh = get(config, "ladder.reviewPanel.shadows");
  const gates = get(config, "ladder.reviewPanel.gates");
  return {
    shadows: Array.isArray(sh) ? [...new Set(sh.filter((m): m is string => typeof m === "string" && m.trim() !== "").map((m) => m.trim()))] : [],
    gates: Array.isArray(gates) ? gates.filter((g): g is Occasion => (OCCASIONS as readonly unknown[]).includes(g)) : ["pre-pr"],
    visible: get(config, "ladder.reviewPanel.visible") !== false,
  };
}

/** Whether the pinned pi-subagents runs a panel rewrite (see the header); false for 0.75.0. */
export const PANEL_REWRITE_SUPPORTED = false;

export interface PanelOptions {
  config: Json | undefined;
  /** The foreman's model (`<provider>/<id>`), never a shadow; null when unknown. */
  foreman: string | null;
  maxThinking: unknown;
  childMaxThinking: unknown;
  /** The child rank policy would refuse this model (the trace then carries policy_override). */
  refused?: (model: string) => boolean;
  /** Rewrite the launch (default PANEL_REWRITE_SUPPORTED); false traces `decision: "unsupported"` and leaves it unchanged. */
  rewrite?: boolean;
}

export interface PanelRewrite {
  /** Shadow entry -> its shadow model. */
  shadows: Map<Json, string>;
  traces: Record<string, unknown>[];
  panel: ReviewLaunch["panel"];
}

/**
 * Rewrite the gate-occasion `reviewer` entries of a launch into parallel groups (in place): a single
 * launch becomes `tasks: [primary, ...shadows]`, a `tasks` entry gets its shadows next to it, a chain
 * step becomes `{parallel: [...]}`. `occasions` (occasion.ts entryOccasions) gets the new entries.
 */
export function applyPanel(input: Json, occasions: Map<Json, Occasion>, o: PanelOptions): PanelRewrite {
  const out: PanelRewrite = { shadows: new Map(), traces: [], panel: null };
  const cfg = panelConfig(o.config);
  if (cfg.shadows.length === 0) return out;
  const foreman = o.foreman ? baseOf(o.foreman) : null;
  /** The shadow entries for a primary entry, or null when the entry is not panelled. */
  const shadowsFor = (e: Json): Json[] | null => {
    const occ = occasions.get(e);
    if (e.agent !== "reviewer" || !occ || !cfg.gates.includes(occ) || typeof e.model !== "string") return null;
    const primary = baseOf(e.model);
    const models = cfg.shadows.filter((m) => baseOf(m) !== primary && baseOf(m) !== foreman);
    if (models.length === 0) return null;
    const rec: Record<string, unknown> = { event: "panel", role: "reviewer", gate: occ, models: models.map(baseOf).join(","), primary };
    if (models.some((m) => o.refused?.(m))) rec.policy_override = true;
    if (!(o.rewrite ?? PANEL_REWRITE_SUPPORTED)) {
      out.traces.push({ ...rec, decision: "unsupported" });
      return null;
    }
    const entries = models.map((m) => {
      const s: Json = { ...e, model: cappedRung(m, o.maxThinking, o.childMaxThinking), policy_override: true };
      out.shadows.set(s, m);
      occasions.set(s, occ);
      return s;
    });
    out.traces.push(rec);
    out.panel ??= { gate: occ, primary, shadows: models.map(baseOf) };
    return entries;
  };
  const composite = Array.isArray(input.tasks) || Array.isArray(input.chain);
  if (!composite) {
    const occ = occasions.get(input);
    const primary: Json = { agent: input.agent, task: input.task, model: input.model };
    if (occ) occasions.set(primary, occ);
    const extra = shadowsFor(primary);
    if (!extra) return out;
    delete input.agent;
    delete input.task;
    delete input.model;
    input.tasks = [primary, ...extra];
    return out;
  }
  const expand = (list: unknown[], chain: boolean): unknown[] =>
    list.flatMap((e) => {
      if (!isObj(e)) return [e];
      if (Array.isArray(e.parallel)) {
        e.parallel = expand(e.parallel, false);
        return [e];
      }
      const extra = shadowsFor(e);
      if (!extra) return [e];
      return chain ? [{ parallel: [e, ...extra] }] : [e, ...extra];
    });
  if (Array.isArray(input.tasks)) input.tasks = expand(input.tasks, false);
  if (Array.isArray(input.chain)) input.chain = expand(input.chain, true);
  return out;
}

export interface PanelFinding {
  file: string;
  line: number | null;
  class: string;
  note: string;
}

const near = (a: PanelFinding, b: PanelFinding): boolean =>
  a.file === b.file && a.class === b.class && (a.line === null || b.line === null ? a.line === b.line : Math.abs(a.line - b.line) <= 3);

const lineOf = (f: PanelFinding, also: string[]): string => `- ${f.file}${f.line !== null ? `:${f.line}` : ""} [${f.class}] ${f.note}${also.length ? ` (also found by ${also.join(", ")})` : ""}`.trimEnd();

/**
 * The attributed block of a panel review: the primary's findings first, then "Shadow findings (do
 * not block)" grouped by model. A finding several models located (same file and class, lines within
 * 3) is listed once, under the first model that found it (primary first), tagged "also found by".
 * visible:false leaves the shadow section out (the records are written regardless). "" = nothing to show.
 */
export function composePanelBlock(primary: { model: string; findings: PanelFinding[] }, shadows: { model: string; findings: PanelFinding[] }[], visible: boolean): string {
  const groups = [primary, ...shadows].map((g) => ({ model: g.model, items: g.findings.map((f) => ({ f, also: [] as string[] })) }));
  for (let i = 1; i < groups.length; i++) {
    groups[i].items = groups[i].items.filter(({ f }) => {
      for (let j = 0; j < i; j++) {
        const hit = groups[j].items.find((x) => near(x.f, f));
        if (hit) {
          if (!hit.also.includes(groups[i].model)) hit.also.push(groups[i].model);
          return false;
        }
      }
      return true;
    });
  }
  // visible:false shows the primary's own findings only, without the shadow models' names
  if (!visible) for (const it of groups[0].items) it.also = [];
  const lines: string[] = [];
  if (groups[0].items.length) lines.push(`Review findings, primary (${primary.model}):`, ...groups[0].items.map((x) => lineOf(x.f, x.also)));
  const shadowLines = visible ? groups.slice(1).filter((g) => g.items.length).flatMap((g) => [`${g.model}:`, ...g.items.map((x) => lineOf(x.f, x.also))]) : [];
  if (shadowLines.length) lines.push("Shadow findings (do not block):", ...shadowLines);
  return lines.length ? `pi-foreman review panel\n${lines.join("\n")}` : "";
}
