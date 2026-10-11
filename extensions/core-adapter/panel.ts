// Review panel (ladder.reviewPanel, docs/review.md): shadow models review the same work as the
// reviewer on the gate occasions. The primary launch is never rewritten (pi-subagents 0.75.0 runs no
// parallel shape with a per-entry model). Instead, when the primary review of a gate ends, the
// harness opens a pending panel and tells the foreman to issue one single `reviewer` launch per
// shadow model, each carrying `[panel-shadow:<model>]`. Such a launch is checked here
// (shadowLaunch), gets the primary's task and the shadow model, and never counts: only the primary's
// verdict marks items, gates and opens the PR gate. When every expected shadow ended, or after
// `waitSeconds`, the attributed block is sent once (hidden shadow section with visible:false).
import { get, type Json } from "./config.ts";
import { launchEntries } from "./ladder.ts";
import { splitLevel } from "./launchmodel.ts";
import { cappedRung } from "./reviewerclimb.ts";
import { OCCASIONS, occasionOf, type Occasion, type ReviewLaunch } from "./occasion.ts";

const baseOf = (m: string): string => splitLevel(m).base;

export interface PanelConfig {
  shadows: string[];
  gates: Occasion[];
  visible: boolean;
  /** Seconds a pending panel waits for its shadows before it composes without them. */
  waitSeconds: number;
}

export const PANEL_WAIT_SECONDS = 600;

export function panelConfig(config: Json | undefined): PanelConfig {
  const sh = get(config, "ladder.reviewPanel.shadows");
  const gates = get(config, "ladder.reviewPanel.gates");
  const wait = get(config, "ladder.reviewPanel.waitSeconds");
  return {
    shadows: Array.isArray(sh) ? [...new Set(sh.filter((m): m is string => typeof m === "string" && m.trim() !== "").map((m) => m.trim()))] : [],
    gates: Array.isArray(gates) ? gates.filter((g): g is Occasion => (OCCASIONS as readonly unknown[]).includes(g)) : ["pre-pr"],
    visible: get(config, "ladder.reviewPanel.visible") !== false,
    waitSeconds: typeof wait === "number" && Number.isInteger(wait) && wait >= 1 ? wait : PANEL_WAIT_SECONDS,
  };
}

/** The shadow models (bases) a primary on `primary` expects: the configured shadows minus the primary's and the foreman's base. */
export function expectedShadows(cfg: PanelConfig, primary: string, foreman: string | null): string[] {
  const own = new Set([baseOf(primary), ...(foreman ? [baseOf(foreman)] : [])]);
  return [...new Set(cfg.shadows.map(baseOf).filter((m) => !own.has(m)))];
}

/**
 * The panel of a primary launch (after every model rule, before the facts block): the first
 * `reviewer` entry on a gate occasion with a model, its expected shadows and its task text. Null
 * when the panel is off, no entry is on a gate or no shadow is left.
 */
export function primaryPanel(input: Json, occasions: Map<Json, Occasion>, config: Json | undefined, foreman: string | null): { panel: NonNullable<ReviewLaunch["panel"]>; task: string } | null {
  const cfg = panelConfig(config);
  if (cfg.shadows.length === 0) return null;
  for (const e of launchEntries(input)) {
    const occ = occasions.get(e);
    if (e.agent !== "reviewer" || !occ || !cfg.gates.includes(occ) || typeof e.model !== "string") continue;
    const shadows = expectedShadows(cfg, e.model, foreman);
    if (shadows.length === 0) return null;
    return { panel: { gate: occ, primary: baseOf(e.model), shadows }, task: typeof e.task === "string" ? e.task : "" };
  }
  return null;
}

const MARKER = /\[panel-shadow:([^\]\s]+)\]/i;

/** The model a `[panel-shadow:<model>]` marker names, or null. */
export function parseShadowMarker(text: unknown): string | null {
  const m = typeof text === "string" ? MARKER.exec(text) : null;
  return m ? m[1] : null;
}

/** A pending panel as the shadow check sees it (PendingPanels keeps the rest). */
export interface PendingView {
  /** The primary's run id. */
  id: string;
  gate: Occasion;
  /** The primary's model base. */
  primary: string;
  /** The primary's task text before the facts block. */
  task: string;
  expected: string[];
  launched: Set<string>;
}

