// Presence file (radar item 12): <agent dir>/pi-foreman/state/live/<sessionId>.json, one per Pi
// session, rewritten atomically on state changes (at most once a second) and every 30 s.
// sessionId is the Pi session id, the stem of state/usage/<foremanSession>.jsonl for the same session.
import fs from "node:fs";
import path from "node:path";
import type { Rung, RunState, RunView } from "./childwidget.ts";
import { openerIntercomId } from "./session.ts";
import { parseAskHeader, ASK_FILE } from "./askcontract.ts";
import { readOwnAddonTasks } from "./bg.ts";
import type { AddonTask } from "./bg.ts";
import { askOpen } from "./ruling.ts";
import { childHandoffDirs } from "./owned.ts";

export const HEARTBEAT_MS = 30_000;
const WRITE_GAP_MS = 1000;
const MAX_RUNS = 20;
const MAX_WAITS = 20;
const MAX_DOTS = 14;

export type LiveMode = "tui" | "rpc" | "json" | "print";
export type LiveStateName = "working" | "blocked" | "waiting" | "idle" | "done";

/** One active foreman_wait (WaitRuntime.list()); Herdr's own status for the pane stays working. */
export interface LiveWait {
  id: string;
  kind: string;
  note: string;
  ageSeconds: number;
  leftSeconds: number;
  /** A foreman_bg command (the sidebar lists it with the tasks). */
  bg?: boolean;
  /** The synthetic `pr_watch` entry: the PR numbers being watched. */
  prs?: number[];
}

/** An open ask of this session's own handoff (`# Ask <n>: <topic>` in ask.md). */
export interface LiveAsk {
  n: number;
  topic: string;
}

/** One sidebar dot: a tracked PR (`src` pr, `n` its number) or an item of the external status hook (`src` ext, `n` null). */
export interface LiveDot {
  n: number | null;
  state: "fail" | "run" | "ok" | "none";
  label: string;
  src: "pr" | "ext";
}

export interface LiveRun {
  launchId: string;
  role: string;
  rung: Rung;
  /** The launch's explicit model as given (`provider/id`), else null. */
  model: string | null;
  state: RunState;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  /** ISO time the run ended; null while it runs. */
  endedAt: string | null;
}

export interface LiveFile {
  v: 1;
  sessionId: string;
  intercomId: string | null;
  parentIntercom: string | null;
  handoff: string | null;
  label: string | null;
  cwd: string;
  pid: number;
  mode: LiveMode;
  startedAt: string;
  heartbeatAt: string;
  lastEventAt: string;
  state: LiveStateName;
  runs: LiveRun[];
  /** Active long waits; ageSeconds is as of heartbeatAt. */
  waits: LiveWait[];
  /** This session's running bg_run add-on tasks (no log tails); present only while one runs. */
  tasks?: AddonTask[];
  /** Open asks of the own handoff; present only while one is open. */
  asks?: LiveAsk[];
  /** Sidebar dots (PR states, external status items), at most 14; present only when there are any. */
  dots?: LiveDot[];
  /** env HERDR_PANE_ID, else null. */
  paneId: string | null;
  /** The session's own usage as the footer shows it: in = input + cache read + cache write, out = output; cost = list price. */
  tokensIn: number;
  tokensOut: number;
  cost: number;
  /** ISO time the session became blocked (blockers empty -> non-empty); null when not blocked. */
  blockedSince: string | null;
  /** Sidebar presence (R11 P4); `state` stays for older readers: blocked = waiting-owner, waiting-external reads as working. */
  presence: PresenceName;
  /** Host pressure (pressure.ts); present only when the level is high or critical. */
  pressure?: { level: "high" | "critical"; reasons: string[] };
}

export type PresenceName = "working" | "waiting-owner" | "waiting-external" | "idle" | "done";

/** done > waiting-owner > working > waiting-external > idle. */
export function presenceState(i: { done: boolean; owner: boolean; turn: boolean; children: boolean; externalWaits: boolean }): PresenceName {
  return i.done ? "done" : i.owner ? "waiting-owner" : i.turn || i.children ? "working" : i.externalWaits ? "waiting-external" : "idle";
}

