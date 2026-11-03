// Parent side of the remote return path (PR 4). A remote child (`foreman session open --machine`) reports with labels on its
// own hc terminal (`foreman session remote notice`: `fm.notice=<seq>:<kind>:<sha256>:<bytes>`, `fm.close=ready|open`).
// This module watches the local `hc events --json` stream (one listener per machine with open entries), fetches the named
// file with `hc file read --on <machine> <path>`, checks it against the label, mirrors it and feeds `applyRemoteNotice`.
// The pure core (`watchState`, `applyEvent`, `applyGet`, `pollPlan`, `commit`, `fail`) never spawns; `RemoteWatcher` is the
// process wrapper. Notices are data: they update the registry and the mirror and act on nothing.
//
// Shapes observed on a real `hc` (0.1.x), addresses and ids replaced by placeholders:
//   `hc events --json`, line 1 (snapshot):  {"channel":null,"seq":8750,"terminals":[{"address":"t3","labels":{"k":"v"},"state":"live",
//       "status":{"app":"pi","state":"done"},"records":{...},...}]}   (`state` is the lifecycle, `status.state` the agent state)
//   later lines, JSON-RPC, the stream never ends:
//       {"jsonrpc":"2.0","method":"event","params":{"type":"status","terminal":"t3","seq":8751,"data":{"status":{"app":"pi","state":"done"}}}}
//       {"jsonrpc":"2.0","method":"event","params":{"type":"labels","terminal":"t3","seq":8748,"data":{"labels":{"k":"v"}}}}
//           (a label change sends the FULL label map; removing the last probe label sent the map without it)
//       {"jsonrpc":"2.0","method":"event","params":{"type":"turn","terminal":"t3","seq":8746,"data":{"state":"done","turn":112}}}
//       {"jsonrpc":"2.0","method":"event","params":{"type":"records",...}}   (ignored, as is `turn`)
//       {"jsonrpc":"2.0","method":"heartbeat","params":{"seq":8751}}   (about every 20 s)
//   `hc get <addr> --json`: the terminal object above (`state:"live"`, `status:{app,state}`, `labels`).
//   `hc get <missing> --json`: exit 3, stdout empty, stderr {"error":{"hint":"...","kind":"not_found","message":"no terminal \"t99\""}}.
// Not observed (no remote terminal on this machine): how a remote terminal is named in the local stream (the entry address
// `<machine>/<id>` is matched whole; a bare id counts only when the event names the machine in `machine`), the event of a
// removed terminal, and a label event as `data.label`+`data.value` (accepted besides `data.labels`).
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { applyRemoteNotice, parseRemoteNotice } from "./remotesession.ts";
import type { RemoteNotice } from "./remotesession.ts";
import { readRegistry, writeRegistry } from "./session.ts";
import type { SessionEntry } from "./session.ts";

export type LiveState = "blocked" | "working" | "idle" | "done" | "lost";
export type NoticeKind = "plan" | "result" | "update" | "ask" | "closed";

/** `hc get` poll cadence while an ask or plan is pending, else; and the pause before the events stream is restarted. */
export const FAST_POLL_MS = 5_000;
export const SLOW_POLL_MS = 60_000;
export const RESTART_MS = 60_000;
/** No line (heartbeats arrive about every 20 s) for this long: the stream is dead and the poll fallback starts. */
export const STREAM_SILENCE_MS = 90_000;
const REFRESH_MS = 10_000;
const GET_TIMEOUT_MS = 10_000;
const MAX_FETCH_BYTES = 8 * 1024 * 1024;

/** `sessions.remote.fetchTimeoutSeconds` as milliseconds: default 30 s, clamped to 5-600 s. */
export function fetchTimeoutMs(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 30;
  return Math.min(600, Math.max(5, n)) * 1000;
}

const FILES: Record<NoticeKind, string> = { plan: "plan.md", result: "result.md", update: "result.md", ask: "ask.md", closed: "result.md" };
const NOTICE_RE = /^(\d+):(plan|result|update|ask|closed):([0-9a-f]{64}|-):(\d+)$/;
const REFUSED_RE = /^(\d+):refused:([a-z0-9-]{1,40})$/;

export type ParsedLabel = { seq: number; kind: NoticeKind; sha256: string; bytes: number } | { seq: number; kind: "refused"; slug: string };