export type ShadowRefusal = "child" | "not_single" | "not_reviewer" | "panel_off" | "not_configured" | "no_pending" | "occasion" | "duplicate" | "rank_policy";

const REFUSAL_TEXT: Record<ShadowRefusal, string> = {
  child: "children never launch shadow reviews",
  not_single: "a shadow review is one single launch, never tasks, chain or an action",
  not_reviewer: "a shadow review launches the `reviewer` agent",
  panel_off: "ladder.reviewPanel has no shadow models",
  not_configured: "that model is not one of ladder.reviewPanel.shadows",
  no_pending: "no panel review is waiting for that model; launch a shadow only after the primary gate review ended, as the harness lists it",
  occasion: "the occasion marker must match the panel's gate",
  duplicate: "that shadow review was already launched for this panel",
  rank_policy: "the child rank policy refuses that model",
};

export type ShadowDecision =
  | { kind: "none" }
  | { kind: "refused"; reason: ShadowRefusal; message: string; trace: Record<string, unknown> }
  | { kind: "launch"; base: string; model: string; task: string; pending: PendingView; trace: Record<string, unknown> };

export interface ShadowOptions {
  config: Json | undefined;
  isChild: boolean;
  maxThinking: unknown;
  childMaxThinking: unknown;
  /** The child rank policy's refusal message for a model, null when allowed. */
  refused?: (model: string) => string | null;
}

/**
 * A launch carrying `[panel-shadow:<model>]` (anywhere in its task texts): refused with a reason, or
 * bound to the newest open pending panel of its gate that expects the model and has not launched it.
 * A launch gets the configured model clamped (cappedRung) and the primary's task behind the marker.
 */
export function shadowLaunch(input: Json, pendings: readonly PendingView[], o: ShadowOptions): ShadowDecision {
  const texts = [input.task, ...launchEntries(input).map((e) => e.task)];
  const named = texts.map(parseShadowMarker).find((m) => m !== null);
  if (!named) return { kind: "none" };
  const base = baseOf(named);
  const gate = occasionOf(typeof input.task === "string" ? input.task : texts.find((t) => parseShadowMarker(t)));
  const cfg = panelConfig(o.config);
  const refuse = (reason: ShadowRefusal, p?: PendingView, extra?: string): ShadowDecision => ({
    kind: "refused",
    reason,
    message: `pi-foreman: shadow review refused [panel_refused:${reason}]: ${REFUSAL_TEXT[reason]}.${extra ? ` ${extra}` : ""} Shadow reviews never block; continue without it.`,
    trace: { event: "panel", role: "reviewer", gate: p?.gate ?? gate, models: base, primary: p?.primary ?? null, decision: "refused", reason },
  });
  if (o.isChild) return refuse("child");
  const action = input.action;
  if (Array.isArray(input.tasks) || Array.isArray(input.chain) || (action !== undefined && action !== null && String(action).trim() !== "")) return refuse("not_single");
  if (input.agent !== "reviewer") return refuse("not_reviewer");
  if (cfg.shadows.length === 0) return refuse("panel_off");
  const configured = cfg.shadows.find((m) => baseOf(m) === base);
  if (!configured) return refuse("not_configured");
  const expecting = pendings.filter((p) => p.expected.includes(base));
  if (expecting.length === 0) return refuse("no_pending");
  const sameGate = expecting.filter((p) => p.gate === gate);
  if (sameGate.length === 0) return refuse("occasion", expecting[expecting.length - 1]);
  const open = sameGate.filter((p) => !p.launched.has(base));
  if (open.length === 0) return refuse("duplicate", sameGate[sameGate.length - 1]);
  const pending = open[open.length - 1];
  const model = cappedRung(configured, o.maxThinking, o.childMaxThinking);
  const rank = o.refused?.(model) ?? null;
  if (rank) return refuse("rank_policy", pending, rank);
  return { kind: "launch", base, model, task: `[panel-shadow:${base}] ${pending.task}`, pending, trace: { event: "panel", role: "reviewer", gate: pending.gate, models: base, primary: pending.primary, decision: "launched" } };
}

