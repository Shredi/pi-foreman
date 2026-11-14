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
//       {"jsonrpc":"2.0","method":"event","params":{"type":"finished","terminal":"t3","seq":8756,"data":{"exit_code":0,"finished_ms":1793694685092,"reason":"exited","signal":null}}}
//           (a terminal that exited or was killed: `reason` is "exited" or "killed"; a new terminal is sent once as `created` with the whole object)
//       {"jsonrpc":"2.0","method":"event","params":{"type":"records",...}}   (ignored, as is `turn`)
//       {"jsonrpc":"2.0","method":"heartbeat","params":{"seq":8751}}   (about every 20 s)
//   `hc get <addr> --json`: the terminal object above (`state:"live"`, `status:{app,state}`, `labels`). A finished or killed terminal
//       stays listed (snapshot and `hc get`) as `state:"finished"`, `status:null`, `reason:"exited"|"killed"`, `exit_code`, until `hc rm`
//       (answers {"removed":"t3"}; no event of its own was seen). Any lifecycle `state` other than `live` is read as lost.
//   `hc get <missing> --json`: exit 3, stdout empty, stderr {"error":{"hint":"...","kind":"not_found","message":"no terminal \"t99\""}}.
//   `hc events --json` takes `--terminal <addr>`, `--children-of <addr>` and `--label K=V` (exact value; useless for the changing `fm.notice`).
//       A stream with exactly one watched entry on a machine is filtered on `--terminal <machine>/<id>`; with several entries it is the
//       full stream (the option is not repeatable). A change of a machine's watched set restarts its stream. A remote address with
//       `--terminal` could not be tried here (`unknown machine` without a registered one); if hc refuses it the stream ends and the poll fallback runs.
// Not observed (no remote terminal on this machine): how a remote terminal is named in the local stream. The entry address
// `<machine>/<id>` is matched whole, nothing else. A label event carries the full map in `data.labels`.
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseAskHeader } from "./askcontract.ts";
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
/** After a `closed` notice: `hc get` every 3 s for up to 120 s until the remote terminal is finished, then `hc rm`. */
export const REAP_POLL_MS = 3_000;
export const REAP_POLLS = 40;
/** After the shell-in-foreground `hc kill`: up to 15 s for `finished` before the `hc rm`. */
export const REAP_KILL_POLLS = 5;
/** Foreground program names (case-folded, `.exe` stripped) that mean pi is gone and `--keep` left a shell in its place. */
const SHELL_NAMES = new Set(["sh", "bash", "zsh", "fish", "dash", "ash", "ksh", "tcsh", "csh", "cmd", "powershell", "pwsh"]);
export const isShellName = (name: unknown): boolean => typeof name === "string" && SHELL_NAMES.has(name.trim().toLowerCase().replace(/^.*[\\/]/, "").replace(/\.exe$/, ""));
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
  if (m) {
    // `-:0` (no result file) is for `closed` only; every other kind names a file with a hash
    if (m[3] === "-" && (m[2] !== "closed" || Number(m[4]) !== 0)) return null;
    return { seq: Number(m[1]), kind: m[2] as NoticeKind, sha256: m[3], bytes: Number(m[4]) };
  }
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
  | { type: "live"; child: string; state: LiveState }
  | { type: "ignored"; child: string; value: string };

const OPEN = new Set(["open", "pending", "closing"]);

/** The id part of a terminal address `<machine>/<id>`; as TERMINAL_ID_RE in foreman_session.py (tests/fixtures/remote-address-cases.json runs against both). */
const TERMINAL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** True when a recorded terminal address lies on the entry's own machine and its id has the strict shape. */
export function usableAddress(machine: unknown, address: unknown): boolean {
  if (typeof machine !== "string" || !machine || typeof address !== "string") return false;
  const slash = address.indexOf("/");
  return slash > 0 && address.slice(0, slash) === machine && TERMINAL_ID_RE.test(address.slice(slash + 1));
}

