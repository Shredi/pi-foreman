// Children widget (radar item 11): one line per subagent run of this session and per opened session,
// shown below the editor in the tui. Zero model tokens: in-memory run state, the usage log (read
// incrementally) and sessions.json. The same run view feeds the live-state file (livestate.ts).
import fs from "node:fs";
import path from "node:path";
import { abbrev } from "./footer.ts";
import { parseLines } from "./usage.ts";

export const WIDGET_KEY = "foreman-children";
export const MAX_ROWS = 8;
const RENDER_GAP_MS = 1000;

export type RunState = "working" | "ask" | "done";
export type Rung = "model" | "strong" | null;

export interface RunView {
  launchId: string;
  role: string;
  rung: Rung;
  state: RunState;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  startedAt: number;
  endedAt: number | null;
}

export interface SessionRow {
  label: string;
  status: string;
  /** ms epoch of last.at, else opened (NaN when unparsable). */
  at: number;
}

/** Rung of a single launch: bottom = the role's own model with a strong rung above it. */
export function rungOf(roles: Record<string, unknown> | undefined, role: string, bottom: boolean): Rung {
  if (bottom) return "model";
  const r = roles?.[role];
  const strong = r && typeof r === "object" ? (r as { strong?: { model?: unknown } }).strong : undefined;
  return strong && typeof strong.model === "string" && strong.model ? "strong" : null;
}

// ------------------------------------------------------------------ usage per launch id

interface Sum {
  input: number;
  output: number;
  cost: number;
}

/** Reads the usage file of this foreman session incrementally and sums tokens and cost per launch id. */
export class UsageTail {
  private offset = 0;
  private rest: Buffer = Buffer.alloc(0);
  readonly by = new Map<string, Sum>();

  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }

  refresh(): void {
    try {
      const size = fs.statSync(this.file).size;
      if (size < this.offset) {
        this.offset = 0;
        this.rest = Buffer.alloc(0);
        this.by.clear();
      }
      if (size === this.offset) return;
      const fd = fs.openSync(this.file, "r");
      let chunk: Buffer;
      try {
        chunk = Buffer.alloc(size - this.offset);
        const n = fs.readSync(fd, chunk, 0, chunk.length, this.offset);
        chunk = chunk.subarray(0, n);
        this.offset += n;
      } finally {
        fs.closeSync(fd);
      }
      const all = Buffer.concat([this.rest, chunk]);
      const cut = all.lastIndexOf(10);
      this.rest = cut < 0 ? all : all.subarray(cut + 1);
      if (cut < 0) return;
      for (const l of parseLines(all.subarray(0, cut).toString("utf8"))) {
        if (!l.launchId) continue;
        const s = this.by.get(l.launchId) ?? { input: 0, output: 0, cost: 0 };
        s.input += (l.input || 0) + (l.cacheRead || 0) + (l.cacheWrite || 0);
        s.output += l.output || 0;
        s.cost += l.cost?.total || 0;
        this.by.set(l.launchId, s);
      }
    } catch {
      // no file yet, or unreadable: totals stay as they are
    }
  }
}

// ------------------------------------------------------------------ run tracking

interface Row {
  runId: string;
  launchId: string | null;
  roles: string[];
  rung: Rung;
  startedAt: number;
  endedAt: number | null;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

export class ChildRuns {
  private pending = new Map<string, { launchId: string | null; role: string; rung: Rung }>();
  private rows = new Map<string, Row>();
  private ended = new Map<string, number>();
  private prompts = new Map<string, string>();

  private readonly tail: UsageTail | null;
  constructor(tail: UsageTail | null = null) {
    this.tail = tail;
  }

  /** tool_call of a subagent launch (single launches carry a usage launch id). */
  onLaunchCall(callId: string, p: { launchId: string | null; role: string; rung: Rung }): void {
    this.pending.set(callId, p);
    if (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value as string);
  }

  /** tool_result of a launch that got a run id. */
  onLaunched(callId: string, runId: string, roles: readonly string[], now = Date.now()): void {
    const p = this.pending.get(callId);
    this.pending.delete(callId);
    const list = p?.role ? [p.role] : [...roles];
    this.rows.set(runId, { runId, launchId: p?.launchId ?? null, roles: list, rung: p?.rung ?? null, startedAt: now, endedAt: this.ended.get(runId) ?? null });
    if (this.rows.size > 64) this.rows.delete(this.rows.keys().next().value as string);
  }