export const liveDir = (agentDir: string): string => path.join(agentDir, "pi-foreman", "state", "live");

/** `<YYYYmmdd-HHMMSS>-<slug>[-<6hex>]` -> slug, else null. */
export function labelOfHandoff(handoff: string | null | undefined): string | null {
  if (!handoff) return null;
  const base = handoff.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  const m = /^\d{8}-\d{6}-(.+?)(?:-[0-9a-f]{6})?$/.exec(base);
  return m ? m[1] : null;
}

/**
 * The id other sessions record as this session's parent: the same rule as `openerIntercomId` (session.ts) —
 * PI_INTERCOM_SESSION_ID, PI_INTERCOM_STABLE_ID, `stableId` in <agent dir>/intercom/config.json, else the Pi
 * session id — so radar can join an opened session to its opener.
 */
export function intercomIdOf(env: Record<string, string | undefined>, agentDir: string, sessionId: string): string {
  return openerIntercomId(env, agentDir, sessionId);
}

const short = (s: string, n = 80): string => (s.length > n ? s.slice(0, n) : s);

export interface SessionTotals {
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

export interface LiveInit {
  agentDir: string;
  sessionId: string;
  cwd: string;
  mode: string | undefined;
  env: Record<string, string | undefined>;
  pid?: number;
}

export class LiveState {
  private readonly file: string;
  private readonly base: Omit<LiveFile, "heartbeatAt" | "lastEventAt" | "state" | "runs" | "waits" | "tasks" | "asks" | "intercomId" | "tokensIn" | "tokensOut" | "cost" | "blockedSince" | "presence">;
  private readonly idOf: () => string;
  private readonly startedMs = Date.now();
  private readonly cwd: string;
  private readonly sessionId: string;
  private readonly agentDir: string;
  private lastEventMs = this.startedMs;
  private working = false;
  /** Open blocking sources: "ui" (Pi's ui_prompt_start..end, released by typed input) and own:<n> (own asks). */
  private readonly blockers = new Set<string>();
  private holds = 0;
  private blockedSinceMs: number | null = null;
  private done = false;
  private lastWrite = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Null when the mode writes no file (print, json, or unknown). */
  static start(init: LiveInit, runs: () => RunView[], totals?: () => SessionTotals | null, waits?: () => LiveWait[], pressure?: () => { level: string; reasons: string[] } | null, dots?: () => LiveDot[]): LiveState | null {
    const mode = init.mode;
    if (mode !== "tui" && mode !== "rpc") return null;
    const l = new LiveState(init, mode, runs, totals, waits, pressure, dots);
    l.write();
    l.interval = setInterval(() => l.write(), HEARTBEAT_MS);
    l.interval.unref?.();
    return l;
  }

  private readonly runs: () => RunView[];
  private readonly totals: (() => SessionTotals | null) | undefined;
  private readonly waits: (() => LiveWait[]) | undefined;
  private readonly pressure: (() => { level: string; reasons: string[] } | null) | undefined;
  private readonly dotsOf: (() => LiveDot[]) | undefined;
  private constructor(init: LiveInit, mode: LiveMode, runs: () => RunView[], totals?: () => SessionTotals | null, waits?: () => LiveWait[], pressure?: () => { level: string; reasons: string[] } | null, dots?: () => LiveDot[]) {
    this.runs = runs;
    this.dotsOf = dots;
    this.pressure = pressure;
    this.totals = totals;
    this.waits = waits;
    this.cwd = init.cwd;
    this.sessionId = init.sessionId;
    this.agentDir = init.agentDir;
    this.file = path.join(liveDir(init.agentDir), `${init.sessionId}.json`);
    const handoff = (init.env.PI_FOREMAN_HANDOFF_DIR ?? "").trim() || null;
    // Re-read on each write: pi-intercom publishes PI_INTERCOM_SESSION_ID after session_start.
    this.idOf = () => intercomIdOf(init.env, init.agentDir, init.sessionId);
    this.base = {
      v: 1,
      sessionId: init.sessionId,
      parentIntercom: (init.env.PI_FOREMAN_PARENT_INTERCOM ?? "").trim() || null,
      handoff,
      label: labelOfHandoff(handoff),
      cwd: init.cwd,
      pid: init.pid ?? process.pid,
      mode,
      startedAt: new Date(this.startedMs).toISOString(),
      paneId: (init.env.HERDR_PANE_ID ?? "").trim() || null,
    };
  }