/** The value of an `fm.notice` label; null when it does not follow the grammar. */
export function parseNoticeLabel(v: unknown): ParsedLabel | null {
  if (typeof v !== "string") return null;
  const m = NOTICE_RE.exec(v);
  if (m) return { seq: Number(m[1]), kind: m[2] as NoticeKind, sha256: m[3], bytes: Number(m[4]) };
  const r = REFUSED_RE.exec(v);
  return r ? { seq: Number(r[1]), kind: "refused", slug: r[2] } : null;
}

/** hc terminal state word to the live state; null for a word that says nothing. */
export function mapHcState(word: unknown): LiveState | null {
  switch (typeof word === "string" ? word.toLowerCase() : "") {
    case "blocked":
      return "blocked";
    case "working":
    case "waiting":
      return "working";
    case "idle":
      return "idle";
    case "done":
    case "exited":
    case "finished":
      return "done";
    case "error":
    case "lost":
    case "failed":
    case "gone":
      return "lost";
    default:
      return null;
  }
}

export interface Watched {
  child: string;
  label: string;
  machine: string;
  address: string;
  handoff: string;
  platform: string;
  mirror: string;
  /** Highest seq applied (persisted as `noticeSeq` on the registry entry). */
  lastSeq: number;
  /** The label value being fetched or already applied; a duplicate is ignored. */
  seen?: string;
  ask: boolean;
  planPending: boolean;
}
export type WatchState = Map<string, Watched>;

export type Action =
  | { type: "notice"; child: string; seq: number; kind: NoticeKind; sha256: string; bytes: number; value: string }
  | { type: "refused"; child: string; seq: number; slug: string; value: string }
  | { type: "close"; child: string; close: "ready" | "open" }
  | { type: "live"; child: string; state: LiveState };

const OPEN = new Set(["open", "pending", "closing"]);

/** The remote hc entries to watch: `backend: "hc"`, a machine, an address and a remote handoff, status open, pending or closing. */
export function watchState(reg: { sessions: SessionEntry[] }, prev?: WatchState, opener?: string): WatchState {
  const out: WatchState = new Map();
  for (const e of reg.sessions) {
    if (!opener || e.parent !== opener) continue; // only this session's own children (closechildren.ts)
    const hc = e.hc as { address?: unknown } | undefined;
    if (e.backend !== "hc" || typeof e.machine !== "string" || !hc || typeof hc.address !== "string" || typeof e.remoteHandoff !== "string") continue;
    if (!OPEN.has(String(e.status))) continue;
    const old = prev?.get(e.child);
    const persisted = typeof e.noticeSeq === "number" ? e.noticeSeq : 0;
    out.set(e.child, {
      child: e.child,
      label: e.label,
      machine: e.machine,
      address: hc.address,
      handoff: e.remoteHandoff,
      platform: (e.remote as { platform?: unknown } | undefined)?.platform === "win32" ? "win32" : "posix",
      mirror: typeof e.mirror === "string" ? e.mirror : "",
      lastSeq: Math.max(persisted, old?.lastSeq ?? 0),
      ...(old?.seen !== undefined ? { seen: old.seen } : {}),
      ask: !!e.ask && typeof e.ask === "object",
      planPending: (e.last as { kind?: unknown } | null | undefined)?.kind === "plan",
    });
  }
  return out;
}

export interface ParsedEvent {
  address: string;
  /** The machine the event names (a field `machine` of a snapshot terminal), when it does. */
  machine?: string;
  labels?: Record<string, string>;
  state: LiveState | null;
}

const strOf = (v: unknown): v is string => typeof v === "string" && v !== "";
const objOf = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

function labelsOf(v: unknown): Record<string, string> | undefined {
  const o = objOf(v);
  if (!o) return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(o)) if (typeof x === "string") out[k] = x;
  return out;
}

/** The agent state of a `status` object `{app, state}` (the terminal's own `state` is the lifecycle). */
const agentState = (status: unknown): LiveState | null => mapHcState(objOf(status)?.state);