/** The run-end text of a primary gate review: one ready-to-send shadow launch per expected model. */
export function shadowInstruction(gate: Occasion, models: readonly string[], waitSeconds: number): string {
  return [
    `pi-foreman review panel (${gate}): issue these shadow reviews now, one subagent call each, then continue. They are optional for the verdict and never block: skip them when the budget is tight; the panel closes on its own after ${waitSeconds}s.`,
    ...models.map((m) => `subagent {agent: "reviewer", task: "[panel-shadow:${m}] [${gate}]"}`),
  ].join("\n");
}

interface PendingPanel extends PendingView {
  primaryFindings: Promise<PanelFinding[]>;
  ended: Map<string, Promise<PanelFinding[] | null>>;
  visible: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface PendingPanelsDeps {
  /** Send the composed block (once per panel; never called with ""). */
  send: (text: string) => void;
  trace: (rec: Record<string, unknown>) => void;
}

/**
 * Open panels of a session, oldest first. A panel composes once: when every expected shadow ended,
 * or when its timer fires (missing shadows are listed as not run, traced `decision: timeout`).
 */
export class PendingPanels {
  private list: PendingPanel[] = [];
  private deps: PendingPanelsDeps;
  constructor(deps: PendingPanelsDeps) {
    this.deps = deps;
  }

  /** The open panels, oldest first. */
  views(): readonly PendingView[] {
    return this.list;
  }

  open(p: Omit<PendingView, "launched"> & { primaryFindings: Promise<PanelFinding[]>; visible: boolean; waitMs: number }): void {
    const { waitMs, ...rest } = p;
    const panel: PendingPanel = { ...rest, launched: new Set(), ended: new Map(), timer: null };
    panel.timer = setTimeout(() => void this.compose(panel, true), waitMs);
    panel.timer.unref?.();
    this.list.push(panel);
  }

  /** A shadow launch passed every check. */
  launched(id: string, base: string): void {
    this.list.find((p) => p.id === id)?.launched.add(base);
  }

  /** A shadow run ended: its findings, or null when it produced no result. */
  ended(id: string, base: string, findings: Promise<PanelFinding[] | null>): void {
    const panel = this.list.find((p) => p.id === id);
    if (!panel) return;
    panel.ended.set(base, findings.catch(() => null));
    if (panel.expected.every((m) => panel.ended.has(m))) void this.compose(panel, false);
  }

  /** Stop every timer (session shutdown); nothing is sent. */
  clear(): void {
    for (const p of this.list) if (p.timer) clearTimeout(p.timer);
    this.list = [];
  }

  private async compose(panel: PendingPanel, timeout: boolean): Promise<void> {
    const at = this.list.indexOf(panel);
    if (at < 0) return;
    this.list.splice(at, 1);
    if (panel.timer) clearTimeout(panel.timer);
    const missing = panel.expected.filter((m) => !panel.ended.has(m));
    if (timeout && missing.length) this.deps.trace({ event: "panel", role: "reviewer", gate: panel.gate, models: missing.join(","), primary: panel.primary, decision: "timeout" });
    const primary = await panel.primaryFindings.catch(() => []);
    const shadows: { model: string; findings: PanelFinding[] }[] = [];
    const notRun = [...missing];
    for (const m of panel.expected) {
      const f = panel.ended.has(m) ? await panel.ended.get(m) : undefined;
      if (f) shadows.push({ model: m, findings: f });
      else if (f === null) notRun.push(m);
    }
    const order = new Map(panel.expected.map((m, i) => [m, i]));
    notRun.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const text = composePanelBlock({ model: panel.primary, findings: primary }, shadows, panel.visible, notRun);
    if (text) this.deps.send(text);
  }
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
 * Shadow models that never delivered (`missing`) are listed as "Not run". visible:false leaves the
 * shadow section out (the records are written regardless). "" = nothing to show.
 */
export function composePanelBlock(primary: { model: string; findings: PanelFinding[] }, shadows: { model: string; findings: PanelFinding[] }[], visible: boolean, missing: readonly string[] = []): string {
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
  if (visible && missing.length) shadowLines.push(`Not run: ${missing.join(", ")}`);
  if (shadowLines.length) lines.push("Shadow findings (do not block):", ...shadowLines);
  return lines.length ? `pi-foreman review panel\n${lines.join("\n")}` : "";
}