/** The remote hc entries to watch: `backend: "hc"`, a machine, an address and a remote handoff, status open, pending or closing. */
export function watchState(reg: { sessions: SessionEntry[] }, prev?: WatchState, opener?: string): WatchState {
  const out: WatchState = new Map();
  for (const e of reg.sessions) {
    if (!opener || e.parent !== opener) continue; // only this session's own children (closechildren.ts)
    const hc = e.hc as { address?: unknown } | undefined;
    if (e.backend !== "hc" || typeof e.machine !== "string" || !hc || typeof hc.address !== "string" || typeof e.remoteHandoff !== "string") continue;
    if (!OPEN.has(String(e.status))) continue;
    if (!usableAddress(e.machine, hc.address)) continue; // an address on another machine (or not an id) is never read, ended or removed
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
  labels?: Record<string, string>;
  state: LiveState | null;
}

const CLOSE_LINE = (w: Watched): string => `; close with: foreman session close-remote ${w.label}@${w.machine}`;
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

/** A terminal object (snapshot entry or `hc get`): a lifecycle `state` other than `live` (`finished`) is lost whatever `status` says. */
function terminalState(r: Record<string, unknown>): LiveState | null {
  return strOf(r.state) && r.state !== "live" ? "lost" : agentState(r.status);
}

/** One line of `hc events --json`: the snapshot (`terminals[]`), or a JSON-RPC `event` of type `status`, `labels` or `finished`. Heartbeats and every other type give nothing. */
export function parseEvents(raw: unknown): ParsedEvent[] {
  const o = objOf(raw);
  if (!o) return [];
  if (Array.isArray(o.terminals)) {
    const out: ParsedEvent[] = [];
    for (const t of o.terminals) {
      const r = objOf(t);
      if (!r || !strOf(r.address)) continue;
      const labels = labelsOf(r.labels);
      out.push({ address: r.address, ...(labels ? { labels } : {}), state: terminalState(r) });
    }
    return out;
  }
  const p = o.method === "event" ? objOf(o.params) : undefined;
  if (!p || !strOf(p.terminal)) return [];
  const data = objOf(p.data) ?? {};
  if (p.type === "status") return [{ address: p.terminal, state: agentState(data.status) }];
  if (p.type === "finished") return [{ address: p.terminal, state: "lost" }];
  if (p.type === "labels") {
    const labels = labelsOf(data.labels);
    return labels ? [{ address: p.terminal, labels, state: null }] : [];
  }
  return [];
}

/** The full `<machine>/<id>` address only; a bare local id (`t3`) never matches a remote entry. */
const sameTerminal = (w: Watched, ev: ParsedEvent): boolean => ev.address === w.address;

function ingest(w: Watched, labels: Record<string, string>, state: LiveState | null, out: Action[]): void {
  const close = labels["fm.close"];
  if (close === "ready" || close === "open") out.push({ type: "close", child: w.child, close });
  const value = labels["fm.notice"];
  if (value !== undefined && value !== w.seen) {
    const p = parseNoticeLabel(value);
    if (!p) {
      w.seen = value; // traced once
      out.push({ type: "ignored", child: w.child, value });
    } else if (p.seq > w.lastSeq) {
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
  ingest(w, labelsOf(r.labels) ?? {}, terminalState(r), out);
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
export type HcRun = (args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<HcResult>;
/** `extra` is appended to `hc events --json` (a `--terminal` filter). */
export type HcEvents = (onLine: (line: string) => void, onEnd: () => void, extra?: string[]) => { kill(): void };

const hcBin = (): string => process.env.HC_BIN?.trim() || "hc";

/** `hc <args>` without a shell; stdout is kept as bytes. */
export const runHc: HcRun = (args, timeoutMs, signal) =>
  new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let timedOut = false;
    let done = false;
    let child: ReturnType<typeof spawn>;
    const onAbort = (): void => {
      child?.kill();
      finish(null, new Error("aborted"));
    };
    const finish = (code: number | null, error?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8"), timedOut, overflow, ...(error ? { error } : {}) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child?.kill();
      finish(null);
    }, timeoutMs);
    if (signal?.aborted) {
      finish(null, new Error("aborted"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
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
export const spawnEvents: HcEvents = (onLine, onEnd, extra = []) => {
  let buf = "";
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    onEnd();
  };
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(hcBin(), ["events", "--json", ...extra], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
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
  /** A trace record (`remote_notice_ignored`) for a label that does not follow the grammar. */
  trace?: (rec: Record<string, unknown>) => void;
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
  /** The watched addresses the stream was opened for. */
  key?: string;
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
  /** Per child, the time (ms) of the last stream line of its machine or successful `hc get` of its terminal; in memory only (childblocked.ts reads it). */
  private readonly contacts = new Map<string, number>();
  private machines = new Map<string, MachineRun>();
  private readonly named = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private cancelRefresh: Cancel | null = null;
  private stopped = true;
  private abort = new AbortController();
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

  /** The last time the watcher heard from the child's machine or terminal, or undefined when it has not since this watcher was built. */
  lastContact(child: string): number | undefined {
    return this.contacts.get(child);
  }

  /** Watches until `stop()`: re-reads the registry now and every 10 s. */
  start(): void {
    this.stopped = false;
    this.abort = new AbortController();
    const tick = (): void => {
      if (this.stopped) return;
      this.refresh();
      this.cancelRefresh = this.timer(tick, REFRESH_MS);
    };
    tick();
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort(); // in-flight hc get / file read children end now
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
    this.nameRefused(reg);
    for (const w of this.state.values()) {
      if (!this.machines.has(w.machine)) this.startMachine(w.machine);
      if (!prev.has(w.child)) {
        this.enqueue(() => this.pollOne(w.child));
        const m = this.machines.get(w.machine);
        if (m && !m.stream) this.schedulePoll(m, w.child); // the machine is in poll fallback: no stream will report this entry
      }
    }
    for (const [name, m] of this.machines) {
      if (m.stream && m.key !== this.watchedKey(name)) {
        const old = m.stream;
        m.stream = undefined;
        old.kill();
        this.openStream(name, m); // the watched set changed: a new filter
      }
    }
    for (const m of [...this.machines.keys()]) if (![...this.state.values()].some((w) => w.machine === m)) this.stopMachine(m);
  }

  /** One notice per open entry of this session whose recorded address `watchState` refused. */
  private nameRefused(reg: { sessions: SessionEntry[] }): void {
    const opener = this.d.opener();
    for (const e of reg.sessions) {
      const hc = e.hc as { address?: unknown } | undefined;
      if (!opener || e.parent !== opener || e.backend !== "hc" || typeof e.machine !== "string" || !hc || typeof hc.address !== "string" || typeof e.remoteHandoff !== "string") continue;
      if (!OPEN.has(String(e.status)) || usableAddress(e.machine, hc.address) || this.named.has(e.child)) continue;
      this.named.add(e.child);
      this.d.notify?.(`pi-foreman session ${strip(e.label)}@${strip(e.machine)}: its recorded terminal address is not on ${strip(e.machine)}; not watched`, "warning");
    }
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

  private watchedKey(machine: string): string {
    return [...this.state.values()].filter((w) => w.machine === machine).map((w) => w.address).sort().join(" ");
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
    const addrs = [...this.state.values()].filter((w) => w.machine === machine).map((w) => w.address);
    m.key = this.watchedKey(machine);
    const stream = this.events(
      (line) => {
        arm();
        const at = (this.d.now ?? Date.now)();
        for (const w of this.state.values()) if (w.machine === machine) this.contacts.set(w.child, at);
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
      addrs.length === 1 ? ["--terminal", addrs[0]] : [],
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

  /** One `hc get` of the remote terminal: finished, gone (not_found), live with its foreground name, or unknown (error). */
  private async peek(address: string): Promise<{ s: "finished" | "gone" | "live" | "unknown"; fg?: unknown; notice?: unknown }> {
    const r = await this.hc(["get", address, "--json"], GET_TIMEOUT_MS, this.abort.signal);
    if (r.code === 3 && notFound(r.stderr)) return { s: "gone" };
    if (r.code !== 0) return { s: "unknown" };
    try {
      const o = objOf(JSON.parse(r.stdout.toString("utf8")));
      if (o?.state === "finished") return { s: "finished" };
      if (o?.state === "live") return { s: "live", fg: objOf(o.foreground)?.name, notice: objOf(o.labels)?.["fm.notice"] };
    } catch {
      // unreadable reply: keep polling
    }
    return { s: "unknown" };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((res) => void this.timer(res, ms));
  }

  /**
   * After `closed` (the notice with number `seq` was applied): poll until the terminal is finished, then `hc rm`. At the bound a shell in
   * the foreground is killed first; any other program only when the read at the bound still carries the closed label with `seq` (so it
   * is the session that reported itself closed); without it the terminal is reported and left. Returns true when the terminal is gone
   * or was removed. Residual risk: where a terminal tool reports the child's detached cleanup as the foreground program and the cleanup
   * takes longer than the wait, a worktree and a branch stay behind, and `foreman worktree sweep` removes them (checked on one
   * platform by experiment: the tool reported the foreground job, not the detached process).
   */
  private async reap(w: Watched, seq: number): Promise<boolean> {
    const address = w.address;
    // `hc rm` is checked: one retry after a poll interval, then the leftover is reported (prune removes it later)
    const rm = async (): Promise<boolean> => {
      for (let i = 0; i < 2 && !this.stopped; i++) {
        const r = await this.hc(["rm", address], 10_000, this.abort.signal);
        if (r.code === 0 || (r.code === 3 && notFound(r.stderr))) return true;
        if (i === 0) await this.sleep(REAP_POLL_MS);
      }
      if (!this.stopped) this.d.notify?.(`remote terminal ${address} is finished but \`hc rm\` failed; left alone (\`foreman session prune\` or \`hc rm ${address}\` removes it)`, "warning");
      return false;
    };
    let last: { s: string; fg?: unknown; notice?: unknown } = { s: "unknown" };
    for (let i = 0; i <= REAP_POLLS && !this.stopped; i++) {
      last = await this.peek(address);
      if (last.s === "gone") return true;
      if (last.s === "finished") return rm();
      if (i < REAP_POLLS) await this.sleep(REAP_POLL_MS);
    }
    if (this.stopped) return false;
    const shell = isShellName(last.fg);
    const parsed = parseNoticeLabel(last.notice);
    const labelled = parsed?.kind === "closed" && parsed.seq === seq;
    if (last.s === "live" && (shell || labelled)) {
      await this.hc(["kill", address], 10_000, this.abort.signal);
      if (!shell) this.d.notify?.(`ended ${typeof last.fg === "string" ? strip(last.fg).slice(0, 64) : "the foreground program"} in ${address} after the session closed`, "warning");
      for (let i = 0; i < REAP_KILL_POLLS && !this.stopped; i++) {
        await this.sleep(REAP_POLL_MS);
        const k = await this.peek(address);
        if (k.s === "gone") return true;
        if (k.s === "finished") return rm();
      }
    }
    this.d.notify?.(`remote terminal ${address} is still ${last.s} after the session closed; left alone (remove it with \`hc rm ${address}\` once pi has exited)`, "warning");
    return false;
  }

  private async pollOne(child: string): Promise<void> {
    const w = this.state.get(child);
    if (!w) return;
    const r = await this.hc(["get", w.address, "--json"], GET_TIMEOUT_MS, this.abort.signal);
    if (this.stopped) return;
    if (r.code === 0) {
      let reply: unknown;
      try {
        reply = JSON.parse(r.stdout.toString("utf8"));
      } catch {
        return;
      }
      this.contacts.set(child, (this.d.now ?? Date.now)());
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
    if (!w || this.stopped) return;
    if ((a.type === "notice" || a.type === "refused") && a.seq <= w.lastSeq) return; // applied meanwhile
    if (a.type === "ignored") {
      this.d.trace?.({ event: "remote_notice_ignored", child: a.child, value: strip(a.value).slice(0, 80) });
      return;
    }
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
        const r = await this.hc(["file", "read", "--on", w.machine, remote], timeout, this.abort.signal);
        if (this.stopped) return;
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
    let attach: unknown;
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
      if (a.kind === "ask") {
        // `n` and `topic` come from the mirrored ask.md header `# Ask <n>: <topic>`; `seq` is only the notice counter
        const head = buf ? parseAskHeader(buf.toString("utf8")) : null;
        e.ask = { seq: a.seq, path: hit.path, at: hit.entry.last?.at, rulings: typeof e.rulings === "number" ? e.rulings : 0, ...(head ? { n: head.n, topic: head.topic } : {}) };
      }
      else delete e.ask;
      wake = { kind: hit.kind, path: hit.path };
      if (a.kind === "closed") attach = (e.attach as { address?: unknown } | undefined)?.address;
      return true;
    });
    if (!wake) {
      this.setError(w.child, problem);
      fail(this.state, w.child, a.value);
      return;
    }
    commit(this.state, w.child, a.seq);
    // the local `hc attach` terminal of the session ends with it (best effort; `--rm` removes it once it exits)
    if (typeof attach === "string" && attach) void this.hc(["kill", attach], 10_000, this.abort.signal).catch(() => undefined);
    // the remote terminal (`--keep`) outlives pi: remove it once pi has exited (never killed while pi is still closing)
    if (a.kind === "closed") {
      void this.reap(w, a.seq)
        .then((removed) => {
          if (removed) this.update(w.child, (e) => ((e.reaped = true), true));
        })
        .catch(() => undefined);
    }
    const done = wake as { kind: string; path: string };
    // a result names the close command (the address form); the path part is cut first so the line survives the 300-character cut of `foreman_wait`
    const text = done.kind === "result" ? `${done.path.slice(0, Math.max(0, 300 - CLOSE_LINE(w).length)).trimEnd()}${CLOSE_LINE(w)}` : done.path;
    this.d.notify?.(`pi-foreman session ${w.label}@${w.machine}: ${done.kind}${text ? ` ${text}` : ""}`, "info");
    this.d.wake(w.label, done.kind, text);
  }
}