  onRunEnd(runId: string, now = Date.now()): void {
    const r = this.rows.get(runId);
    if (r) r.endedAt = now;
    else {
      // A foreground run ends before its tool_result names it.
      this.ended.set(runId, now);
      if (this.ended.size > 64) this.ended.delete(this.ended.keys().next().value as string);
    }
  }

  /** `permissions:ui_prompt`: only a forwarded one (a child asked) counts, by the requesting agent name. */
  onPrompt(data: unknown): void {
    const d = (data && typeof data === "object" ? data : {}) as { requestId?: unknown; forwarding?: unknown };
    const f = d.forwarding && typeof d.forwarding === "object" ? (d.forwarding as { requesterAgentName?: unknown }) : null;
    if (typeof d.requestId !== "string" || !f) return;
    this.prompts.set(d.requestId, text(f.requesterAgentName));
  }

  onDecision(data: unknown): void {
    const id = (data as { requestId?: unknown } | undefined)?.requestId;
    if (typeof id === "string") this.prompts.delete(id);
  }

  clearPrompts(): void {
    this.prompts.clear();
  }

  /**
   * Matching rule: a run is in ask while an open forwarded prompt names one of its roles
   * (requesterAgentName === role id). With n open prompts for a role, its n oldest working runs ask.
   */
  views(): RunView[] {
    this.tail?.refresh();
    const left = new Map<string, number>();
    for (const name of this.prompts.values()) left.set(name, (left.get(name) ?? 0) + 1);
    const out: RunView[] = [];
    for (const r of [...this.rows.values()].sort((a, b) => a.startedAt - b.startedAt)) {
      let state: RunState = r.endedAt !== null ? "done" : "working";
      if (state === "working") {
        const hit = r.roles.find((x) => (left.get(x) ?? 0) > 0);
        if (hit !== undefined) {
          left.set(hit, (left.get(hit) ?? 0) - 1);
          state = "ask";
        }
      }
      const u = r.launchId ? this.tail?.by.get(r.launchId) : undefined;
      out.push({ launchId: r.launchId ?? r.runId, role: r.roles.join("+") || "child", rung: r.rung, state, tokensIn: u?.input ?? 0, tokensOut: u?.output ?? 0, cost: u?.cost ?? 0, startedAt: r.startedAt, endedAt: r.endedAt });
    }
    return out;
  }
}

// ------------------------------------------------------------------ formatting

const usd = (v: number): string => `$${v.toFixed(2)}`;

export function runLine(r: RunView): string {
  return [r.role, ...(r.rung ? [r.rung] : []), r.state, `↑${abbrev(r.tokensIn)} ↓${abbrev(r.tokensOut)}`, usd(r.cost)].join(" · ");
}

export function ageText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function sessionLine(r: SessionRow, now: number): string {
  return [r.label, r.status, Number.isFinite(r.at) ? ageText(now - r.at) : "?"].join(" · ");
}

/** Opened sessions of `parent` from sessions.json (closed and failed ones are not shown). */
export function readOpened(agentDir: string, parent: string | null): SessionRow[] {
  if (!parent) return [];
  try {
    const data = JSON.parse(fs.readFileSync(path.join(agentDir, "pi-foreman", "state", "sessions.json"), "utf8")) as { sessions?: unknown };
    if (!Array.isArray(data.sessions)) return [];
    const out: SessionRow[] = [];
    for (const e of data.sessions) {
      if (!e || typeof e !== "object") continue;
      const s = e as { parent?: unknown; label?: unknown; status?: unknown; opened?: unknown; last?: unknown };
      if (s.parent !== parent || text(s.status) === "closed" || text(s.status) === "failed") continue;
      const last = s.last && typeof s.last === "object" ? text((s.last as { at?: unknown }).at) : "";
      out.push({ label: text(s.label) || "session", status: text(s.status) || "?", at: Date.parse(last || text(s.opened)) });
    }
    return out;
  } catch {
    return [];
  }
}

/** One summary line for the finished runs of the current batch. */
export function doneLine(done: RunView[]): string {
  const sum = (f: (r: RunView) => number): number => done.reduce((a, r) => a + f(r), 0);
  return [`${done.length} done`, `↑${abbrev(sum((r) => r.tokensIn))} ↓${abbrev(sum((r) => r.tokensOut))}`, usd(sum((r) => r.cost))].join(" · ");
}

/**
 * Active runs, then opened sessions, then one summary line for the runs that finished during the batch
 * (ended at or after `since`, the start of the oldest active run); at most 8 lines. With no active run
 * only the opened sessions remain.
 */
export function widgetLines(runs: RunView[], sessions: SessionRow[], now: number, since: number | null = null): string[] {
  const active = runs.filter((r) => r.state !== "done");
  const opened = [...sessions].sort((a, b) => (b.at || 0) - (a.at || 0)).map((s) => sessionLine(s, now));
  if (!active.length) return opened.slice(0, MAX_ROWS);
  const from = since ?? Math.min(...active.map((r) => r.startedAt));
  const done = runs.filter((r) => r.state === "done" && r.endedAt !== null && r.endedAt >= from);
  return [...active.map(runLine), ...opened, ...(done.length ? [doneLine(done)] : [])].slice(0, MAX_ROWS);
}

/** Cut a line to the terminal width so a row never wraps (one widget line = one screen row). */
export function fitLine(s: string, width: number): string {
  const cps = [...s];
  if (width <= 0) return "";
  return cps.length <= width ? s : cps.slice(0, Math.max(0, width - 1)).join("") + "…";
}

// ------------------------------------------------------------------ widget

/** The one component of a shown widget; lines are swapped in place, Pi keeps the same component. */
export class WidgetRows {
  lines: string[];
  disposed = false;
  constructor(lines: string[]) {
    this.lines = lines;
  }
  render(width: number): string[] {
    return this.lines.map((l) => fitLine(l ? ` ${l}` : "", width));
  }
  invalidate(): void {
    // stateless: render reads the current lines
  }
  dispose(): void {
    this.disposed = true;
  }
}

export interface WidgetCtx {
  mode?: string;
  ui: { setWidget(key: string, content: ((tui: { requestRender(): void }) => WidgetRows) | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void };
}

/**
 * Height is stable while a batch of runs is active: rows are reserved for the most lines shown in the batch
 * (blank padding, never shrinking), finished runs fold into one summary line, and updates swap the lines of the
 * same component. When the last active run ends the rows are released (only opened sessions stay, else cleared).
 * Unchanged content never reaches Pi: no setWidget, no requestRender.
 */
export class ChildWidget {
  readonly runs: ChildRuns;
  private last = 0;
  private shown = "";
  private reserved = 0;
  private rows: WidgetRows | null = null;
  private tui: { requestRender(): void } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ctx: WidgetCtx | null = null;
  private opts: { enabled: boolean; agentDir: string; intercomId: string | null } | null = null;

