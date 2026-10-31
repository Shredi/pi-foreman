// Parent side of the pull return path of a remote child session (round 62): the child appends its notices to an outbox
// file on its machine; a poll loop of the top foreman session runs `foreman session pull <child> --json` (one SSH call
// per child, scripts/foreman_session.py) and applies the entries through the same parseRemoteNotice/applyRemoteNotice
// as the push path (mirror, sha256, size, `.partial`, `foreman_wait kind child` wakes). Every pull process goes through
// one queue, so only one runs at a time; `pullNow` and `runRemote` use the same queue and work without the timer.
// The reply is data: it is validated before anything is applied, and a notice is never acted on.
import * as path from "node:path";
import { parseAskHeader } from "./askcontract.ts";
import type { Json } from "./config.ts";
import { get } from "./config.ts";
import { applyRemoteNotice, parseRemoteNotice } from "./remotesession.ts";
import type { Registry, SessionEntry } from "./session.ts";
import { readRegistry, writeRegistry } from "./session.ts";
import type { SpawnResult, Spawner } from "./spawn.ts";

export const TICK_MS = 2_000;
export const FAST_WINDOW_MS = 120_000;
export const ASK_FAST_MS = 30 * 60_000;
export const BACKOFF_CAP_S = 300;
export const MAX_REPOLL = 5;
const PULL_TIMEOUT_MS = 60_000;
const MAX_REPLY = 1024 * 1024;
const MAX_TEXT = 65_536;
const VALUE_RE = /^[A-Za-z0-9._:/@-]{1,200}$/;
const LIVE_STATES = new Set(["working", "blocked", "waiting", "idle", "done"]);
const POLLABLE = new Set(["open", "pending", "closing"]);

export interface PullOutcome {
  ok: boolean;
  entries: number;
  skipped: number;
  error?: string;
  /** The child's closed notice was applied. */
  closed?: boolean;
}
export type PullNow = (child: string) => Promise<PullOutcome>;
/** Run a `foreman_session.py` verb through the pull queue (the close path of PR 2 uses it). */
export type RunRemote = (args: string[]) => Promise<SpawnResult>;

/** What the module needs of the owning session; read at every use, so it may change under it. */
export interface PullHost {
  id: string;
  isChild: boolean;
  agentDir: string;
  /** The id registry entries carry as `parent` for this session. */
  opener: string;
  python: string | null;
  config: Json | undefined;
  notify: (text: string, level: "info" | "warning") => void;
  trace?: (rec: Record<string, unknown>) => void;
}

export interface PullDeps {
  host: () => PullHost | null;
  spawner: Spawner;
  pkgRoot: string;
  /** A notice was applied: wakes `foreman_wait kind child` waits (index.ts). */
  onNotice?: (sessionId: string, label: string, kind: string, notePath: string) => void;
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (t: unknown) => void;
  now?: () => number;
  write?: Parameters<typeof applyRemoteNotice>[3];
}

export interface RemotePull {
  start: () => void;
  stop: () => void;
  /** One loop tick: polls every eligible entry that is due. */
  tick: () => Promise<void>;
  pullNow: PullNow;
  runRemote: RunRemote;
}

/** Control characters stripped, cut to 200 characters (shown in the registry, `session list` and the widget). */
export const cleanError = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 200);

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isAge = (v: unknown): v is number => isInt(v) && v >= 0;

/** The child's presence as the fetch verb reports it: only validated fields survive; null when the shape is wrong. */
export function validLive(v: unknown): Record<string, unknown> | null | undefined {
  if (v === null) return null;
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.state !== "string" || !LIVE_STATES.has(o.state)) return undefined;
  if (!isAge(o.heartbeatAgeSeconds) || !isAge(o.lastEventAgeSeconds)) return undefined;
  if (o.blockedAgeSeconds !== null && !isAge(o.blockedAgeSeconds)) return undefined;
  if (!isInt(o.workingRuns) || o.workingRuns < 0 || o.workingRuns > 64) return undefined;
  if (o.paneId !== null && !(typeof o.paneId === "string" && VALUE_RE.test(o.paneId))) return undefined;
  return { state: o.state, heartbeatAgeSeconds: o.heartbeatAgeSeconds, lastEventAgeSeconds: o.lastEventAgeSeconds, blockedAgeSeconds: o.blockedAgeSeconds, workingRuns: o.workingRuns, paneId: o.paneId };
}

