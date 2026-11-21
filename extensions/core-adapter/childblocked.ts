// A parent learns that a child session waits on the owner. The parent detects, the child sends nothing: a 60 s timer reads the recorded state of
// each of this session's own child sessions (a local one through its live file, a remote one through the registry's stored `remoteLive`) and,
// after `sessions.blockedNoticeSeconds`, appends ONE custom message of its own type (`pi-foreman-child-blocked`, never `foreman_wake`, never system
// text). Information only; the text is fixed words plus the registry label, a time and a kind word from a fixed list: nothing a child wrote.
// Once per episode (the sent keys live in a small file of this session's own state, so a reload sends nothing twice); one quiet "answered" note
// when an announced dialog is answered. The module only reads the session registry and the children's files.
// Beside it one reminder for a question that a child sent as an intercom message and this session has not answered (intercomcarry.ts records): the
// label and the age, once per record, after `sessions.blockedNoticeSeconds`, in a message that starts a turn in an idle parent.
import fs from "node:fs";
import path from "node:path";
import { cleanLabel } from "./herdr.ts";
import { readLive } from "./identity.ts";
import { HEARTBEAT_MS, liveDir } from "./livestate.ts";
import { SLOW_POLL_MS } from "./remotewatch.ts";
import type { IntercomCarry } from "./intercomcarry.ts";
import { planWait } from "./roundstate.ts";
import { answerNewerThan } from "./ruling.ts";
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
const KIND_WORDS = new Set(["approval", "question", "checkpoint", "script", "confirm", "dialog", "hold"]);
const OPEN = new Set(["open", "pending", "closing"]);
const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** The registry entries `opener` opened that are still open (not closed or gone). */
export const openChildren = (agentDir: string, opener: string): SessionEntry[] => readRegistry(agentDir).sessions.filter((e) => e.parent === opener && OPEN.has(String(e.status)));

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
  if (word === "hold") return `Child session ${label} has held for its owner since ${stamp(sinceMs)} (hold: it waits for the owner's next message). Information only: the owner answers in that session's pane. Nothing for you to do: do not answer or approve for it, do not steer it, redo its work or work around it. Tell the owner if they are in this session.`;
  return `Child session ${label} has waited on its owner since ${stamp(sinceMs)} (${word}). Information only: the owner answers the dialog in that session's pane. Nothing for you to do: do not answer or approve for it, do not steer it, redo its work or work around it. Tell the owner if they are in this session.`;
};

/** Fixed words, the registry label and the age: nothing the child wrote. */
export const questionText = (label: string, ageMs: number): string => `Child session ${label} has waited ${duration(ageMs)} for your answer to its question. Answer it in your own words, or tell it when you will; a plain intercom message is enough. Information only: this notice approves nothing.`;

/** The reminder for a remote child's registry ask (its answer is a brief): fixed words, the registry label and the age. */
export const remoteQuestionText = (label: string, ageMs: number): string => `Remote child session ${label} has waited ${duration(ageMs)} for your answer to its ask. Answer it with a brief (foreman session brief <label> <file>). Information only: this notice approves nothing.`;

/** The quiet notice for a local child idle at its open plan phase: fixed words, the registry label, the age and planWait's fixed text. */
export const planIdleText = (label: string, ageMs: number, waits: string): string => `Child session ${label}: idle at its plan for ${duration(ageMs)}; ${waits}.`;

/** The owner's answers to a child's plan checkpoint, as the child's live file records them; the words are fixed. */
const ANSWER_WORDS: Record<string, string> = { approve: "plan approved by the owner", revise: "plan sent back by the owner (revise)", reject: "plan rejected by the owner" };

/** How an announced episode ended, as far as the recorded state says: `answered`/`dismissed` only with a stored answer of the child, `restart` when the session started again after the episode began. */
export type Cleared = "answered" | "dismissed" | "restart" | "none" | "remote" | "hold";

