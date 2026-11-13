// A parent learns that a child session waits on the owner. The parent detects, the child sends nothing: a 60 s timer reads the recorded state of
// each of this session's own child sessions (a local one through its live file, a remote one through the registry's stored `remoteLive`) and,
// after `sessions.blockedNoticeSeconds`, appends ONE custom message of its own type (`pi-foreman-child-blocked`, never `foreman_wake`, never system
// text). Information only; the text is fixed words plus the registry label, a time and a kind word from a fixed list: nothing a child wrote.
// Once per episode (the sent keys live in a small file of this session's own state, so a reload sends nothing twice); one quiet "answered" note
// when an announced dialog is answered. The module only reads the session registry and the children's files.
import fs from "node:fs";
import path from "node:path";
import { cleanLabel } from "./herdr.ts";
import { readLive } from "./identity.ts";
import { HEARTBEAT_MS, liveDir } from "./livestate.ts";
import { SLOW_POLL_MS } from "./remotewatch.ts";
import { readRegistry } from "./session.ts";
import type { SessionEntry } from "./session.ts";

export const CHILD_BLOCKED_TYPE = "pi-foreman-child-blocked";
export const CHILD_BLOCKED_TICK_MS = 60_000;
export const DEFAULT_NOTICE_SECONDS = 600;
/** A live file whose heartbeat is older than this is a dead or frozen session, not a waiting one (three heartbeats). */
const STALE_LIVE_MS = 3 * HEARTBEAT_MS;
/** A remote child counts only while the watcher made contact (a poll or a stream line) within three slow polls. */
const STALE_CONTACT_MS = 3 * SLOW_POLL_MS;
/** The only kind words a notice prints; anything else a live file holds prints as `dialog`. */
const KIND_WORDS = new Set(["approval", "question", "checkpoint", "script", "confirm", "dialog"]);
const OPEN = new Set(["open", "pending", "closing"]);
const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** `sessions.blockedNoticeSeconds` as seconds: a non-negative finite number, else the default; 0 turns the notice off. */
export function noticeSeconds(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_NOTICE_SECONDS;
}

export const childBlockedStateFile = (agentDir: string, sessionId: string): string => path.join(agentDir, "pi-foreman", "state", "child-blocked", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "") || "session"}.json`);

/** `2026-11-13 07:06 UTC`: printed from a parsed time, so no child text can ride in it. */
const stamp = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const noticeText = (label: string, sinceMs: number, kind: unknown): string => {
  const word = typeof kind === "string" && KIND_WORDS.has(kind) ? kind : "dialog";
  return `Child session ${label} has waited on its owner since ${stamp(sinceMs)} (${word}). Information only: the owner answers the dialog in that session's pane. Nothing for you to do: do not answer or approve for it, do not steer it, redo its work or work around it. Tell the owner if they are in this session.`;
};

export const clearedText = (label: string, waitedMs: number): string => `Child session ${label}: its dialog was answered after ${duration(waitedMs)}.`;

type Obs = { blocked: false } | { blocked: true; since: number; kind: unknown };
interface Sent {
  child: string;
  label: string;
  since: number;
}
type Cancel = () => void;

export interface ChildBlockedDeps {
  agentDir: string;
  /** This session's Pi session id: the name of the sent-keys file. */
  sessionId: string;
  /** This session's intercom id: the registry entries it opened carry it as `parent`. */
  opener: () => string;
  /** The configured `sessions.blockedNoticeSeconds`. */
  seconds: () => number;
  /** The remote watcher's last contact with a child (ms), undefined when none since this process started. */
  contact?: (child: string) => number | undefined;
  /** `wake`: the notice starts a turn on an idle parent (queued as a follow-up during a run); the quiet note never does. */
  send: (text: string, wake: boolean) => void;
  trace?: (rec: Record<string, unknown>) => void;
  now?: () => number;
  timer?: (fn: () => void, ms: number) => Cancel;
}

export class ChildBlocked {
  private readonly d: ChildBlockedDeps;
  private sent = new Map<string, Sent>();
  private cancel: Cancel | null = null;

  constructor(d: ChildBlockedDeps) {
    this.d = d;
    this.load();
  }