const num = (v: unknown, dflt: number, lo: number, hi: number): number => (isInt(v) && v >= lo && v <= hi ? v : dflt);

/** Seconds between polls of one entry: fast while an ask is open (for 30 minutes), when closing, or within the window after an open or a delivery; else normal. */
export function periodSeconds(e: SessionEntry, config: Json | undefined, nowMs: number): number {
  const normal = num(get(config, "sessions.pull.intervalSeconds"), 20, 5, 300);
  const fast = num(get(config, "sessions.pull.fastSeconds"), 5, 2, 60);
  const within = (iso: unknown, ms: number): boolean => {
    const t = typeof iso === "string" ? Date.parse(iso) : NaN;
    return Number.isFinite(t) && nowMs - t < ms;
  };
  const ask = e.ask && typeof e.ask === "object" ? (e.ask as { at?: unknown }) : null;
  if ((ask && within(ask.at, ASK_FAST_MS)) || e.status === "closing" || within(e.opened, FAST_WINDOW_MS) || within(e.lastDeliverAt, FAST_WINDOW_MS)) return fast;
  return normal;
}

/** Delay after `failures` failed polls in a row: the period doubled per failure, up to the cap. */
export const backoffSeconds = (period: number, failures: number): number => Math.min(period * 2 ** failures, BACKOFF_CAP_S);

const newest = (reg: Registry, child: string): SessionEntry | undefined => [...reg.sessions].reverse().find((s) => s.child === child);

export function pollable(e: SessionEntry, opener: string): boolean {
  return typeof e.machine === "string" && e.machine !== "" && e.returnPath === "pull" && typeof e.status === "string" && POLLABLE.has(e.status) && e.parent === opener;
}

