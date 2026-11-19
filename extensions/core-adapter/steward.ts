// The report steward (docs/retro.md#steward): opt-in (`steward.enabled`), one main session per repository owns the report list. `/foreman steward on` takes a lock
// in the store dir, sends `instructions/steward.md` once as a message (never system text: the cached prefix only grows) and arms a watch. The watch is
// persisted like the PR watch (a custom session entry) and restored on reload and resume. Every tick refreshes the lock, so the age break of `takeLock` never
// lets a second session take a live lock; a lock of a dead session goes stale and can be taken. The wake is a notification with counts only, never report text.
import fs from "node:fs";
import path from "node:path";
import { get, type Json } from "./config.ts";
import { foldRows, readRows, storeFor, type Entry } from "./reports.ts";
import { dropLock, ownsLock, takeLock } from "./statefile.ts";
import { realTimers, type Timers } from "./prwatch.ts";

export const STEWARD_ENTRY = "pi-foreman-steward";
/** The wake message and the instruction message. */
export const STEWARD_WAKE_TYPE = "pi-foreman-steward";
export const STEWARD_TEXT_TYPE = "pi-foreman-steward-text";

export interface StewardSettings {
  enabled: boolean;
  minNew: number;
  maxWaitHours: number;
  checkMinutes: number;
  maxProposals: number;
}

const posInt = (v: unknown, d: number): number => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : d);

/** `steward.*` of the merged config, defaults for anything unset or invalid. */
export function stewardSettings(config: Json | undefined): StewardSettings {
  return {
    enabled: get(config, "steward.enabled") === true,
    minNew: posInt(get(config, "steward.minNew"), 3),
    maxWaitHours: posInt(get(config, "steward.maxWaitHours"), 24),
    checkMinutes: posInt(get(config, "steward.checkMinutes"), 30),
    maxProposals: posInt(get(config, "steward.maxProposals"), 3),
  };
}

/** The steward lock file of the store of `cwd`. */
export const lockFileOf = (cwd: string): string => path.join(storeFor(cwd).dir, "steward.lock");
/** A lock this old has no living owner: the watch refreshes it every `checkMinutes`, three missed ticks (at least ten minutes) make it stale. */
export const staleMsOf = (checkMinutes: number): number => Math.max(3 * checkMinutes, 10) * 60_000;

export interface WakeDecision {
  wake: boolean;
  /** Ungrouped open entries with a sighting after the last pass. */
  fresh: number;
  /** All open entries. */
  open: number;
}

/** Wake when `minNew` ungrouped open entries were seen since the last pass, or `maxWaitHours` passed since it with at least one. Zero fresh entries never wake. */
export function wakeDecision(entries: readonly Entry[], settings: StewardSettings, now: number, lastPass: number): WakeDecision {
  const since = new Date(lastPass).toISOString();
  const open = entries.filter((e) => e.state === "open");
  const fresh = open.filter((e) => e.keys.length === 1 && !e.name && e.last > since).length;
  const wake = fresh >= settings.minNew || (fresh >= 1 && now - lastPass >= settings.maxWaitHours * 3_600_000);
  return { wake, fresh, open: open.length };
}

/** The wake text: counts only, no report text. */
export function wakeText(d: WakeDecision): string {
  return `pi-foreman steward: ${d.fresh} new open report${d.fresh === 1 ? "" : "s"} since the last pass (${d.open} open in all). Run the pass from your steward instructions.`;
}

export interface StewardEntry {
  v: 1;
  piSessionId: string;
  on: boolean;
  token: string | null;
  startedAt: number;
  lastPass: number;
  textSent: boolean;
}