  get intercomId(): string | null {
    return this.idOf();
  }

  /** Any event worth showing as activity; schedules a write. */
  touch(): void {
    this.lastEventMs = Date.now();
    this.schedule();
    for (const cb of [...this.observers]) {
      try {
        cb();
      } catch {
        // observers are best effort
      }
    }
  }

  private readonly observers = new Set<() => void>();
  /** Called after every event LiveState handles (touch and everything built on it). Returns the unsubscribe. */
  onChange(cb: () => void): () => void {
    this.observers.add(cb);
    return () => void this.observers.delete(cb);
  }

  /** The current state name without building a snapshot. */
  get stateName(): LiveStateName {
    return this.done ? "done" : this.blockers.size > 0 ? "blocked" : this.working || this.waitList().length > 0 ? "working" : "idle"; // a pending wait is work: never shown idle or done (R6 lane 7a)
  }

  /** Presence state: an open ask/checkpoint/prompt, a running turn or child, a pending external wait, else idle. */
  get presenceName(): PresenceName {
    let children = false;
    try {
      children = this.runs().some((r) => r.endedAt === null && r.state === "working");
    } catch {
      // runs are best effort
    }
    return presenceState({ done: this.done, owner: this.blockers.size > 0, turn: this.working, children, externalWaits: this.waitList().length > 0 });
  }

  private waitList(): LiveWait[] {
    try {
      return (this.waits?.() ?? []).slice(0, MAX_WAITS).map((w) => ({ id: short(w.id, 40), kind: short(w.kind, 20), note: short(w.note, 80), ageSeconds: Math.round(w.ageSeconds), leftSeconds: Math.round(w.leftSeconds), ...(w.bg === true ? { bg: true } : {}), ...(Array.isArray(w.prs) ? { prs: w.prs.filter((n) => Number.isInteger(n)).slice(0, MAX_WAITS) } : {}) }));
    } catch {
      return []; // waits are best effort
    }
  }

  private taskList(): AddonTask[] {
    try {
      return readOwnAddonTasks(this.cwd, this.sessionId).slice(0, MAX_WAITS).map((t) => ({ ...t, tail: [] }));
    } catch {
      return []; // tasks are best effort
    }
  }

  private dotList(): LiveDot[] {
    try {
      const states = ["fail", "run", "ok", "none"];
      return (this.dotsOf?.() ?? []).filter((d) => states.includes(d.state)).slice(0, MAX_DOTS).map((d) => ({ n: d.src === "pr" && Number.isInteger(d.n) ? d.n : null, state: d.state, label: short(String(d.label), 20), src: d.src === "pr" ? "pr" : "ext" }));
    } catch {
      return []; // dots are best effort
    }
  }

  /** The open asks of the dirs where this session is the child (the ask signal's own source). */
  private askList(): LiveAsk[] {
    try {
      const out: LiveAsk[] = [];
      for (const dir of childHandoffDirs(path.join(this.agentDir, "pi-foreman", "handoffs"), this.idOf())) {
        if (!askOpen(dir)) continue;
        const head = parseAskHeader(fs.readFileSync(path.join(dir, ASK_FILE), "utf8"));
        if (head) out.push({ n: head.n, topic: short(head.topic, 80) });
      }
      return out.slice(0, 4);
    } catch {
      return []; // asks are best effort
    }
  }