/** One line of `hc events --json`: the snapshot (`terminals[]`), or a JSON-RPC `event` of type `status` or `labels`. Heartbeats and every other type give nothing. */
export function parseEvents(raw: unknown): ParsedEvent[] {
  const o = objOf(raw);
  if (!o) return [];
  if (Array.isArray(o.terminals)) {
    const out: ParsedEvent[] = [];
    for (const t of o.terminals) {
      const r = objOf(t);
      if (!r || !strOf(r.address)) continue;
      const labels = labelsOf(r.labels);
      out.push({ address: r.address, ...(strOf(r.machine) ? { machine: r.machine } : {}), ...(labels ? { labels } : {}), state: agentState(r.status) });
    }
    return out;
  }
  const p = o.method === "event" ? objOf(o.params) : undefined;
  if (!p || !strOf(p.terminal)) return [];
  const data = objOf(p.data) ?? {};
  const machine = strOf(p.machine) ? { machine: p.machine } : {};
  if (p.type === "status") return [{ address: p.terminal, ...machine, state: agentState(data.status) }];
  if (p.type === "labels") {
    const labels = labelsOf(data.labels) ?? (strOf(data.label) && typeof data.value === "string" ? { [data.label]: data.value } : undefined);
    return labels ? [{ address: p.terminal, ...machine, labels, state: null }] : [];
  }
  return [];
}

/** The full address, or a bare id of an event that names the entry's machine; a bare local id (`t3`) never matches a remote entry. */
const sameTerminal = (w: Watched, ev: ParsedEvent): boolean => ev.address === w.address || (!ev.address.includes("/") && ev.machine === w.machine && `${w.machine}/${ev.address}` === w.address);

function ingest(w: Watched, labels: Record<string, string>, state: LiveState | null, out: Action[]): void {
  const close = labels["fm.close"];
  if (close === "ready" || close === "open") out.push({ type: "close", child: w.child, close });
  const value = labels["fm.notice"];
  if (value !== undefined && value !== w.seen) {
    const p = parseNoticeLabel(value);
    if (p && p.seq > w.lastSeq) {
      w.seen = value;
      if (p.kind === "refused") out.push({ type: "refused", child: w.child, seq: p.seq, slug: p.slug, value });
      else out.push({ type: "notice", child: w.child, seq: p.seq, kind: p.kind, sha256: p.sha256, bytes: p.bytes, value });
    }
  }
  if (state) out.push({ type: "live", child: w.child, state });
}

/** The actions one event line asks for; only entries on `machine` (when given) whose address the event names. A seq not above the last applied one, a duplicate value and a malformed label do nothing. */
export function applyEvent(state: WatchState, raw: unknown, machine?: string): Action[] {
  const out: Action[] = [];
  for (const ev of parseEvents(raw)) {
    for (const w of state.values()) {
      if (machine !== undefined && w.machine !== machine) continue;
      if (sameTerminal(w, ev)) ingest(w, ev.labels ?? {}, ev.state, out);
    }
  }
  return out;
}

/** The actions of an `hc get <address> --json` reply (`labels`, `status.state`). */
export function applyGet(state: WatchState, child: string, reply: unknown): Action[] {
  const w = state.get(child);
  const out: Action[] = [];
  const r = objOf(reply);
  if (!w || !r) return out;
  ingest(w, labelsOf(r.labels) ?? {}, agentState(r.status), out);
  return out;
}

/** A notice was applied: its seq is final. */
export function commit(state: WatchState, child: string, seq: number): void {
  const w = state.get(child);
  if (w && seq > w.lastSeq) w.lastSeq = seq;
}

/** A notice could not be applied: the same label value triggers again. A newer value already queued stays. */
export function fail(state: WatchState, child: string, value: string): void {
  const w = state.get(child);
  if (w && w.seen === value) delete w.seen;
}

export interface PollItem {
  child: string;
  machine: string;
  address: string;
  everyMs: number;
}

/** The `hc get` fallback plan: 5 s for an entry with an open ask or a pending plan, else 60 s. */
export function pollPlan(entries: Iterable<Watched>): PollItem[] {
  return [...entries].map((w) => ({ child: w.child, machine: w.machine, address: w.address, everyMs: w.ask || w.planPending ? FAST_POLL_MS : SLOW_POLL_MS }));
}

/** The remote path of a handoff file, joined with the remote's separator. */
export function remotePath(w: Pick<Watched, "handoff" | "platform">, file: string): string {
  const sep = w.platform === "win32" ? "\\" : "/";
  return `${w.handoff.replace(/[\\/]+$/, "")}${sep}${file}`;
}

/** The stderr of `hc get` on a missing terminal: `{"error":{"kind":"not_found"}}`. */
function notFound(stderr: string): boolean {
  try {
    return objOf(objOf(JSON.parse(stderr))?.error)?.kind === "not_found";
  } catch {
    return false;
  }
}

const strip = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 200);

export interface HcResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  overflow: boolean;
  error?: Error;
}
export type HcRun = (args: string[], timeoutMs: number) => Promise<HcResult>;
export type HcEvents = (onLine: (line: string) => void, onEnd: () => void) => { kill(): void };