/** The latest steward entry of the session branch: this session's record, or none (another session's or a malformed record counts as none). */
export function latestSteward(entries: readonly unknown[], piSessionId: string): StewardEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type?: unknown; customType?: unknown; data?: unknown } | null;
    if (!e || e.type !== "custom" || e.customType !== STEWARD_ENTRY) continue;
    const d = e.data as Partial<StewardEntry> | null | undefined;
    if (!d || d.v !== 1 || d.piSessionId !== piSessionId || typeof d.on !== "boolean" || typeof d.startedAt !== "number" || typeof d.lastPass !== "number") return null;
    return { v: 1, piSessionId, on: d.on, token: typeof d.token === "string" ? d.token : null, startedAt: d.startedAt, lastPass: d.lastPass, textSent: d.textSent === true };
  }
  return null;
}

export interface StewardDeps {
  cwd(): string;
  settings(): StewardSettings;
  now(): number;
  timers?: Timers;
  piSessionId(): string;
  persist(entry: StewardEntry): void;
  /** The instruction message, sent once on `on`. */
  sendText(text: string): void;
  /** The wake message; `idle` says whether the session is waiting. */
  sendWake(text: string): void;
  idle(): boolean;
  instruction(): string;
  trace(rec: Record<string, unknown>): void;
  notice(text: string): void;
}

export class StewardWatch {
  private isOn = false;
  private token: string | null = null;
  private startedAt = 0;
  private lastPass = 0;
  private textSent = false;
  private timer: unknown = null;
  private readonly timers: Timers;
  private readonly d: StewardDeps;

  constructor(deps: StewardDeps) {
    this.d = deps;
    this.timers = deps.timers ?? realTimers;
  }

  /** True while this session is the steward (session state: it never comes from text). */
  get active(): boolean {
    return this.isOn;
  }

  private entry(): StewardEntry {
    return { v: 1, piSessionId: this.d.piSessionId(), on: this.isOn, token: this.token, startedAt: this.startedAt, lastPass: this.lastPass, textSent: this.textSent };
  }

  private lock(): string {
    return lockFileOf(this.d.cwd());
  }

  private arm(): void {
    this.disarm();
    const loop = (): void => {
      this.timer = this.timers.set(() => {
        this.tick();
        if (this.isOn) loop();
      }, this.d.settings().checkMinutes * 60_000);
    };
    loop();
  }