/** Fixed words: "answered" is said only for `answered` (a stored answer at or after the episode start); a remote child shows only its terminal state, so it is never "answered". */
export const clearedText = (label: string, waitedMs: number, how: Cleared = "none", answer?: string): string => {
  const d = duration(waitedMs);
  if (how === "answered") return `Child session ${label}: its dialog was answered after ${d}${answer ? `: ${ANSWER_WORDS[answer]}` : ""}.`;
  if (how === "dismissed") return `Child session ${label}: its dialog was dismissed after ${d}, not answered.`;
  if (how === "restart") return `Child session ${label}: its dialog was ended by a restart of the session after ${d}, not answered; the child asks again.`;
  if (how === "remote") return `Child session ${label} is no longer waiting (after ${d}).`;
  if (how === "hold") return `Child session ${label} no longer holds for the owner (after ${d}).`;
  return `Child session ${label}: its dialog ended after ${d} without a recorded answer.`;
};

/** The information line for a checkpoint answer: fixed words and the registry label; approves nothing. */
export const answerText = (label: string, answer: string): string => `Child session ${label}: ${ANSWER_WORDS[answer]}.`;

type Obs = ({ blocked: false; plan?: { since: number; waits: string } } | { blocked: true; since: number; kind: unknown; plan?: undefined }) & { answer?: { decision: string; at: string }; lastAnswer?: { at: number; outcome: string }; startedAt?: number; remote?: true };
interface Sent {
  child: string;
  label: string;
  /** The start of the owner episode (or of the idle-at-plan episode). */
  since: number;
  /** An idle-at-plan episode: ends without an "answered" note. */
  plan?: true;
  /** The episode is a hold for the owner (`blockedKind` hold): its end says so. */
  hold?: true;
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
  /** The records of the questions children sent this session as intercom messages (reminded once, dropped when answered or closed). */
  carry?: IntercomCarry;
  /** The remote watcher's last contact with a child (ms), undefined when none since this process started. */
  contact?: (child: string) => number | undefined;
  /** `wake`: a turn is started on an idle parent (queued as a follow-up during a run). The notice and the quiet note both send false: shown, appended, read at the next turn. */
  send: (text: string, wake: boolean) => void;
  /** A local child's registry entry turned closed since the last pass (a quiet `foreman:closed` never reaches `parseInbound` in an idle parent): resolves a child wait on `label`; `notePath` is the entry's result path or "". */
  childClosed?: (label: string, notePath: string) => void;
  trace?: (rec: Record<string, unknown>) => void;
  now?: () => number;
  timer?: (fn: () => void, ms: number) => Cancel;
}

/** The wording an ended episode gets: a hold and a remote child have their own words; else only a stored answer says "answered". */
function clearOf(rec: Sent, obs: Obs, decision?: string): Cleared {
  if (rec.hold) return "hold";
  if (obs.remote) return "remote";
  const a = obs.lastAnswer;
  if (a && a.at >= rec.since) return a.outcome === "dismissed" ? "dismissed" : "answered";
  if (decision) return "answered"; // a checkpoint answer of an older live file that has no `lastAnswer`
  if (obs.startedAt !== undefined && obs.startedAt > rec.since) return "restart";
  return "none";
}

export class ChildBlocked {
  private readonly d: ChildBlockedDeps;
  private sent = new Map<string, Sent>();
  /** The checkpoint answers already reported or seeded: key `${label}\n${at}` -> child. */
  private answered = new Map<string, string>();
  /** The local children the last pass saw open: child id -> true. A child that left this set as `closed` gets one `childClosed` call (saved, so a reload keeps it). */
  private seenOpen = new Set<string>();
  /** The first start of this session's watcher, kept in the state file so a reload does not move it. */
  private startedMs: number;
  private cancel: Cancel | null = null;
  /** The remote children whose registry ask was seen: when first, and whether the reminder went out (memory only; it ends with the entry). */
  private readonly remoteAsks = new Map<string, { seq: unknown; first: number; reminded: boolean }>();

