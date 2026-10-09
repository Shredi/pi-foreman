// Presence file (radar item 12): <agent dir>/pi-foreman/state/live/<sessionId>.json, one per Pi
// session, rewritten atomically on state changes (at most once a second) and every 30 s.
// sessionId is the Pi session id, the stem of state/usage/<foremanSession>.jsonl for the same session.
import fs from "node:fs";
import path from "node:path";
import type { Rung, RunState, RunView } from "./childwidget.ts";
import { openerIntercomId } from "./session.ts";

export const HEARTBEAT_MS = 30_000;
const WRITE_GAP_MS = 1000;
const MAX_RUNS = 20;

export type LiveMode = "tui" | "rpc" | "json" | "print";
export type LiveStateName = "working" | "blocked" | "idle" | "done";

export interface LiveRun {
  launchId: string;
  role: string;
  rung: Rung;
  state: RunState;
  tokensIn: number;
  tokensOut: number;
  cost: number;
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
  private readonly base: Omit<LiveFile, "heartbeatAt" | "lastEventAt" | "state" | "runs" | "intercomId">;
  private readonly idOf: () => string;
  private readonly startedMs = Date.now();
  private lastEventMs = this.startedMs;
  private working = false;
  private blocked = false;
  private done = false;
  private lastWrite = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Null when the mode writes no file (print, json, or unknown). */
  static start(init: LiveInit, runs: () => RunView[]): LiveState | null {
    const mode = init.mode;
    if (mode !== "tui" && mode !== "rpc") return null;
    const l = new LiveState(init, mode, runs);
    l.write();
    l.interval = setInterval(() => l.write(), HEARTBEAT_MS);
    l.interval.unref?.();
    return l;
  }

  private readonly runs: () => RunView[];
  private constructor(init: LiveInit, mode: LiveMode, runs: () => RunView[]) {
    this.runs = runs;
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
    };
  }

  get intercomId(): string | null {
    return this.idOf();
  }

  /** Any event worth showing as activity; schedules a write. */
  touch(): void {
    this.lastEventMs = Date.now();
    this.schedule();
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

  setBlocked(active: boolean): void {
    this.blocked = active;
    this.touch();
  }

  snapshot(now = Date.now()): LiveFile {
    let runs: LiveRun[] = [];
    try {
      runs = this.runs().slice(-MAX_RUNS).map((r) => ({
        launchId: short(r.launchId, 40),
        role: short(r.role, 40),
        rung: r.rung,
        state: r.state,
        tokensIn: Math.round(r.tokensIn),
        tokensOut: Math.round(r.tokensOut),
        cost: Math.round(r.cost * 10000) / 10000,
      }));
    } catch {
      // runs are best effort
    }
    const state: LiveStateName = this.done ? "done" : this.blocked ? "blocked" : this.working ? "working" : "idle";
    return { v: this.base.v, sessionId: this.base.sessionId, intercomId: this.idOf(), ...this.base, cwd: short(this.base.cwd, 300), heartbeatAt: new Date(now).toISOString(), lastEventAt: new Date(this.lastEventMs).toISOString(), state, runs };
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
