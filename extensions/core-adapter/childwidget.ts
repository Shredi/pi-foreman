// Children widget (radar item 11): one line per subagent run of this session and per opened session,
// shown below the editor in the tui. Zero model tokens: in-memory run state, the usage log (read
// incrementally) and sessions.json. The same run view feeds the live-state file (livestate.ts).
import fs from "node:fs";
import path from "node:path";
import { abbrev } from "./footer.ts";
import { parseLines } from "./usage.ts";
import { priceRecord } from "./cost.ts";
import { pullSummary } from "./remotesession.ts";
import type { SessionEntry } from "./session.ts";
import type { PriceTable } from "./cost.ts";
import { cellWidth, runSymbol, SPINNER_MS, spinnerFrame, symbolSet } from "./symbols.ts";
import type { SymbolKey } from "./symbols.ts";

export const WIDGET_KEY = "foreman-children";
export const MAX_ROWS = 8;
const RENDER_GAP_MS = 1000;

export type RunState = "working" | "ask" | "done";
export type Rung = "model" | "strong" | null;

export interface RunView {
  launchId: string;
  role: string;
  rung: Rung;
  /** The launch's explicit `model` (as given, e.g. `provider/id`); null when the role's own model runs. */
  model: string | null;
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
  /** `pull <age>` and the last pull error of a pull-mode remote entry (remotesession.ts pullSummary). */
  pull?: string;
  /** Remote entries: the machine (row `label@machine`) and the state word of remoteState. */
  machine?: string;
  state?: string;
}

/** A background row of the foreman (index.ts): a foreman_wait wait (`wait`), a foreman_bg command (`bg`) or a PR watch (`pr #n`). */
export interface BackgroundRow {
  label: string;
  detail: string;
  /** ms epoch the row started. */
  startedAt: number;
}