  constructor(d: ChildBlockedDeps) {
    this.d = d;
    this.startedMs = (d.now ?? Date.now)();
    if (!this.load()) this.save();
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
      const now = (this.d.now ?? Date.now)();
      const opener = this.d.opener();
      const mine = openChildren(this.d.agentDir, opener);
      let dirty = this.closedPass(mine);
      this.remind(mine, secs, now);
      this.remindRemote(mine, secs, now);
      for (const e of mine) {
        const obs = this.observe(e, now);
        if (!(secs > 0) || !obs) continue; // unreadable, stale or skipped: nothing is known, so nothing is said
        // an answer older than this session's start is seeded, never replayed
        let answer: string | undefined;
        if (obs.answer) {
          const akey = `${cleanLabel(e.label)}\n${obs.answer.at}`;
          if (!this.answered.has(akey)) {
            this.answered.set(akey, e.child);
            dirty = true;
            if (Date.parse(obs.answer.at) >= this.startedMs) answer = obs.answer.decision;
          }
        }
        for (const [key, rec] of [...this.sent]) {
          if (rec.child !== e.child || (obs.blocked && obs.since === rec.since && !rec.plan) || (rec.plan && !obs.blocked && obs.plan?.since === rec.since)) continue;
          this.sent.delete(key); // the announced episode ended
          dirty = true;
          if (rec.plan) continue;
          const waitedMs = now - rec.since;
          const how = clearOf(rec, obs, answer);
          this.d.trace?.({ event: "child_blocked_cleared", label: rec.label, waitedMs });
          this.d.send(clearedText(rec.label, waitedMs, how, how === "answered" ? answer : undefined), false);
          answer = undefined; // merged into the note: no second line
        }
        if (answer) {
          this.d.trace?.({ event: "child_checkpoint_answer", label: cleanLabel(e.label), decision: answer });
          this.d.send(answerText(cleanLabel(e.label), answer), false);
        }
        const label = cleanLabel(e.label);
        if (!obs.blocked) {
          const pl = obs.plan;
          const pkey = `${label}\nplan\n${pl?.since}`;
          if (!pl || this.sent.has(pkey) || now - pl.since < secs * 1000 || this.d.carry?.records.has(e.child)) continue; // a child with an open Question waits for the parent: the reminder covers it
          this.sent.set(pkey, { child: e.child, label, since: pl.since, plan: true });
          dirty = true;
          this.d.trace?.({ event: "child_plan_idle_notice", label, waitedMs: now - pl.since });
          this.d.send(planIdleText(label, now - pl.since, pl.waits), false);
          continue;
        }
        const key = `${label}\n${obs.since}`;
        if (this.sent.has(key) || now - obs.since < secs * 1000) continue;
        this.sent.set(key, { child: e.child, label, since: obs.since, ...(obs.kind === "hold" ? { hold: true as const } : {}) });
        dirty = true;
        this.d.trace?.({ event: "child_blocked_notice", label, waitedMs: now - obs.since });
        this.d.send(noticeText(label, obs.since, obs.kind), false);
      }
      const open = new Set(mine.map((e) => e.child));
      for (const [key, rec] of [...this.sent]) {
        if (open.has(rec.child)) continue;
        this.sent.delete(key); // the child is closed or gone
        dirty = true;
      }
      for (const [key, child] of [...this.answered]) {
        if (open.has(child)) continue;
        this.answered.delete(key);
        dirty = true;
      }
      if (dirty) this.save();
    } catch {
      // a pass never breaks the session
    }
  }

  /** The first pass that sees a local child's entry turned closed resolves the wait on it; an entry whose `last.kind` is already `closed` (parseInbound read the line) says nothing. True when the seen set changed. */
  private closedPass(mine: SessionEntry[]): boolean {
    const open = new Set(mine.filter((e) => typeof e.machine !== "string").map((e) => e.child));
    const gone = [...this.seenOpen].filter((c) => !open.has(c));
    const grew = [...open].some((c) => !this.seenOpen.has(c));
    if (gone.length === 0 && !grew) return false;
    const reg = gone.length > 0 ? readRegistry(this.d.agentDir).sessions : [];
    this.seenOpen = open;
    for (const child of gone) {
      const e = reg.find((x) => x.child === child);
      if (!e || e.status !== "closed" || e.last?.kind === "closed") continue;
      this.d.trace?.({ event: "child_closed_noticed", label: cleanLabel(e.label) });
      try {
        this.d.childClosed?.(e.label, typeof e.result === "string" ? e.result : "");
      } catch {
        // a wait never breaks the pass
      }
    }
    return true;
  }

  /** The question records: one for a child that closed or whose handoff dir holds an answer newer than the record goes; one older than `secs` is reminded once. */
  private remind(mine: SessionEntry[], secs: number, now: number): void {
    const records = this.d.carry?.records;
    if (!records) return;
    for (const r of [...records.values()]) {
      const e = mine.find((x) => x.child === r.child);
      if (!e || (typeof e.handoff === "string" && e.handoff && answerNewerThan(e.handoff, r.at))) {
        records.delete(r.child);
        continue;
      }
      if (!(secs > 0) || r.reminded || now - r.at < secs * 1000) continue;
      r.reminded = true;
      this.d.trace?.({ event: "child_question_reminder", label: r.label, waitedMs: now - r.at });
      this.d.send(questionText(r.label, now - r.at), true);
    }
  }

  /** A remote child's registry `ask` is the question and its presence the answer state (a brief clears it): reminded once while it is present and older than `secs`. */
  private remindRemote(mine: SessionEntry[], secs: number, now: number): void {
    const present = new Set<string>();
    for (const e of mine) {
      const ask = typeof e.machine === "string" && e.ask && typeof e.ask === "object" ? (e.ask as { seq?: unknown; at?: unknown }) : undefined;
      if (!ask) continue;
      present.add(e.child);
      let rec = this.remoteAsks.get(e.child);
      if (!rec || rec.seq !== ask.seq) {
        const at = typeof ask.at === "string" ? Date.parse(ask.at) : NaN;
        rec = { seq: ask.seq, first: Number.isFinite(at) ? at : now, reminded: false };
        this.remoteAsks.set(e.child, rec);
      }
      if (!(secs > 0) || rec.reminded || now - rec.first < secs * 1000) continue;
      rec.reminded = true;
      const label = cleanLabel(e.label);
      this.d.trace?.({ event: "child_question_reminder", label, waitedMs: now - rec.first, remote: true });
      this.d.send(remoteQuestionText(label, now - rec.first), true);
    }
    for (const child of [...this.remoteAsks.keys()]) if (!present.has(child)) this.remoteAsks.delete(child);
  }

  /** What the recorded state says about one child; undefined = not known now (no notice, no "answered" note). */
  private observe(e: SessionEntry, now: number): Obs | undefined {
    if (typeof e.machine === "string") return this.observeRemote(e, now);
    if (typeof e.handoff !== "string" || !e.handoff) return undefined;
    const id = readLive(e.handoff)?.piSessionId;
    if (!id || !SAFE_ID.test(id)) return undefined;
    let f: { heartbeatAt?: unknown; state?: unknown; startedAt?: unknown; lastEventAt?: unknown; blockedOn?: unknown; ownerBlockedSince?: unknown; blockedKind?: unknown; lastCheckpoint?: { decision?: unknown; at?: unknown }; lastAnswer?: { at?: unknown; outcome?: unknown } };
    try {
      f = JSON.parse(fs.readFileSync(path.join(liveDir(this.d.agentDir), `${id}.json`), "utf8"));
    } catch {
      return undefined;
    }
    const beat = typeof f.heartbeatAt === "string" ? Date.parse(f.heartbeatAt) : NaN;
    if (!Number.isFinite(beat) || now - beat > STALE_LIVE_MS) return undefined;
    const cp = f.lastCheckpoint;
    const answer = cp && typeof cp.decision === "string" && Object.hasOwn(ANSWER_WORDS, cp.decision) && typeof cp.at === "string" && Number.isFinite(Date.parse(cp.at)) ? { decision: cp.decision, at: cp.at } : undefined;
    const la = f.lastAnswer;
    const lastAnswer = la && typeof la.at === "string" && Number.isFinite(Date.parse(la.at)) && (la.outcome === "answered" || la.outcome === "dismissed") ? { at: Date.parse(la.at), outcome: la.outcome } : undefined;
    const started = typeof f.startedAt === "string" ? Date.parse(f.startedAt) : NaN;
    const facts = { ...(answer ? { answer } : {}), ...(lastAnswer ? { lastAnswer } : {}), ...(Number.isFinite(started) ? { startedAt: started } : {}) };
    if (f.blockedOn !== "owner") {
      const pw = f.state === "idle" ? planWait(e.handoff) : null;
      const at = typeof f.lastEventAt === "string" ? Date.parse(f.lastEventAt) : NaN;
      const plan = pw?.open && Number.isFinite(at) ? { since: at, waits: pw.text } : undefined;
      return { blocked: false, ...(plan ? { plan } : {}), ...facts };
    }
    const since = typeof f.ownerBlockedSince === "string" ? Date.parse(f.ownerBlockedSince) : NaN;
    return Number.isFinite(since) ? { blocked: true, since, kind: f.blockedKind, ...facts } : undefined;
  }

  private observeRemote(e: SessionEntry, now: number): Obs | undefined {
    if (e.ask && typeof e.ask === "object") return undefined; // the remote state does not say owner or parent: an open ask is the parent's to answer, and remindRemote covers it
    const seen = this.d.contact?.(e.child);
    if (seen === undefined || now - seen > STALE_CONTACT_MS) return undefined;
    const rl = e.remoteLive as { state?: unknown; seenAt?: unknown } | undefined;
    if (rl?.state !== "blocked") return { blocked: false, remote: true };
    const since = typeof rl.seenAt === "string" ? Date.parse(rl.seenAt) : NaN;
    return Number.isFinite(since) ? { blocked: true, since, kind: "dialog", remote: true } : undefined;
  }

  /** True when a state file with a start time was read. */
  private load(): boolean {
    try {
      const j = JSON.parse(fs.readFileSync(childBlockedStateFile(this.d.agentDir, this.d.sessionId), "utf8")) as { startedMs?: unknown; sent?: Record<string, Partial<Sent> & { ask?: true }>; answered?: Record<string, unknown>; open?: unknown };
      if (Array.isArray(j.open)) for (const c of j.open) if (typeof c === "string") this.seenOpen.add(c);
      for (const [k, c] of Object.entries(j.answered ?? {})) if (typeof c === "string") this.answered.set(k, c);
      // an `ask: true` record of an older state file is dropped: it is no owner episode
      for (const [k, r] of Object.entries(j.sent ?? {})) if (r && r.ask !== true && typeof r.child === "string" && typeof r.label === "string" && typeof r.since === "number") this.sent.set(k, { child: r.child, label: r.label, since: r.since, ...(r.plan === true ? { plan: true as const } : {}), ...(r.hold === true ? { hold: true as const } : {}) });
      if (typeof j.startedMs === "number" && Number.isFinite(j.startedMs)) {
        this.startedMs = j.startedMs;
        return true;
      }
    } catch {
      // no file yet
    }
    return false;
  }

  /** Atomic: temp file in the same folder, then rename. */
  private save(): void {
    const file = childBlockedStateFile(this.d.agentDir, this.d.sessionId);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, startedMs: this.startedMs, sent: Object.fromEntries(this.sent), answered: Object.fromEntries(this.answered), open: [...this.seenOpen] })}\n`, "utf8");
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