const hcBin = (): string => process.env.HC_BIN?.trim() || "hc";

/** `hc <args>` without a shell; stdout is kept as bytes. */
export const runHc: HcRun = (args, timeoutMs) =>
  new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let timedOut = false;
    let done = false;
    let child: ReturnType<typeof spawn>;
    const finish = (code: number | null, error?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8"), timedOut, overflow, ...(error ? { error } : {}) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child?.kill();
      finish(null);
    }, timeoutMs);
    try {
      child = spawn(hcBin(), args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish(null, error as Error);
      return;
    }
    child.stdout?.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_FETCH_BYTES) {
        overflow = true;
        child.kill();
        finish(null);
        return;
      }
      out.push(c);
    });
    child.stderr?.on("data", (c: Buffer) => {
      if (err.length < 64) err.push(c);
    });
    child.on("error", (e) => finish(null, e));
    child.on("close", (code) => finish(code));
  });

/** `hc events --json` as a line stream. */
export const spawnEvents: HcEvents = (onLine, onEnd) => {
  let buf = "";
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    onEnd();
  };
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(hcBin(), ["events", "--json"], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    queueMicrotask(end);
    return { kill() {} };
  }
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  });
  child.on("error", end);
  child.on("close", end);
  return { kill: () => void child?.kill() };
};

export type Cancel = () => void;
export interface WatchDeps {
  agentDir: string;
  /** This session's opener intercom id: only entries whose `parent` equals it are watched. */
  opener: () => string | undefined;
  hc?: HcRun;
  events?: HcEvents;
  /** `sessions.remote.fetchTimeoutSeconds` (raw config value). */
  fetchTimeoutSeconds?: () => unknown;
  /** Wakes `foreman_wait kind child`: label, kind, text (mirror path or refused slug). */
  wake: (label: string, kind: string, text: string) => void;
  notify?: (message: string, level: "info" | "warning") => void;
  now?: () => number;
  timer?: (fn: () => void, ms: number) => Cancel;
}

interface MachineRun {
  stream?: { kill(): void };
  polls: Map<string, Cancel>;
  restart?: Cancel;
  /** The silence watchdog of the stream. */
  silence?: Cancel;
}

const defaultTimer = (fn: () => void, ms: number): Cancel => {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return () => clearTimeout(t);
};