export function createRemotePull(deps: PullDeps): RemotePull {
  const now = deps.now ?? Date.now;
  const state = new Map<string, { nextAt: number; failures: number }>();
  const script = path.join(deps.pkgRoot, "scripts", "foreman_session.py");
  let queue: Promise<unknown> = Promise.resolve();
  let timer: unknown = null;
  let ticking = false;
  /** Aborted by stop(): an in-flight pull is killed and its reply is not applied (no registry write after shutdown). */
  let ctl = new AbortController();

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn, fn);
    queue = p.then(() => undefined, () => undefined);
    return p;
  };

  const fail = (h: PullHost, child: string, msg: string): PullOutcome => {
    const error = cleanError(msg);
    try {
      const reg = readRegistry(h.agentDir);
      const e = newest(reg, child);
      if (e) {
        e.pullError = error;
        e.pullFailures = (isInt(e.pullFailures) ? e.pullFailures : 0) + 1;
        writeRegistry(h.agentDir, reg);
      }
    } catch {
      // the registry is unwritable: the failure is still reported and backed off in memory
    }
    return { ok: false, entries: 0, skipped: 0, error };
  };

  /** One pull process for `child` and the read-apply-write of its reply. */
  const pollOnce = async (h: PullHost, child: string): Promise<PullOutcome & { more?: boolean }> => {
    const signal = ctl.signal;
    if (signal.aborted) return { ok: false, entries: 0, skipped: 0, error: "stopped" };
    const e0 = newest(readRegistry(h.agentDir), child);
    if (!e0) return { ok: false, entries: 0, skipped: 0, error: "no registry entry" };
    if (!h.python) return fail(h, child, "no usable Python (run /foreman doctor)");
    const after = isAge(e0.outboxSeq) ? e0.outboxSeq : 0;
    const r = await deps.spawner(h.python, ["-E", "-s", script, "--agent-dir", h.agentDir, "pull", "--json", "--", child], { timeoutMs: PULL_TIMEOUT_MS, signal });
    if (signal.aborted) return { ok: false, entries: 0, skipped: 0, error: "stopped" };
    if (r.error) return fail(h, child, r.error.message);
    if (r.timedOut) return fail(h, child, "pull timed out");
    let data: { pulled?: unknown; errors?: unknown } | null = null;
    if (r.stdout.length <= MAX_REPLY) {
      try {
        const j = JSON.parse(r.stdout) as unknown;
        if (j && typeof j === "object" && !Array.isArray(j)) data = j as typeof data;
      } catch {
        data = null;
      }
    }
    if (!data) return fail(h, child, r.stdout.length <= MAX_REPLY && r.code !== 0 && r.stderr.trim() ? r.stderr.trim().split("\n")[0] : "malformed reply");
    const errs = Array.isArray(data.errors) ? (data.errors as { child?: unknown; error?: unknown }[]) : [];
    const bad = errs.find((x) => x && typeof x === "object" && x.child === child);
    if (bad) return fail(h, child, typeof bad.error === "string" ? bad.error : "malformed reply");
    const item = (Array.isArray(data.pulled) ? (data.pulled as Record<string, unknown>[]) : []).find((x) => x && typeof x === "object" && x.child === child);
    if (!item || !Array.isArray(item.entries) || !isInt(item.next) || item.next < after || typeof item.more !== "boolean") return fail(h, child, "malformed reply");
    const live = validLive(item.live);
    if (live === undefined) return fail(h, child, "malformed reply");

    const reg = readRegistry(h.agentDir);
    const e = newest(reg, child);
    if (!e) return { ok: false, entries: 0, skipped: 0, error: "no registry entry" };
    const label = `${e.label}@${String(e.machine)}`;
    const origin = { machine: typeof e.originMachine === "string" ? e.originMachine : "", sessionId: e.child };
    const wakes: [string, string][] = [];
    const notes: [string, "info" | "warning"][] = [];
    let skipped = isInt(item.skipped) ? item.skipped : 0; // remote-side skips, counted by the outbox verb
    let applied = 0;
    let closed = false;
    let high = after;
    const skip = (seq: unknown, why: string): void => {
      skipped++;
      notes.push([`outbox entry ${String(seq)} of ${label} skipped (${why})`, "warning"]);
    };
    for (const raw of item.entries as unknown[]) {
      const x = raw && typeof raw === "object" ? (raw as { seq?: unknown; text?: unknown }) : {};
      if (!isInt(x.seq) || x.seq <= high) {
        skip(isInt(x.seq) ? x.seq : "?", isInt(x.seq) ? "sequence not increasing" : "no integer seq");
        continue;
      }
      high = x.seq;
      if (typeof x.text !== "string" || Buffer.byteLength(x.text, "utf8") > MAX_TEXT) {
        skip(x.seq, "text missing or over 65536 bytes");
        continue;
      }
      const notice = parseRemoteNotice(x.text);
      if (!notice) {
        skip(x.seq, "not a notice");
        continue;
      }
      const hit = applyRemoteNotice(reg, origin, notice, deps.write, new Date(now()));
      if (!hit) {
        skip(x.seq, "session no longer open");
        continue;
      }
      applied++;
      if (hit.changed) {
        if (notice.kind === "ask" && path.basename(hit.path).startsWith("ask.md")) {
          const head = parseAskHeader(notice.content);
          hit.entry.ask = { n: head?.n ?? 0, topic: head?.topic ?? "", at: new Date(now()).toISOString() };
        }
        if (notice.kind === "closed") closed = true;
        wakes.push([hit.kind, hit.path]);
      }
      notes.push([hit.message ?? `pi-foreman session ${label}: ${hit.kind}${hit.path ? ` ${hit.path}` : ""}`, hit.changed ? "info" : "warning"]);
    }
    e.outboxSeq = Math.max(item.next, high);
    e.pulledAt = new Date(now()).toISOString();
    e.remoteLive = live;
    e.pullError = null;
    e.pullFailures = 0;
    try {
      writeRegistry(h.agentDir, reg);
    } catch (err) {
      return fail(h, child, `could not update the registry: ${(err as Error).message}`);
    }
    for (const [text, level] of notes) h.notify(text, level);
    for (const [kind, p] of wakes) deps.onNotice?.(h.id, e.label, kind, p);
    return { ok: true, entries: applied, skipped, more: item.more, ...(closed ? { closed } : {}) };
  };

  /** Poll `child` until nothing more is pending (at most MAX_REPOLL in a row); schedules the next poll. */
  const poll = async (h: PullHost, child: string): Promise<PullOutcome> => {
    const t0 = now();
    const out: PullOutcome = { ok: true, entries: 0, skipped: 0 };
    for (let i = 0; i < MAX_REPOLL; i++) {
      const r = await pollOnce(h, child);
      out.entries += r.entries;
      out.skipped += r.skipped;
      if (!r.ok) {
        out.ok = false;
        out.error = r.error;
        break;
      }
      if (r.closed) out.closed = true;
      if (!r.more || r.closed) break;
    }
    const prev = state.get(child);
    const failures = out.ok ? 0 : (prev?.failures ?? 0) + 1;
    const e = newest(readRegistry(h.agentDir), child);
    const period = e ? periodSeconds(e, h.config, now()) : 20;
    state.set(child, { failures, nextAt: now() + (out.ok ? period : backoffSeconds(period, failures)) * 1000 });
    h.trace?.({ event: "remote_pull", machine: String(e?.machine ?? ""), label: e?.label ?? "", entries: out.entries, skipped: out.skipped, ms: now() - t0, ...(out.error ? { error: out.error } : {}) });
    return out;
  };

  const tick = async (): Promise<void> => {
    const h = deps.host();
    if (!h || h.isChild || ticking) return;
    ticking = true;
    try {
      const due = new Set<string>();
      for (const e of readRegistry(h.agentDir).sessions) if (pollable(e, h.opener) && (state.get(e.child)?.nextAt ?? 0) <= now()) due.add(e.child);
      for (const child of due) {
        await enqueue(async () => {
          const cur = newest(readRegistry(h.agentDir), child);
          if (cur && pollable(cur, h.opener)) await poll(h, child);
        });
      }
    } catch {
      // the loop never throws
    } finally {
      ticking = false;
    }
  };

  return {
    start: () => {
      if (ctl.signal.aborted) ctl = new AbortController();
      const h = deps.host();
      if (timer || !h || h.isChild) return;
      const t = (deps.setInterval ?? ((fn, ms) => setInterval(fn, ms)))(() => void tick(), TICK_MS);
      t.unref?.();
      timer = t;
    },
    stop: () => {
      ctl.abort();
      if (timer === null) return;
      (deps.clearInterval ?? ((t) => clearInterval(t as NodeJS.Timeout)))(timer);
      timer = null;
    },
    tick,
    pullNow: (child) =>
      enqueue(async () => {
        const h = deps.host();
        if (!h) return { ok: false, entries: 0, skipped: 0, error: "no session" };
        return poll(h, child);
      }),
    runRemote: (args) =>
      enqueue(async () => {
        const h = deps.host();
        if (!h?.python) return { code: null, stdout: "", stderr: "", error: new Error("foreman_session.py: no usable Python (run /foreman doctor)."), timedOut: false };
        return deps.spawner(h.python, ["-E", "-s", script, "--agent-dir", h.agentDir, ...args], { timeoutMs: PULL_TIMEOUT_MS });
      }),
  };
}