  start(): void {
    if (this.cancel) return;
    const t = this.d.timer ?? ((fn, ms) => {
      const h = setInterval(fn, ms);
      h.unref?.();
      return () => clearInterval(h);
    });
    this.cancel = t(() => this.tick(), CHILD_BLOCKED_TICK_MS);
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  /** One pass over this session's own children. Never throws, never writes the registry. */
  tick(): void {
    try {
      const secs = this.d.seconds();
      if (!(secs > 0)) return;
      const now = (this.d.now ?? Date.now)();
      const opener = this.d.opener();
      const mine = readRegistry(this.d.agentDir).sessions.filter((e) => e.parent === opener && OPEN.has(String(e.status)));
      let dirty = false;
      for (const e of mine) {
        const obs = this.observe(e, now);
        if (!obs) continue; // unreadable, stale or skipped: nothing is known, so nothing is said
        for (const [key, rec] of [...this.sent]) {
          if (rec.child !== e.child || (obs.blocked && obs.since === rec.since)) continue;
          this.sent.delete(key); // the announced episode ended
          dirty = true;
          const waitedMs = now - rec.since;
          this.d.trace?.({ event: "child_blocked_cleared", label: rec.label, waitedMs });
          this.d.send(clearedText(rec.label, waitedMs), false);
        }
        if (!obs.blocked) continue;
        const label = cleanLabel(e.label);
        const key = `${label}\n${obs.since}`;
        if (this.sent.has(key) || now - obs.since < secs * 1000) continue;
        this.sent.set(key, { child: e.child, label, since: obs.since });
        dirty = true;
        this.d.trace?.({ event: "child_blocked_notice", label, waitedMs: now - obs.since });
        this.d.send(noticeText(label, obs.since, obs.kind), true);
      }
      const open = new Set(mine.map((e) => e.child));
      for (const [key, rec] of [...this.sent]) {
        if (open.has(rec.child)) continue;
        this.sent.delete(key); // the child is closed or gone
        dirty = true;
      }
      if (dirty) this.save();
    } catch {
      // a pass never breaks the session
    }
  }

  /** What the recorded state says about one child; undefined = not known now (no notice, no "answered" note). */
  private observe(e: SessionEntry, now: number): Obs | undefined {
    if (typeof e.machine === "string") return this.observeRemote(e, now);
    if (typeof e.handoff !== "string" || !e.handoff) return undefined;
    const id = readLive(e.handoff)?.piSessionId;
    if (!id || !SAFE_ID.test(id)) return undefined;
    let f: { heartbeatAt?: unknown; blockedOn?: unknown; ownerBlockedSince?: unknown; blockedKind?: unknown };
    try {
      f = JSON.parse(fs.readFileSync(path.join(liveDir(this.d.agentDir), `${id}.json`), "utf8"));
    } catch {
      return undefined;
    }
    const beat = typeof f.heartbeatAt === "string" ? Date.parse(f.heartbeatAt) : NaN;
    if (!Number.isFinite(beat) || now - beat > STALE_LIVE_MS) return undefined;
    if (f.blockedOn !== "owner") return { blocked: false };
    const since = typeof f.ownerBlockedSince === "string" ? Date.parse(f.ownerBlockedSince) : NaN;
    return Number.isFinite(since) ? { blocked: true, since, kind: f.blockedKind } : undefined;
  }

  private observeRemote(e: SessionEntry, now: number): Obs | undefined {
    if (e.ask && typeof e.ask === "object") return undefined; // the remote state does not say owner or parent: an open ask is the parent's to answer
    const seen = this.d.contact?.(e.child);
    if (seen === undefined || now - seen > STALE_CONTACT_MS) return undefined;
    const rl = e.remoteLive as { state?: unknown; seenAt?: unknown } | undefined;
    if (rl?.state !== "blocked") return { blocked: false };
    const since = typeof rl.seenAt === "string" ? Date.parse(rl.seenAt) : NaN;
    return Number.isFinite(since) ? { blocked: true, since, kind: "dialog" } : undefined;
  }

  private load(): void {
    try {
      const j = JSON.parse(fs.readFileSync(childBlockedStateFile(this.d.agentDir, this.d.sessionId), "utf8")) as { sent?: Record<string, Partial<Sent>> };
      for (const [k, r] of Object.entries(j.sent ?? {})) if (r && typeof r.child === "string" && typeof r.label === "string" && typeof r.since === "number") this.sent.set(k, { child: r.child, label: r.label, since: r.since });
    } catch {
      // no file yet
    }
  }

  /** Atomic: temp file in the same folder, then rename. */
  private save(): void {
    const file = childBlockedStateFile(this.d.agentDir, this.d.sessionId);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, sent: Object.fromEntries(this.sent) })}\n`, "utf8");
      fs.renameSync(tmp, file);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // nothing to clean
      }
    }
  }
}