/** Per-request options: the `widget.children` gate, the agent dir, the presence id, the glyph set and the background rows (foreman only). */
export interface WidgetOpts {
  enabled: boolean;
  agentDir: string;
  intercomId: string | null;
  symbols?: unknown;
  background?: () => BackgroundRow[];
  /** Opt-in: a running run shows the spinner frame of the clock (250 ms steps) and a render tick runs while a run is active. Off = static glyphs. */
  spinner?: boolean;
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
  private readonly prices: PriceTable | null;
  /** `prices`: a record without a reported cost is priced from it (cost.ts). */
  constructor(file: string, prices: PriceTable | null = null) {
    this.file = file;
    this.prices = prices;
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
        s.cost += priceRecord(l, this.prices).cost.total;
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
  model: string | null;
  startedAt: number;
  endedAt: number | null;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

export class ChildRuns {
  private pending = new Map<string, { launchId: string | null; role: string; rung: Rung; model?: string | null }>();
  private rows = new Map<string, Row>();
  private ended = new Map<string, number>();
  private prompts = new Map<string, string>();

  private readonly tail: UsageTail | null;
  constructor(tail: UsageTail | null = null) {
    this.tail = tail;
  }

  /** tool_call of a subagent launch (single launches carry a usage launch id). */
  onLaunchCall(callId: string, p: { launchId: string | null; role: string; rung: Rung; model?: string | null }): void {
    this.pending.set(callId, p);
    if (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value as string);
  }

  /** tool_result of a launch that got a run id. */
  onLaunched(callId: string, runId: string, roles: readonly string[], now = Date.now()): void {
    const p = this.pending.get(callId);
    this.pending.delete(callId);
    const list = p?.role ? [p.role] : [...roles];
    this.rows.set(runId, { runId, launchId: p?.launchId ?? null, roles: list, rung: p?.rung ?? null, model: p?.model ?? null, startedAt: now, endedAt: this.ended.get(runId) ?? null });
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
  /** Duration (once ended) and priced cost of one run, by run id; null for an unknown run. */
  info(runId: string): { ms: number | null; cost: number } | null {
    const r = this.rows.get(runId);
    if (!r) return null;
    this.tail?.refresh();
    const u = r.launchId ? this.tail?.by.get(r.launchId) : undefined;
    return { ms: r.endedAt !== null ? r.endedAt - r.startedAt : null, cost: u?.cost ?? 0 };
  }

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
      out.push({ launchId: r.launchId ?? r.runId, role: r.roles.join("+") || "child", rung: r.rung, model: r.model, state, tokensIn: u?.input ?? 0, tokensOut: u?.output ?? 0, cost: u?.cost ?? 0, startedAt: r.startedAt, endedAt: r.endedAt });
    }
    return out;
  }
}

// ------------------------------------------------------------------ formatting

const usd = (v: number): string => `$${v.toFixed(2)}`;

/** State glyph (ui.symbols set) + the run's fields. */
export function runLine(r: RunView, symbols?: unknown, now?: number): string {
  const set = symbolSet(symbols);
  const glyph = now !== undefined && r.state === "working" ? spinnerFrame(set.spinner, now) : set[runSymbol(r.state)];
  return glyph + " " + [r.role, ...(r.rung ? [r.rung] : []), r.state, `↑${abbrev(r.tokensIn)} ↓${abbrev(r.tokensOut)}`, usd(r.cost)].join(" · ");
}

export function ageText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function sessionLine(r: SessionRow, now: number): string {
  return [r.label, r.status, Number.isFinite(r.at) ? ageText(now - r.at) : "?", ...(r.pull ? [r.pull] : [])].join(" · ");
}

/** The radar's live-state window for a remote child: heartbeat age plus pull age must stay under this (foreman_radar.py REMOTE_LIVE_MAX). */
const REMOTE_LIVE_MAX_S = 90;

/**
 * State word of a remote entry, as the radar derives it: an open ask and `closing` come first; the child's
 * `remoteLive` state counts while the last pull is younger than 3 x the interval + 30 s and heartbeat age plus pull
 * age is under 90 s; a pull entry without a pull success for that window is `lost`.
 */
export function remoteState(e: SessionEntry, nowMs: number, intervalSeconds = 20): string {
  const status = text(e.status);
  if ((status === "open" || status === "pending") && e.ask && typeof e.ask === "object") return "ask";
  if (status === "closing") return "closing";
  const at = typeof e.pulledAt === "string" ? Date.parse(e.pulledAt) : NaN;
  const pullAge = Number.isFinite(at) ? Math.max(0, (nowMs - at) / 1000) : null;
  const fresh = pullAge !== null && pullAge < 3 * intervalSeconds + 30;
  const live = e.remoteLive && typeof e.remoteLive === "object" ? (e.remoteLive as { state?: unknown; heartbeatAgeSeconds?: unknown }) : {};
  const beat = live.heartbeatAgeSeconds;
  if (pullAge !== null && fresh && typeof beat === "number" && beat + pullAge < REMOTE_LIVE_MAX_S) {
    if (live.state === "blocked" || live.state === "working" || live.state === "done") return live.state;
    return "idle";
  }
  if (status === "pending") return "starting";
  if (status !== "open" || e.returnPath !== "pull") return status || "?";
  if (pullAge === null) return "starting";
  return fresh ? "idle" : "lost";
}

const REMOTE_GLYPH: Record<string, SymbolKey> = { ask: "asking", blocked: "blocked", working: "working", done: "done", lost: "lost", idle: "idle", closing: "waiting", starting: "waiting" };

/** `<glyph> label@machine · state · age[ · pull …]` of a remote entry. */
export function remoteLine(r: SessionRow, now: number, symbols?: unknown): string {
  const set = symbolSet(symbols);
  const state = r.state ?? r.status;
  return set[REMOTE_GLYPH[state] ?? "idle"] + " " + [`${r.label}@${r.machine}`, state, Number.isFinite(r.at) ? ageText(now - r.at) : "?", ...(r.pull ? [r.pull] : [])].join(" · ");
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
      const pull = pullSummary(e as SessionEntry, Date.now(), ageText);
      const machine = (e as { machine?: unknown }).machine;
      const remote = typeof machine === "string" && machine !== "";
      const pulledAt = (e as { pulledAt?: unknown }).pulledAt;
      const pulled = remote && typeof pulledAt === "string" ? Date.parse(pulledAt) : NaN;
      const seen = Date.parse(last || text(s.opened));
      const at = remote && Number.isFinite(pulled) ? Math.max(Number.isFinite(seen) ? seen : 0, pulled) : seen;
      out.push({ label: text(s.label) || "session", status: text(s.status) || "?", at, ...(pull ? { pull } : {}), ...(remote ? { machine, state: remoteState(e as SessionEntry, Date.now()) } : {}) });
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

/** At most MAX_ROWS lines: the first MAX_ROWS - 1, then one `+<n> more` row for the rest. */
export function foldRows(lines: string[]): string[] {
  return lines.length <= MAX_ROWS ? lines : [...lines.slice(0, MAX_ROWS - 1), `+${lines.length - MAX_ROWS + 1} more`];
}

/**
 * Active runs, then background rows, then opened sessions, then one summary line for the runs that finished during
 * the batch (ended at or after `since`, the start of the oldest active run); at most 8 lines (foldRows). With no active
 * run only the background rows and the opened sessions remain.
 */
export function widgetLines(runs: RunView[], sessions: SessionRow[], now: number, since: number | null = null, symbols?: unknown, background: BackgroundRow[] = [], spin = false): string[] {
  const active = runs.filter((r) => r.state !== "done");
  const bg = background.map((b) => [b.label, b.detail, ageText(now - b.startedAt)].join(" · "));
  const opened = [...sessions].sort((a, b) => (b.at || 0) - (a.at || 0)).map((s) => (s.machine ? remoteLine(s, now, symbols) : sessionLine(s, now)));
  if (!active.length) return foldRows([...bg, ...opened]);
  const from = since ?? Math.min(...active.map((r) => r.startedAt));
  const done = runs.filter((r) => r.state === "done" && r.endedAt !== null && r.endedAt >= from);
  return foldRows([...active.map((r) => runLine(r, symbols, spin ? now : undefined)), ...bg, ...opened, ...(done.length ? [doneLine(done)] : [])]);
}

/** Cut a line to the terminal width so a row never wraps (one widget line = one screen row). */
export function fitLine(s: string, width: number): string {
  if (width <= 0) return "";
  const cps = [...s];
  const w = (c: string): number => cellWidth(c.codePointAt(0) ?? 0);
  if (cps.reduce((a, c) => a + w(c), 0) <= width) return s;
  let used = 0;
  let out = "";
  for (const c of cps) {
    if (used + w(c) > width - 1) break;
    used += w(c);
    out += c;
  }
  return out + "…";
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
 * Height is stable while a batch of runs or a background row is active: rows are reserved for the most lines shown in the batch
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
  private tick: ReturnType<typeof setTimeout> | null = null;
  private ctx: WidgetCtx | null = null;
  private opts: WidgetOpts | null = null;

  constructor(usageFile: string, prices: PriceTable | null = null) {
    this.runs = new ChildRuns(new UsageTail(usageFile, prices));
  }

  /** Render now or, within a second of the last render, once at the end of that second. Never throws. */
  request(ctx: WidgetCtx, opts: WidgetOpts, now = Date.now()): void {
    this.ctx = ctx;
    this.opts = opts;
    if (!opts.enabled) return this.hide(ctx);
    if (ctx.mode !== "tui") return;
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

  /** `widget.children` off: a shown widget is removed and a pending render dropped (nothing is set when none was shown). */
  private hide(ctx: WidgetCtx): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopTick();
    if (!this.rows) return;
    this.rows = null;
    this.tui = null;
    this.shown = "";
    ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
  }

  private stopTick(): void {
    if (this.tick) clearTimeout(this.tick);
    this.tick = null;
  }

  private render(now: number): void {
    this.last = now;
    try {
      if (!this.ctx || !this.opts) return;
      const views = this.runs.views();
      const background = this.opts.background?.() ?? [];
      const spin = this.opts.spinner === true;
      this.stopTick();
      if (spin && views.some((r) => r.state === "working")) {
        this.tick = setTimeout(() => {
          this.tick = null;
          this.render(Date.now());
        }, SPINNER_MS);
        this.tick.unref?.();
      }
      const lines = widgetLines(views, readOpened(this.opts.agentDir, this.opts.intercomId), now, null, this.opts.symbols, background, spin);
      if (views.some((r) => r.state !== "done") || background.length) {
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
    this.stopTick();
    this.ctx = null;
  }
}