  constructor(usageFile: string) {
    this.runs = new ChildRuns(new UsageTail(usageFile));
  }

  /** Render now or, within a second of the last render, once at the end of that second. Never throws. */
  request(ctx: WidgetCtx, opts: { enabled: boolean; agentDir: string; intercomId: string | null }, now = Date.now()): void {
    this.ctx = ctx;
    this.opts = opts;
    if (!opts.enabled || ctx.mode !== "tui") return;
    const wait = this.last + RENDER_GAP_MS - now;
    if (wait <= 0) return this.render(now);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.render(Date.now());
    }, wait);
    this.timer.unref?.();
  }

  /** Re-render with the last context (events that carry none); no-op before the first request. */
  refresh(): void {
    if (this.ctx && this.opts) this.request(this.ctx, this.opts);
  }

  private render(now: number): void {
    this.last = now;
    try {
      if (!this.ctx || !this.opts) return;
      const views = this.runs.views();
      const lines = widgetLines(views, readOpened(this.opts.agentDir, this.opts.intercomId), now);
      if (views.some((r) => r.state !== "done")) {
        this.reserved = Math.max(this.reserved, lines.length);
        while (lines.length < this.reserved) lines.push("");
      } else this.reserved = 0;
      const key = lines.join("\n");
      if (key === this.shown && (!this.rows || !this.rows.disposed)) return;
      this.shown = key;
      if (!lines.length) {
        this.rows = null;
        this.tui = null;
        this.ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
        return;
      }
      if (this.rows && !this.rows.disposed) {
        this.rows.lines = lines;
        this.tui?.requestRender();
        return;
      }
      const rows = new WidgetRows(lines);
      this.rows = rows;
      this.ctx.ui.setWidget(WIDGET_KEY, (tui) => {
        this.tui = tui;
        return rows;
      }, { placement: "belowEditor" });
    } catch {
      // the widget is cosmetic
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ctx = null;
  }
}