  /** Write the presence file now, bypassing the 1 s throttle. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.write();
  }

  onAgentStart(): void {
    this.working = true;
    this.touch();
  }

  /** `idle` = ctx.isIdle?.() at agent_settled; anything but true keeps the session working. */
  onSettled(idle: boolean | undefined): void {
    if (idle === true) this.working = false;
    this.touch();
  }

  /** One source on or off; the session is blocked while any source is open, so sources never clear each other. */
  setBlocked(active: boolean, source = "ui"): void {
    const was = this.blockers.size > 0;
    if (active) this.blockers.add(source);
    else this.blockers.delete(source);
    if (!was && this.blockers.size > 0) this.blockedSinceMs = Date.now();
    else if (this.blockers.size === 0) this.blockedSinceMs = null;
    this.touch();
  }

  /** An own ask: blocked until the returned release runs (idempotent), whatever Pi's prompt events do. */
  hold(): () => void {
    const key = `own:${++this.holds}`;
    this.setBlocked(true, key);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.setBlocked(false, key);
    };
  }

  snapshot(now = Date.now()): LiveFile {
    let runs: LiveRun[] = [];
    try {
      runs = this.runs().slice(-MAX_RUNS).map((r) => ({
        launchId: short(r.launchId, 40),
        role: short(r.role, 40),
        rung: r.rung,
        model: typeof r.model === "string" && r.model ? short(r.model, 80) : null,
        state: r.state,
        tokensIn: Math.round(r.tokensIn),
        tokensOut: Math.round(r.tokensOut),
        cost: Math.round(r.cost * 10000) / 10000,
        endedAt: r.endedAt === null ? null : new Date(r.endedAt).toISOString(),
      }));
    } catch {
      // runs are best effort
    }
    let t: SessionTotals | null = null;
    try {
      t = this.totals?.() ?? null;
    } catch {
      // totals are best effort
    }
    const state = this.stateName;
    let pressure: LiveFile["pressure"];
    try {
      const pr = this.pressure?.();
      if (pr && (pr.level === "high" || pr.level === "critical")) pressure = { level: pr.level, reasons: pr.reasons.slice(0, 6).map((r) => short(r, 40)) };
    } catch {
      // pressure is best effort
    }
    const asks = this.askList();
    const tasks = this.taskList();
    const dots = this.dotList();
    return { v: this.base.v, sessionId: this.base.sessionId, intercomId: this.idOf(), ...this.base, cwd: short(this.base.cwd, 300), heartbeatAt: new Date(now).toISOString(), lastEventAt: new Date(this.lastEventMs).toISOString(), state, runs, waits: this.waitList(), ...(tasks.length ? { tasks } : {}), ...(asks.length ? { asks } : {}), ...(dots.length ? { dots } : {}), tokensIn: Math.round(t?.tokensIn ?? 0), tokensOut: Math.round(t?.tokensOut ?? 0), cost: Math.round((t?.cost ?? 0) * 10000) / 10000, blockedSince: this.blockedSinceMs === null ? null : new Date(this.blockedSinceMs).toISOString(), presence: this.presenceName, ...(pressure ? { pressure } : {}) };
  }

  private schedule(): void {
    if (this.done || this.timer) return;
    const wait = this.lastWrite + WRITE_GAP_MS - Date.now();
    if (wait <= 0) return this.write();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, wait);
    this.timer.unref?.();
  }

  /** Atomic: temp file in the same folder, then rename. Never throws. */
  write(): void {
    this.lastWrite = Date.now();
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.snapshot(this.lastWrite)) + "\n", "utf8");
      fs.renameSync(tmp, this.file);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // nothing to clean
      }
    }
  }

  /** session_shutdown: a last write with state done, timers cleared. */
  stop(): void {
    if (this.done) return;
    this.done = true;
    if (this.interval) clearInterval(this.interval);
    if (this.timer) clearTimeout(this.timer);
    this.interval = this.timer = null;
    this.lastEventMs = Date.now();
    this.write();
  }
}