/** Writes bytes exactly (temp file in the same dir, then rename). */
function writeBytes(file: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export class RemoteWatcher {
  state: WatchState = new Map();
  private machines = new Map<string, MachineRun>();
  private chain: Promise<void> = Promise.resolve();
  private cancelRefresh: Cancel | null = null;
  private stopped = true;
  private readonly hc: HcRun;
  private readonly events: HcEvents;
  private readonly timer: (fn: () => void, ms: number) => Cancel;

  private readonly d: WatchDeps;

  constructor(d: WatchDeps) {
    this.d = d;
    this.hc = d.hc ?? runHc;
    this.events = d.events ?? spawnEvents;
    this.timer = d.timer ?? defaultTimer;
  }

  /** Watches until `stop()`: re-reads the registry now and every 10 s. */
  start(): void {
    this.stopped = false;
    const tick = (): void => {
      if (this.stopped) return;
      this.refresh();
      this.cancelRefresh = this.timer(tick, REFRESH_MS);
    };
    tick();
  }

  stop(): void {
    this.stopped = true;
    this.cancelRefresh?.();
    this.cancelRefresh = null;
    for (const m of [...this.machines.keys()]) this.stopMachine(m);
  }

  /** Re-reads the registry: starts a listener for a machine with open entries, stops it for one without, syncs new entries once with `hc get`. */
  refresh(): void {
    const reg = readRegistry(this.d.agentDir);
    const prev = this.state;
    let dirty = false;
    for (const e of reg.sessions) {
      const a = e.ask as { rulings?: unknown } | undefined;
      if (e.ask && typeof e.ask === "object" && typeof a?.rulings === "number" && (typeof e.rulings === "number" ? e.rulings : 0) > a.rulings) {
        delete e.ask; // a ruling was delivered (a plain brief does not count): the ask is answered
        dirty = true;
      }
    }
    if (dirty) writeRegistry(this.d.agentDir, reg);
    this.state = watchState(reg, prev, this.d.opener());
    for (const w of this.state.values()) {
      if (!this.machines.has(w.machine)) this.startMachine(w.machine);
      if (!prev.has(w.child)) this.enqueue(() => this.pollOne(w.child));
    }
    for (const m of [...this.machines.keys()]) if (![...this.state.values()].some((w) => w.machine === m)) this.stopMachine(m);
  }

  /** Resolves when the queued work is done (tests). */
  async idle(): Promise<void> {
    let c: Promise<void>;
    do {
      c = this.chain;
      await c;
    } while (c !== this.chain);
  }

  private enqueue(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch(() => undefined);
  }

  private startMachine(machine: string): void {
    const m: MachineRun = this.machines.get(machine) ?? { polls: new Map() };
    this.machines.set(machine, m);
    this.openStream(machine, m);
  }

  private openStream(machine: string, m: MachineRun): void {
    m.restart = undefined;
    for (const c of m.polls.values()) c();
    m.polls.clear();
    // any line, a heartbeat too, shows the stream is alive; STREAM_SILENCE_MS without one ends it
    const arm = (): void => {
      m.silence?.();
      m.silence = this.timer(() => {
        if (m.stream !== stream || this.machines.get(machine) !== m) return;
        m.stream = undefined;
        stream.kill();
        this.fallback(machine, m);
      }, STREAM_SILENCE_MS);
    };
    const stream = this.events(
      (line) => {
        arm();
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          return;
        }
        this.run(applyEvent(this.state, raw, machine));
      },
      () => {
        if (m.stream !== stream || this.machines.get(machine) !== m) return;
        m.stream = undefined;
        m.silence?.();
        this.fallback(machine, m);
      },
    );
    m.stream = stream;
    arm();
  }

  /** The stream ended or errored: poll `hc get` per entry and try the stream again in a minute. */
  private fallback(machine: string, m: MachineRun): void {
    for (const p of pollPlan(this.state.values())) if (p.machine === machine) this.schedulePoll(m, p.child);
    m.restart = this.timer(() => {
      if (this.machines.get(machine) === m && !m.stream) this.openStream(machine, m);
    }, RESTART_MS);
  }

  private schedulePoll(m: MachineRun, child: string): void {
    m.polls.get(child)?.();
    const p = pollPlan(this.state.values()).find((x) => x.child === child);
    if (!p) return;
    m.polls.set(
      child,
      this.timer(() => {
        this.enqueue(async () => {
          await this.pollOne(child);
          if (!m.stream && this.machines.get(p.machine) === m) this.schedulePoll(m, child);
        });
      }, p.everyMs),
    );
  }

  private stopMachine(machine: string): void {
    const m = this.machines.get(machine);
    if (!m) return;
    this.machines.delete(machine);
    m.stream?.kill();
    m.stream = undefined;
    m.silence?.();
    m.restart?.();
    for (const c of m.polls.values()) c();
    m.polls.clear();
  }

  private run(actions: Action[]): void {
    for (const a of actions) this.enqueue(() => this.handle(a));
  }

  private async pollOne(child: string): Promise<void> {
    const w = this.state.get(child);
    if (!w) return;
    const r = await this.hc(["get", w.address, "--json"], GET_TIMEOUT_MS);
    if (r.code === 0) {
      let reply: unknown;
      try {
        reply = JSON.parse(r.stdout.toString("utf8"));
      } catch {
        return;
      }
      this.run(applyGet(this.state, child, reply));
    } else if (r.code === 3 && notFound(r.stderr)) {
      this.run([{ type: "live", child, state: "lost" }]);
    }
  }

  private update(child: string, fn: (e: SessionEntry) => boolean): void {
    const reg = readRegistry(this.d.agentDir);
    const e = [...reg.sessions].reverse().find((s) => s.child === child);
    if (e && fn(e)) writeRegistry(this.d.agentDir, reg);
  }

  private async handle(a: Action): Promise<void> {
    const w = this.state.get(a.child);
    if (!w) return;
    if ((a.type === "notice" || a.type === "refused") && a.seq <= w.lastSeq) return; // applied meanwhile
    const at = new Date((this.d.now ?? Date.now)()).toISOString();
    if (a.type === "live") {
      this.update(a.child, (e) => {
        const old = e.remoteLive as { state?: unknown } | undefined;
        if (old?.state === a.state) return false;
        e.remoteLive = { state: a.state, seenAt: at, address: w.address };
        return true;
      });
    } else if (a.type === "close") {
      this.update(a.child, (e) => {
        if (e.close === a.close) return false;
        e.close = a.close;
        return true;
      });
    } else if (a.type === "refused") {
      this.update(a.child, (e) => {
        const reg = { version: 1, sessions: [{ ...e, originMachine: w.machine }] };
        const hit = applyRemoteNotice(reg, { machine: w.machine, sessionId: w.child }, { kind: "refused", reason: a.slug });
        if (hit) {
          const { originMachine: _o, ...rest } = reg.sessions[0];
          Object.assign(e, rest);
        }
        e.lastError = `refused ${a.slug}`;
        e.noticeSeq = a.seq;
        return true;
      });
      commit(this.state, a.child, a.seq);
      this.d.notify?.(`pi-foreman session ${w.label}@${w.machine}: refused ${a.slug}`, "warning");
      this.d.wake(w.label, "refused", a.slug);
    } else {
      await this.notice(w, a);
    }
  }

  private setError(child: string, message: string): void {
    this.update(child, (e) => {
      if (e.lastError === message) return false;
      e.lastError = message;
      return true;
    });
  }

  private async notice(w: Watched, a: Extract<Action, { type: "notice" }>): Promise<void> {
    const file = FILES[a.kind];
    const remote = remotePath(w, file);
    const timeout = fetchTimeoutMs(this.d.fetchTimeoutSeconds?.());
    let buf: Buffer | null = null;
    if (!(a.kind === "closed" && a.sha256 === "-")) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await this.hc(["file", "read", "--on", w.machine, remote], timeout);
        if (r.code !== 0 || r.timedOut || r.overflow) {
          const why = r.timedOut ? "timed out" : r.overflow ? "too large" : r.error ? r.error.message : r.stderr || `exit ${String(r.code)}`;
          this.setError(w.child, `fetch_failed: ${strip(why)}`);
          fail(this.state, w.child, a.value);
          return;
        }
        if (r.stdout.length === a.bytes && crypto.createHash("sha256").update(r.stdout).digest("hex") === a.sha256) {
          buf = r.stdout;
          break;
        }
      }
      if (!buf) {
        this.setError(w.child, "hash mismatch, not mirrored"); // the label stays pending: the same value triggers again
        this.d.notify?.(`remote notice from ${w.label}@${w.machine}: hash mismatch, not mirrored`, "warning");
        fail(this.state, w.child, a.value);
        return;
      }
    }
    let wake: { kind: string; path: string } | null = null;
    let problem = "";
    this.update(w.child, (e) => {
      const mirror = typeof e.mirror === "string" ? e.mirror : "";
      let notice: RemoteNotice | null;
      if (a.kind === "closed") {
        if (buf && mirror) writeBytes(path.join(mirror, "result.md"), buf);
        notice = { kind: "closed" };
      } else {
        // the contract line of `remote notice`, built here from the checked bytes
        const head = `${a.kind[0].toUpperCase()}${a.kind.slice(1)} from ${w.label.replace(/\s+/g, "-")}: ${remote} sha256:${a.sha256} bytes:${a.bytes}`;
        notice = parseRemoteNotice(`${head}\n---\n${(buf as Buffer).toString("utf8")}`);
      }
      if (!notice) {
        problem = "unparseable notice";
        return false;
      }
      const reg = { version: 1, sessions: [{ ...e, originMachine: w.machine }] };
      const hit = applyRemoteNotice(reg, { machine: w.machine, sessionId: w.child }, notice, (f) => writeBytes(f, buf as Buffer), undefined, a.kind !== "closed");
      if (!hit || !hit.changed) {
        problem = hit?.message ? hit.message.replace(/^remote notice from \S+: /, "") : "entry no longer open";
        return false;
      }
      const { originMachine: _o, ...rest } = reg.sessions[0];
      Object.assign(e, rest);
      e.noticeSeq = a.seq;
      e.lastError = null;
      if (a.kind === "ask") e.ask = { seq: a.seq, path: hit.path, at: hit.entry.last?.at, rulings: typeof e.rulings === "number" ? e.rulings : 0 };
      else delete e.ask;
      wake = { kind: hit.kind, path: hit.path };
      return true;
    });
    if (!wake) {
      this.setError(w.child, problem);
      fail(this.state, w.child, a.value);
      return;
    }
    commit(this.state, w.child, a.seq);
    const done = wake as { kind: string; path: string };
    this.d.notify?.(`pi-foreman session ${w.label}@${w.machine}: ${done.kind}${done.path ? ` ${done.path}` : ""}`, "info");
    this.d.wake(w.label, done.kind, done.path);
  }
}