  private disarm(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  /** `/foreman steward on`. One line back. */
  on(): { ok: boolean; text: string } {
    const st = this.d.settings();
    if (!st.enabled) return { ok: false, text: "pi-foreman: the steward is off; set steward.enabled to true to allow /foreman steward on." };
    if (this.isOn) return { ok: true, text: "pi-foreman: this session already is the steward." };
    let token: string | null;
    try {
      token = takeLock(this.lock(), this.d.now(), staleMsOf(st.checkMinutes));
    } catch {
      return { ok: false, text: "pi-foreman: the steward lock could not be written; the steward stays off." };
    }
    if (token === null) return { ok: false, text: "pi-foreman: another session is the steward of this repository." };
    this.token = token;
    this.isOn = true;
    this.startedAt = this.d.now();
    this.lastPass = this.startedAt;
    this.textSent = false;
    try {
      this.d.sendText(this.d.instruction());
      this.textSent = true;
    } catch {
      this.textSent = false; // the text could not be read: the watch still runs, the owner sees the notice
      this.d.notice("pi-foreman: the steward instructions could not be loaded.");
    }
    this.d.persist(this.entry());
    this.arm();
    this.d.trace({ event: "steward", action: "on" });
    return { ok: true, text: `pi-foreman: this session is the steward; the report list is checked every ${st.checkMinutes} minutes.` };
  }

  /** `/foreman steward off`. */
  off(): { ok: boolean; text: string } {
    if (!this.isOn) return { ok: false, text: "pi-foreman: this session is not the steward." };
    this.release();
    this.d.persist(this.entry());
    this.d.trace({ event: "steward", action: "off" });
    return { ok: true, text: "pi-foreman: the steward is off." };
  }

  private release(): void {
    this.disarm();
    if (this.token) dropLock(this.lock(), this.token);
    this.isOn = false;
    this.token = null;
  }

  /** `/foreman steward status`. */
  status(): string {
    const st = this.d.settings();
    if (!st.enabled && !this.isOn) return "pi-foreman: the steward is off (steward.enabled is false).";
    let counts = "";
    try {
      const w = wakeDecision(foldRows(readRows(storeFor(this.d.cwd()).file)), st, this.d.now(), this.lastPass || this.d.now());
      counts = `; ${w.fresh} new open report${w.fresh === 1 ? "" : "s"}, ${w.open} open in all`;
    } catch {
      counts = "; the report list is not readable";
    }
    if (this.isOn) return `pi-foreman: this session is the steward (checks every ${st.checkMinutes} minutes, wakes at ${st.minNew} new reports or after ${st.maxWaitHours} hours with one${counts}).`;
    let held = false;
    try {
      held = fs.existsSync(this.lock());
    } catch {
      held = false;
    }
    return `pi-foreman: this session is not the steward${held ? "; another session holds the steward lock" : "; no steward is running"}.`;
  }

  /** Session start: this session's persisted watch, when it was on. A lock another session now holds ends it with one notice. */
  restore(entries: readonly unknown[]): void {
    const rec = latestSteward(entries, this.d.piSessionId());
    if (!rec || !rec.on) return;
    const st = this.d.settings();
    if (!st.enabled) {
      if (rec.token) dropLock(this.lock(), rec.token);
      this.d.persist({ ...rec, on: false, token: null });
      this.d.notice("pi-foreman: the steward watch was not restored: steward.enabled is false.");
      return;
    }
    let token: string | null = null;
    try {
      token = rec.token && ownsLock(this.lock(), rec.token) ? rec.token : takeLock(this.lock(), this.d.now(), staleMsOf(st.checkMinutes));
    } catch {
      token = null;
    }
    if (token === null) {
      this.d.persist({ ...rec, on: false, token: null });
      this.d.notice("pi-foreman: the steward watch was not restored: another session is the steward of this repository.");
      return;
    }
    this.token = token;
    this.isOn = true;
    this.startedAt = rec.startedAt;
    this.lastPass = rec.lastPass;
    this.textSent = rec.textSent;
    this.refresh();
    this.d.persist(this.entry());
    this.arm();
    this.d.trace({ event: "steward", action: "restored" });
  }

  /** Touches the lock so that its age never passes the stale limit while this session lives. Returns false when the lock is no longer ours. */
  private refresh(): boolean {
    if (!this.token || !ownsLock(this.lock(), this.token)) return false;
    try {
      const t = new Date(this.d.now());
      fs.utimesSync(this.lock(), t, t);
    } catch {
      // a failed touch is retried at the next tick
    }
    return true;
  }

  /** One check: refresh the lock, then wake the session when the thresholds say so and it waits for input (a pending question counts as busy). */
  tick(): void {
    if (!this.isOn) return;
    if (!this.refresh()) {
      this.release();
      this.d.persist(this.entry());
      this.d.notice("pi-foreman: the steward lock was taken by another session; this session is no longer the steward.");
      return;
    }
    if (!this.d.idle()) return;
    let decision: WakeDecision;
    try {
      decision = wakeDecision(foldRows(readRows(storeFor(this.d.cwd()).file)), this.d.settings(), this.d.now(), this.lastPass);
    } catch {
      return; // an unreadable list: the next tick tries again
    }
    if (!decision.wake) return;
    this.lastPass = this.d.now();
    this.d.persist(this.entry());
    this.d.sendWake(wakeText(decision));
    this.d.trace({ event: "steward", action: "wake", fresh: decision.fresh, open: decision.open });
  }

  /** Session end: stop the timer and give the lock back. The persisted entry stays on, so a resume takes the watch up again. */
  clear(): void {
    this.disarm();
    if (this.token) dropLock(this.lock(), this.token);
    this.token = null;
    this.isOn = false;
  }
}
