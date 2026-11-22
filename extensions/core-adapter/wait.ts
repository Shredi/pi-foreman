// Long wait with a batching governor (plan D9, ledger items 13-15, 22, 23, 39).
//
// `foreman_wait` (foreman only) starts a model-free wait on a timer, a file appearing, a process
// ending or a GitHub Actions run completing, and returns at once with a wait id. Polling is
// plain unref'd one-shot timers, started with the first wait and all cleared at
// session_shutdown; no model turn runs while waiting. The first resolved trigger opens a window
// of `wait.batchWindowSeconds` (0 = immediate); when it closes, or as soon as no wait is left,
// ONE `foreman_wake` custom message carries every outcome (metadata only: no file contents, no
// CI logs). The wake is an ordinary custom message: its turn meets the same context-event drift
// check, triage gate, permission system and launch checks as any other turn (no bypass here).
//
// File bound (item 39): the path (as given and with symlinks resolved, triage.ts realDeep) must
// sit inside the workspace (its .workflow/ included) or `<agentDir>/pi-foreman/state/wait/`;
// inside the workspace the gate's write protection (floors, self-modification, protected folders) refuses it too. Owned dirs (owned.ts readWrite:
// the handoff dirs, subagent-artifacts, the round worktree dir) are accepted when the caller passes them.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { rulingFresh } from "./ruling.ts";
import { get } from "./config.ts";
import { underOwned } from "./owned.ts";
import { baseFloorEnv } from "./gate.ts";
import { pathFloors } from "./floors.ts";
import { folderProtected } from "./pathrules.ts";
import type { GateRoots } from "./pathrules.ts";
import { pathSelfmod } from "./selfmod.ts";
import { resolveToolPath } from "./payload.ts";
import { underTask } from "./recheckexempt.ts";
import { workspaceOf } from "./python.ts";
import { realDeep, under } from "./triage.ts";
import { resolveBin, resolveGh } from "./ghbin.ts";
import { pressureOutcome } from "./pressure.ts";
import { WAKE_MESSAGE_TYPE } from "./usage.ts";
import { WAITS_ENTRY, latestWaits, lostWaitsMessage, waitsEntry } from "./waitstate.ts";
import { strOf } from "./strof.ts";

export const WAIT_TOOL = "foreman_wait";
/** The custom message type of the quiet line that ends a child wait taken by a notice inside a run (no turn cause: usage.ts causeOfCustom knows none). */
export const WAIT_NOTE_TYPE = "foreman_wait_note";
export const WAIT_KINDS = ["timer", "file", "pid", "ci", "child", "pressure"] as const;
/** The kinds `foreman_wait start` accepts; `pressure` waits are started by the adapter (pressure.ts). */
export const TOOL_WAIT_KINDS = WAIT_KINDS.filter((k) => k !== "pressure");
export type WaitKind = (typeof WAIT_KINDS)[number];
export const RUN_ID = /^\d{1,20}$/;
export const NOTE_MAX = 200;
export const POLL_MS: Record<WaitKind, number> = { timer: 0, file: 2000, pid: 2000, ci: 60_000, child: 0, pressure: 0 };
export const CI_TIMEOUT_MS = 30_000;
const GH_MISSING = "gh was not found on PATH outside the workspace (empty, relative and workspace PATH entries are skipped).";
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface WaitLimits {
  batchWindowSeconds: number;
  maxSeconds: number;
  maxActive: number;
  ci: boolean;
}

const DEFAULTS: WaitLimits = { batchWindowSeconds: 300, maxSeconds: 86400, maxActive: 8, ci: true };

/** `wait.*` config keys with the shipped defaults for missing or malformed values. */
export function waitLimits(read: (key: keyof WaitLimits) => unknown): WaitLimits {
  const num = (k: "batchWindowSeconds" | "maxSeconds" | "maxActive", min: number): number => {
    const v = read(k);
    return typeof v === "number" && Number.isFinite(v) && v >= min ? Math.floor(v) : DEFAULTS[k];
  };
  return { batchWindowSeconds: num("batchWindowSeconds", 0), maxSeconds: num("maxSeconds", 1), maxActive: num("maxActive", 1), ci: read("ci") !== false };
}

export type ValidSpec =
  | { kind: "timer"; seconds: number; note: string }
  | { kind: "file"; path: string; note: string }
  | { kind: "pid"; pid: number; note: string; log?: string }
  | { kind: "ci"; runId: string; note: string; log?: string }
  | { kind: "child"; label: string; note: string }
  /** Adapter-started: critical = wake when the level drops below critical (or after `boundSeconds`); queue = wake when no run is active. */
  | { kind: "pressure"; mode: "critical" | "queue"; args: unknown[]; pollMs: number; boundSeconds: number; note: string };

/** Registry child label (or `any`) a `child` wait names. */
export const CHILD_LABEL = /^[A-Za-z0-9._-]{1,40}$/;

export interface PathBoundOpts {
  cwd: string;
  home: string;
  agentDir: string;
  platform: string;
  /** The session's gate roots (write protection: floors, self-modification, protected folders); null = unavailable, workspace paths are refused. */
  roots: GateRoots | null;
  /** ownedRoots(...).readWrite: a file wait may also watch a path under these (default: none). */
  owned?: string[];
  /** R14 item 1: the session's own bg_run task dirs (roundsurface.ts ownTaskReadable): a pid/ci `log` may be a file there. */
  ownTasks?: string[];
}

/** One line, control characters dropped, capped. */
export function oneLine(v: unknown, max: number): string {
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() : "";
  return s.length > max ? s.slice(0, max) : s;
}

/** `ci` run id: digits only (a GitHub Actions run id), as a string. */
export function checkRunId(v: unknown): { runId: string } | { error: string } {
  const s = typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? String(v) : v;
  if (typeof s === "string" && RUN_ID.test(s)) return { runId: s };
  return { error: `${WAIT_TOOL}: ci runId must be 1 to 20 digits (a GitHub Actions run id).` };
}

/** Item 39: the file a `file` wait may watch, resolved, or why not. */
export function checkWaitPath(raw: unknown, o: PathBoundOpts): { path: string } | { error: string } {
  const abs = resolveToolPath(raw, o.cwd, o.home);
  if (!abs) return { error: `${WAIT_TOOL}: file needs a path.` };
  const real = realDeep(abs);
  const rootsOf = (p: string): string[] => [path.resolve(p), realDeep(path.resolve(p))];
  const inside = (roots: string[]): boolean => roots.some((r) => under(r, abs, o.platform)) && roots.some((r) => under(r, real, o.platform));
  const shown = oneLine(raw, 160);
  if (inside(rootsOf(path.join(o.agentDir, "pi-foreman", "state", "wait")))) return { path: abs };
  const ownedHit = (r: string): boolean => {
    const roots = rootsOf(r);
    return roots.some((x) => underOwned(x, abs, o.platform)) && roots.some((x) => underOwned(x, real, o.platform));
  };
  if ((o.owned ?? []).some(ownedHit)) return { path: abs };
  if (inside(rootsOf(workspaceOf(o.cwd).root))) {
    const roots = o.roots;
    if (!roots) return { error: `pi-foreman: ${WAIT_TOOL} on '${shown}' refused: the gate roots are unavailable, so the write protection cannot be checked. Run /foreman doctor.` };
    const env = baseFloorEnv(o.cwd, { home: o.home, platform: o.platform, agentDir: o.agentDir, scratch: roots.scratch, ...(roots.pkgRoot ? { pkgRoot: roots.pkgRoot } : {}), ...(roots.sessionDir ? { sessionDir: roots.sessionDir } : {}), ...(roots.child ? { child: true } : {}) });
    // `<worktree>/.pi/tasks/`: only the session's own task dirs pass (path as given and resolved); another session's output is refused
    const taskRoots = [o.cwd, workspaceOf(o.cwd).root].flatMap((r) => rootsOf(path.join(r, ".pi", "tasks")));
    const inTasks = (p: string): boolean => taskRoots.some((r) => under(r, p, o.platform));
    if (inTasks(abs) || (real !== null && inTasks(real))) {
      const own = (p: string): boolean => (o.ownTasks ?? []).some((pat) => underTask(pat, p, o.platform) || underTask(path.join(realDeep(path.dirname(pat)), path.basename(pat)), p, o.platform));
      if (real !== null && own(abs) && own(real)) return { path: abs };
      return { error: `pi-foreman: ${WAIT_TOOL} on '${shown}' refused: the path is under the write protection (another session's task output).` };
    }
    const protectedAt = (p: string): boolean => !!pathFloors({ path: p }, env, "write") || !!pathSelfmod("write", { path: p }, o.cwd, roots, o.platform) || folderProtected(roots, o.platform, p);
    if (protectedAt(abs) || (real !== null && protectedAt(real))) {
      return { error: `pi-foreman: ${WAIT_TOOL} on '${shown}' refused: the path is under the write protection (git internals, agent or harness configuration).` };
    }
    return { path: abs };
  }
  return { error: `pi-foreman: ${WAIT_TOOL} on '${shown}' refused: a file wait must resolve (symlinks followed) inside the workspace, its .workflow/ or <agentDir>/pi-foreman/state/wait/.` };
}

/**
 * The optional `log` of a pid or ci wait (shown by `/foreman waits`, its last lines): a path the file wait bound accepts,
 * or one under `<agentDir>/pi-foreman/state/scratch/`. Absent or empty = none.
 */
export function checkLogPath(raw: unknown, o: PathBoundOpts): { log?: string } | { error: string } {
  if (raw === undefined || raw === null || raw === "") return {};
  const abs = resolveToolPath(raw, o.cwd, o.home);
  if (!abs) return { error: `${WAIT_TOOL}: log must be a path.` };
  const real = realDeep(abs);
  const roots = [path.resolve(path.join(o.agentDir, "pi-foreman", "state", "scratch")), realDeep(path.resolve(path.join(o.agentDir, "pi-foreman", "state", "scratch")))];
  if (roots.some((r) => under(r, abs, o.platform)) && roots.some((r) => under(r, real, o.platform))) return { log: abs };
  // R14 item 1: the session's own bg_run output (`.pi/tasks/<own session>-<pid>/…`), symlinks followed; another session's stays refused
  // the resolved path is compared against the patterns as given and with their dir resolved (a win32 8.3 temp name differs from the long one)
  const realPat = (p: string): string => path.join(realDeep(path.dirname(p)), path.basename(p));
  const tasks = o.ownTasks ?? [];
  if (tasks.some((p) => underTask(p, abs, o.platform)) && tasks.some((p) => underTask(p, real, o.platform) || underTask(realPat(p), real, o.platform))) return { log: abs };
  const r = checkWaitPath(raw, o);
  return "error" in r ? { error: r.error.replace(`${WAIT_TOOL} on`, `${WAIT_TOOL} log on`) } : { log: r.path };
}

/** Validate a `start` call; the result is safe to hand to the runtime. */
export function parseStart(params: Record<string, unknown>, limits: WaitLimits, bound: PathBoundOpts): ValidSpec | { error: string } {
  const note = oneLine(params.note, NOTE_MAX);
  switch (params.kind) {
    case "timer": {
      const s = params.seconds;
      if (typeof s !== "number" || !Number.isInteger(s) || s < 1 || s > limits.maxSeconds) return { error: `${WAIT_TOOL}: timer seconds must be an integer from 1 to ${limits.maxSeconds} (wait.maxSeconds).` };
      return { kind: "timer", seconds: s, note };
    }
    case "file": {
      const r = checkWaitPath(params.path, bound);
      return "error" in r ? r : { kind: "file", path: r.path, note };
    }
    case "pid": {
      const p = params.pid;
      if (typeof p !== "number" || !Number.isSafeInteger(p) || p <= 1) return { error: `${WAIT_TOOL}: pid must be an integer greater than 1.` };
      const lg = checkLogPath(params.log, bound);
      if ("error" in lg) return lg;
      return { kind: "pid", pid: p, note, ...(lg.log ? { log: lg.log } : {}) };
    }
    case "ci": {
      if (!limits.ci) return { error: `${WAIT_TOOL}: ci waits are off (wait.ci is false).` };
      const r = checkRunId(params.runId);
      if ("error" in r) return r;
      const lg = checkLogPath(params.log, bound);
      if ("error" in lg) return lg;
      return { kind: "ci", runId: r.runId, note, ...(lg.log ? { log: lg.log } : {}) };
    }
    case "child": {
      const label = oneLine(params.label, 40);
      if (!CHILD_LABEL.test(label)) return { error: `${WAIT_TOOL}: child needs a label (a registry session label, or any).` };
      return { kind: "child", label, note };
    }
    default:
      return { error: `${WAIT_TOOL}: kind must be timer, file, pid, ci or child.` };
    // (a `pressure` kind is rejected here too: the adapter starts those)
  }
}

export interface Outcome {
  id: string;
  kind: WaitKind;
  note: string;
  outcome: string;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(h: unknown): void;
}

export const realTimers: Timers = {
  set(fn, ms) {
    const h = setTimeout(fn, Math.min(Math.max(0, ms), MAX_TIMER_MS));
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clear(h) {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

/**
 * Batches resolved triggers into one wake (item 14). Leading edge: an outcome with no window open is delivered at once; when
 * another wait is still active a window opens then, and outcomes resolving inside it go out together when it closes (or as soon
 * as no wait is active). After a window closes the next outcome is delivered at once again.
 */
export class Governor {
  private pending: Outcome[] = [];
  private timer: unknown = null;
  private readonly d: { windowMs: () => number; active: () => number; timers: Timers; send: (o: Outcome[]) => void };

  constructor(d: { windowMs: () => number; active: () => number; timers: Timers; send: (o: Outcome[]) => void }) {
    this.d = d;
  }

  resolved(o: Outcome): void {
    this.pending.push(o);
    if (this.d.active() === 0) return this.flush();
    if (this.timer !== null) return;
    this.flush();
    const ms = this.d.windowMs();
    if (ms > 0) this.timer = this.d.timers.set(() => this.flush(), ms);
  }

  /** After a cancel: no wait left means the window closes now. */
  check(): void {
    if (this.pending.length && this.d.active() === 0) this.flush();
  }

  flush(): void {
    if (this.timer !== null) this.d.timers.clear(this.timer);
    this.timer = null;
    const out = this.pending;
    this.pending = [];
    if (out.length) this.d.send(out);
  }

  dispose(): void {
    if (this.timer !== null) this.d.timers.clear(this.timer);
    this.timer = null;
    this.pending = [];
  }
}

export interface CiStatus {
  status: string;
  conclusion: string;
  url: string;
}

export interface RuntimeDeps {
  timers: Timers;
  now: () => number;
  limits: () => WaitLimits;
  /** Size of an existing file, else null (never reads contents). */
  stat: (p: string) => number | null;
  /** False once the process is gone (ESRCH). */
  alive: (pid: number) => boolean;
  gh: (runId: string) => Promise<CiStatus>;
  /** Why `gh` cannot be run (not found outside the workspace), else null. Absent = no check. */
  ghRefusal?: () => string | null;
  wake: (outcomes: Outcome[]) => void;
  trace: (rec: Record<string, unknown>) => void;
  /** pressure waits: the current pressure level and reasons (reads the pressure file). */
  pressure?: () => { level: string; reasons: string[] };
  /** pressure queue waits: true when no child run is active. */
  idle?: () => boolean;
  /** Called after the set of active waits changed (a wait started, resolved or cancelled). */
  changed?: () => void;
  /** Modification time (ms) of a file, else null; lets a ruling wait ignore a ruling older than its ask.md. */
  mtime?: (p: string) => number | null;
  /** True while a run is in progress (the adapter's own record, agent_start .. agent_end). Absent = never. */
  inRun?: () => boolean;
  /** A carried child notice ended a wait inside a run: the wait ends with this one quiet line, not a wake. */
  taken?: (outcome: Outcome) => void;
}

interface Entry {
  id: string;
  kind: WaitKind;
  note: string;
  /** child waits: the registry label to wake on, or `any`. */
  label?: string;
  /** pid and ci waits: a log file shown by `/foreman waits` and named in the wake line. */
  log?: string;
  /** pid waits: the watched process (a second wait on it dedupes). */
  pid?: number;
  started: number;
  deadline: number;
  handles: unknown[];
  /** The current poll timer only (replaced on each poll, so finished handles are not retained). */
  pollHandle?: unknown;
  ghErrors: number;
  ghFirstError: string;
  /** pressure waits: mode and the launch arguments to hand back (a shared array a queue may still grow). */
  press?: { mode: "critical" | "queue"; args: unknown[] };
}

/** Active waits of one foreman session. */
export class WaitRuntime {
  private readonly waits = new Map<string, Entry>();
  /** Resolved waits whose wake is not delivered yet (batch window or held while busy): kept in the stored set, not active. */
  private readonly undelivered = new Map<string, Outcome>();
  private seq = 0;
  private disposed = false;
  readonly governor: Governor;
  private readonly d: RuntimeDeps;

  constructor(d: RuntimeDeps) {
    this.d = d;
    this.governor = new Governor({ windowMs: () => d.limits().batchWindowSeconds * 1000, active: () => this.waits.size, timers: d.timers, send: (o) => this.sendWake(o) });
  }

  get active(): number {
    return this.waits.size;
  }

  /** Why a wait cannot start now (wait.maxActive), else null. */
  capacityError(): string | null {
    const limits = this.d.limits();
    return this.waits.size >= limits.maxActive ? `${WAIT_TOOL}: ${this.waits.size} waits are active (wait.maxActive ${limits.maxActive}); cancel one first.` : null;
  }

  start(spec: ValidSpec): { id: string; deduped?: true } | { error: string } {
    if (spec.kind === "pid") {
      const same = [...this.waits.values()].find((w) => w.kind === "pid" && w.pid === spec.pid);
      if (same) return { id: same.id, deduped: true };
    }
    if (spec.kind === "child") {
      const same = [...this.waits.values()].find((w) => w.kind === "child" && w.label === spec.label);
      if (same) return { id: same.id, deduped: true };
    }
    const limits = this.d.limits();
    const full = this.capacityError();
    if (full) {
      this.d.trace({ event: "wait", decision: "refused", toolFamily: spec.kind });
      return { error: full };
    }
    const refusal = spec.kind === "ci" ? this.d.ghRefusal?.() ?? null : null;
    if (refusal) {
      this.d.trace({ event: "wait", decision: "refused", toolFamily: spec.kind });
      return { error: `${WAIT_TOOL}: ${refusal}` };
    }
    const id = `w${++this.seq}`;
    const now = this.d.now();
    const e: Entry = { id, kind: spec.kind, note: spec.note, started: now, deadline: now + limits.maxSeconds * 1000, handles: [], ghErrors: 0, ghFirstError: "" };
    if (spec.kind === "child") e.label = spec.label;
    else if ((spec.kind === "pid" || spec.kind === "ci") && spec.log) e.log = spec.log;
    if (spec.kind === "pid") e.pid = spec.pid;
    if (spec.kind === "pressure") e.press = { mode: spec.mode, args: spec.args };
    this.waits.set(id, e);
    if (spec.kind === "pressure") {
      const bound = Math.min(spec.boundSeconds, limits.maxSeconds);
      e.handles.push(this.d.timers.set(() => this.resolve(id, pressureOutcome(spec.mode, "timeout", spec.args)), bound * 1000));
      this.pollPressure(e, spec);
      this.d.trace({ event: "wait", decision: "start", toolFamily: spec.kind });
      this.notify();
      return { id };
    }
    e.handles.push(this.d.timers.set(() => this.resolve(id, "timeout"), limits.maxSeconds * 1000));
    if (spec.kind === "timer") e.handles.push(this.d.timers.set(() => this.resolve(id, "elapsed"), spec.seconds * 1000));
    else if (spec.kind !== "child") this.poll(e, spec, 0);
    this.d.trace({ event: "wait", decision: "start", toolFamily: spec.kind });
    this.notify();
    return { id };
  }

  /** Re-checks the pressure file every `pollMs`: a critical wait ends below critical, a queue wait when no run is active or the level is ok. */
  private pollPressure(e: Entry, spec: Extract<ValidSpec, { kind: "pressure" }>): void {
    e.pollHandle = this.d.timers.set(() => {
      if (!this.waits.has(e.id)) return;
      const p = this.d.pressure?.() ?? { level: "ok", reasons: [] };
      const level = (p.level === "high" || p.level === "critical" ? p.level : "ok") as "ok" | "high" | "critical";
      if (spec.mode === "critical" ? level !== "critical" : level === "ok" || (this.d.idle?.() ?? true)) return this.resolve(e.id, pressureOutcome(spec.mode, level, spec.args));
      this.pollPressure(e, spec);
    }, spec.pollMs);
  }

  private poll(e: Entry, spec: Exclude<ValidSpec, { kind: "child" | "pressure" }>, delay: number): void {
    e.pollHandle = this.d.timers.set(() => {
        if (!this.waits.has(e.id)) return;
        if (spec.kind === "file") {
          const size = this.d.stat(spec.path);
          if (size !== null && (!this.d.mtime || rulingFresh(spec.path, this.d.mtime))) {
            return this.resolve(e.id, `exists, ${size} bytes`);
          }
        } else if (spec.kind === "pid") {
          if (!this.d.alive(spec.pid)) return this.resolve(e.id, "exited (exit code not knowable)");
        } else if (spec.kind === "ci") {
          this.d.gh(spec.runId).then(
            (r) => {
              if (!this.waits.has(e.id)) return;
              e.ghErrors = 0;
              if (r.status === "completed") return this.resolve(e.id, oneLine(`${r.conclusion || "unknown"} ${r.url}`, 300));
              this.poll(e, spec, POLL_MS.ci);
            },
            (err: unknown) => {
              if (!this.waits.has(e.id)) return;
              if (e.ghErrors++ === 0) e.ghFirstError = oneLine(String((err as Error)?.message ?? err).split(/\r?\n/)[0], 120);
              if (e.ghErrors >= 3) return this.resolve(e.id, `poll-error: ${e.ghFirstError}`);
              this.poll(e, spec, POLL_MS.ci);
            },
          );
          return;
        }
        this.poll(e, spec, POLL_MS[spec.kind]);
      }, delay);
  }

  private drop(id: string): Entry | undefined {
    const e = this.waits.get(id);
    if (!e) return undefined;
    for (const h of e.handles) this.d.timers.clear(h);
    if (e.pollHandle !== undefined) this.d.timers.clear(e.pollHandle);
    this.waits.delete(id);
    this.notify();
    return e;
  }

  private notify(): void {
    if (this.disposed) return;
    try {
      this.d.changed?.();
    } catch {
      // observers are best effort
    }
  }

  resolve(id: string, outcome: string): void {
    if (this.disposed) return;
    const w = this.waits.get(id);
    if (!w) return;
    const o: Outcome = { id: w.id, kind: w.kind, note: w.note, outcome: w.log ? `${outcome}; log ${w.log}` : outcome };
    if (w.kind !== "pressure") this.undelivered.set(id, o);
    const e = this.drop(id);
    if (!e) return;
    this.d.trace({ event: "wait", decision: "resolved", toolFamily: e.kind });
    this.governor.resolved(o);
  }

  /** The wake carrying these outcomes was sent: they leave the stored set. */
  delivered(ids: string[]): void {
    let any = false;
    for (const id of ids) any = this.undelivered.delete(id) || any;
    if (any) this.notify();
  }

  /** Resolved waits whose wake is not delivered yet (for the stored set). */
  pendingOutcomes(): Outcome[] {
    return [...this.undelivered.values()];
  }

  cancel(id: string): boolean {
    return this.cancelWith(id);
  }

  /** The ids of the open critical pressure waits whose one relaunch argument equals `args` (deep JSON equality). */
  pressureIds(args: unknown): string[] {
    return [...this.waits.values()].filter((e) => e.press?.mode === "critical" && e.press.args.length === 1 && isDeepStrictEqual(e.press.args[0], args)).map((e) => e.id);
  }

  /** Cancels those waits; returns their ids. */
  dropPressure(args: unknown): string[] {
    return this.pressureIds(args).filter((id) => this.cancel(id));
  }

  private cancelWith(id: string): boolean {
    const e = this.drop(id);
    if (!e) return false;
    this.d.trace({ event: "wait", decision: "cancelled", toolFamily: e.kind });
    this.governor.check();
    return true;
  }

  /**
   * A plan, result, update, ask or closed notice of the registry child `label` (a remote child passes its mirror path): resolves the first child wait
   * naming that label (else the first naming `any`). A notice before the wait starts is not replayed. `carried`: the notice came as an intercom message;
   * with a run in progress that message is already in the run, so the wait ends through `taken` (one quiet line) and nothing is woken.
   */
  childNotice(label: string, kind: string, notePath: string, carried = false): boolean {
    const waits = [...this.waits.values()].filter((e) => e.kind === "child");
    const hit = waits.find((e) => e.label === label) ?? waits.find((e) => e.label === "any");
    if (!hit) return false;
    const outcome = `child ${label}: ${kind}${notePath ? ` ${oneLine(notePath, 300)}` : ""}`;
    if (!carried || !this.d.inRun?.() || this.disposed) {
      this.resolve(hit.id, outcome);
      return true;
    }
    this.drop(hit.id);
    this.d.trace({ event: "wait", decision: "taken", toolFamily: hit.kind });
    this.d.taken?.({ id: hit.id, kind: hit.kind, note: hit.note, outcome });
    this.governor.check();
    return true;
  }

  /** Cancels every active wait (a close of the session); the cancelled ids. */
  cancelAll(): string[] {
    return [...this.waits.keys()].filter((id) => this.cancelWith(id));
  }

  list(): { id: string; kind: WaitKind; note: string; ageSeconds: number; leftSeconds: number; log?: string }[] {
    const now = this.d.now();
    return [...this.waits.values()].map((e) => ({ id: e.id, kind: e.kind, note: e.note, ageSeconds: Math.round((now - e.started) / 1000), leftSeconds: Math.max(0, Math.round((e.deadline - now) / 1000)), ...(e.log ? { log: e.log } : {}) }));
  }

  private sendWake(outcomes: Outcome[]): void {
    if (this.disposed) return;
    const kinds = [...new Set(outcomes.map((o) => o.kind))];
    this.d.trace({ event: "wait", decision: "wake", wakeKinds: kinds.join(",") });
    this.d.wake(outcomes);
  }

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.waits.keys()]) this.drop(id);
    this.governor.dispose();
  }
}

/** The wake message: one line per outcome (id, kind, note, outcome). */
export function wakeMessage(outcomes: Outcome[]): { customType: string; content: string; display: true; details: { kinds: WaitKind[]; ids: string[] } } {
  const content = outcomes.map((o) => `${WAIT_TOOL} ${o.id} (${o.kind})${o.note ? ` "${o.note}"` : ""}: ${o.outcome}`).join("\n");
  return { customType: WAKE_MESSAGE_TYPE, content, display: true, details: { kinds: outcomes.map((o) => o.kind), ids: outcomes.map((o) => o.id) } };
}

// resolveBin and resolveGh live in ghbin.ts (no Pi import there); re-exported for the importers of this module.
export { resolveBin, resolveGh };

/** `gh run view <id> --json status,conclusion,url` (no shell; gh resolved by resolveGh, cwd = workspace). */
export function ghRunView(runId: string, cwd: string): Promise<CiStatus> {
  return new Promise((resolve, reject) => {
    const gh = resolveGh(cwd);
    if (!gh) return reject(new Error(GH_MISSING));
    execFile(gh, ["run", "view", runId, "--json", "status,conclusion,url"], { cwd, timeout: CI_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || "").trim() || err.message));
      try {
        const j = JSON.parse(String(stdout)) as Record<string, unknown>;
        resolve({ status: strOf(j.status), conclusion: strOf(j.conclusion), url: strOf(j.url) });
      } catch {
        reject(new Error("gh run view: unreadable JSON"));
      }
    });
  });
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function fileMtime(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

function fileSize(p: string): number | null {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

export interface WaitSession {
  id: string;
  isChild: boolean;
  cwd: string;
  agentDir: string;
  /** The gate roots of this session (index.ts gateRootsOf), for the file wait's write protection. */
  roots: GateRoots | null;
  /** The merged config (read at each use, so a reload applies). */
  config: () => unknown;
  trace: (rec: Record<string, unknown>) => void;
  /** ownedRoots(...).readWrite, read at each use (the foreman only). */
  owned?: () => string[];
  /** R14 item 1: the session's own bg_run task dir patterns for this cwd (roundsurface.ts ownTaskReadable; the foreman only). */
  ownTasks?: (cwd: string) => string[];
  /** Called with a started wait's spec (the finish gate's waiting_for_parent state). */
  onStart?: (spec: ValidSpec, id: string) => void;
  /** Called after a wait was cancelled (the finish gate may leave waiting_for_parent). */
  onCancel?: (id: string) => void;
  /** Appends a pending steer.md (steer.ts) to a wake message text. */
  steer?: (text: string) => string;
  /** The current pressure level and reasons (pressure waits). */
  pressure?: () => { level: string; reasons: string[] };
  /** True when no child run is active (pressure queue waits). */
  idle?: () => boolean;
  /** True while the active run was started by an intercom message (turn cause intercom): a wake then merges into it as a follow-up. */
  intercomRun?: () => boolean;
  /** True while a run is in progress (agent_start .. agent_end): a child notice that came as an intercom message is then already in that run. */
  inRun: () => boolean;
}

const PARAMS = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["start", "list", "cancel"] },
    kind: { type: "string", enum: [...TOOL_WAIT_KINDS], description: "start: what to wait for." },
    seconds: { type: "integer", minimum: 1, description: "timer: seconds to wait." },
    path: { type: "string", description: "file: resolves when this file exists (inside the workspace, its .workflow/ or <agentDir>/pi-foreman/state/wait/)." },
    pid: { type: "integer", minimum: 2, description: "pid: resolves when this process has exited." },
    runId: { type: "string", description: "ci: GitHub Actions run id (digits); resolves when the run completes." },
    label: { type: "string", description: "child: the label of a session opened by `foreman session open`, or any; resolves on its next plan, result, update, ask or closed notice (a remote child's wake names its mirror path; a notice that came before the wait started is not replayed)." },
    note: { type: "string", maxLength: NOTE_MAX, description: "start: shown back in the wake message." },
    log: { type: "string", description: "start, pid or ci: a log file shown by `/foreman waits` (last 5 lines) and named in the wake message." },
    id: { type: "string", description: "cancel: the wait id." },
  },
  required: ["action"],
  additionalProperties: false,
};

/** Register `foreman_wait` (foreman sessions only) and its shutdown cleanup. */
export function registerWait(pi: ExtensionAPI, deps: { session: (ctx: ExtensionContext) => Promise<WaitSession>; home: string; platform: string }): { active: (sessionId: string) => ReturnType<WaitRuntime["list"]>; childNotice: (sessionId: string, label: string, kind: string, notePath: string, carried?: boolean) => boolean; cancelAll: (sessionId: string) => string[]; onChange: (sessionId: string, cb: () => void) => () => void; startPressure: (ctx: ExtensionContext, spec: Extract<ValidSpec, { kind: "pressure" }>) => Promise<{ id: string } | { error: string }>; hasPressure: (ctx: ExtensionContext, args: unknown) => boolean; dropPressure: (ctx: ExtensionContext, args: unknown) => Promise<number>; restore: (ctx: ExtensionContext) => Promise<void>; settled: (sessionId: string) => void } {
  /** `held`: outcomes that resolved while a run was active; `settled` sends them as one wake that starts a run of its own. */
  const runtimes = new Map<string, { rt: WaitRuntime; ctx: ExtensionContext; held: Outcome[]; send: (outcomes: Outcome[], followUp?: boolean) => void }>();
  const listeners = new Map<string, Set<() => void>>();
  const handle = {
    onChange: (sessionId: string, cb: () => void) => {
      const set = listeners.get(sessionId) ?? new Set<() => void>();
      listeners.set(sessionId, set);
      set.add(cb);
      return () => void set.delete(cb);
    },
    active: (sessionId: string) => runtimes.get(sessionId)?.rt.list() ?? [],
    childNotice: (sessionId: string, label: string, kind: string, notePath: string, carried?: boolean) => runtimes.get(sessionId)?.rt.childNotice(label, kind, notePath, carried) ?? false,
    // Called by the close sequence only (session_shutdown and a reload just dispose the runtime).
    cancelAll: (sessionId: string) => {
      const rt = runtimes.get(sessionId)?.rt;
      return rt?.cancelAll() ?? [];
    },
    startPressure: async (_ctx: ExtensionContext, _spec: Extract<ValidSpec, { kind: "pressure" }>): Promise<{ id: string } | { error: string }> => ({ error: "pressure waits are for the foreman only" }),
    hasPressure: (_ctx: ExtensionContext, _args: unknown): boolean => false,
    dropPressure: async (_ctx: ExtensionContext, _args: unknown): Promise<number> => 0,
    /** agent_settled (after the adapter reset its per-run state): a wake held during the run goes out as one message that triggers its own run. */
    settled: (sessionId: string): void => {
      const h = runtimes.get(sessionId);
      if (!h || h.held.length === 0) return;
      h.send(h.held.splice(0));
    },
    /** session_start of the foreman: report the waits a restart of this Pi session lost (called from the adapter's own handler). */
    restore: async (_ctx: ExtensionContext): Promise<void> => undefined,
  };
  pi.on("session_shutdown", async (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    runtimes.get(id)?.rt.dispose();
    runtimes.delete(id);
    listeners.delete(id);
  });
  if (process.env.PI_SUBAGENT_CHILD === "1") return handle;
  // A restart of the same Pi session lost its waits (waitstate.ts): one visible notice, then the stored set is emptied.
  handle.restore = async (ctx) => {
    const s = await deps.session(ctx);
    if (s.isChild) return;
    const r = latestWaits((ctx.sessionManager.getBranch?.() ?? []) as unknown[], ctx.sessionManager.getSessionId());
    const msg = lostWaitsMessage(r);
    if (!msg) return;
    try {
      pi.appendEntry(WAITS_ENTRY, waitsEntry(s.id, []));
    } catch {
      // the session file is not writable now
    }
    s.trace({ event: "wait", decision: "lost" });
    let idle = true;
    try {
      idle = ctx.isIdle();
    } catch {
      // a stale context: treat as idle
    }
    pi.sendMessage(msg, idle ? { triggerTurn: true } : { deliverAs: "followUp" });
  };
  const limitsOf = (s: WaitSession) => () => waitLimits((k) => get(s.config(), `wait.${k}`));
  /** The session's runtime, created with its first wait; foreman_wait uses it. */
  const ensureRuntime = (s: WaitSession, ctx: ExtensionContext): WaitRuntime => {
    const have = runtimes.get(s.id);
    if (have) {
      have.ctx = ctx;
      return have.rt;
    }
    const holder = { ctx, held: [] as Outcome[] } as { rt: WaitRuntime; ctx: ExtensionContext; held: Outcome[]; send: (outcomes: Outcome[], followUp?: boolean) => void };
    holder.send = (outcomes, followUp) => {
      const msg = wakeMessage(outcomes);
      if (s.steer) msg.content = s.steer(msg.content);
      pi.sendMessage(msg, followUp ? { deliverAs: "followUp" } : { triggerTurn: true });
      holder.rt.delivered(outcomes.map((o) => o.id));
    };
    const quiet = (o: Outcome): void => {
      const line = wakeMessage([{ ...o, outcome: `ended by the notice above: ${o.outcome}` }]);
      pi.sendMessage({ customType: WAIT_NOTE_TYPE, content: s.steer ? s.steer(line.content) : line.content, display: true }, { triggerTurn: false });
    };
    holder.rt = new WaitRuntime({
      timers: realTimers,
      now: () => Date.now(),
      limits: limitsOf(s),
      stat: fileSize,
      mtime: fileMtime,
      alive: processAlive,
      gh: (runId) => ghRunView(runId, workspaceOf(s.cwd).root),
      ghRefusal: () => (resolveGh(workspaceOf(s.cwd).root) ? null : `ci waits are refused: ${GH_MISSING}`),
      trace: s.trace,
      inRun: s.inRun,
      taken: quiet,
      pressure: s.pressure,
      idle: s.idle,
      changed: () => {
        for (const cb of [...(listeners.get(s.id) ?? [])]) cb();
        // dispose() silences changed(): a shutdown keeps the last stored set, which is what the resumed session reports as lost
        try {
          pi.appendEntry(WAITS_ENTRY, waitsEntry(s.id, [...holder.rt.list(), ...holder.rt.pendingOutcomes()]));
        } catch {
          // the session file is not writable now
        }
      },
      wake: (outcomes) => {
        let idle = true;
        try {
          idle = holder.ctx.isIdle();
        } catch {
          // a stale context: treat as idle
        }
        // A wake that merged into a running run would share its stop hold: hold it until the run settled (an intercom-triggered run takes it as a follow-up).
        if (!idle && s.intercomRun?.()) {
          holder.send([...holder.held.splice(0), ...outcomes], true);
          return;
        }
        if (!idle) {
          holder.held.push(...outcomes);
          return;
        }
        holder.send([...holder.held.splice(0), ...outcomes]);
      },
    });
    runtimes.set(s.id, holder);
    return holder.rt;
  };
  handle.startPressure = async (ctx, spec) => {
    const s = await deps.session(ctx);
    if (s.isChild) return { error: "pressure waits are for the foreman only" };
    const r = ensureRuntime(s, ctx).start(spec);
    if (!("error" in r)) s.onStart?.(spec, r.id);
    return r;
  };
  handle.hasPressure = (ctx, args) => (runtimes.get(ctx.sessionManager.getSessionId())?.rt.pressureIds(args).length ?? 0) > 0;
  handle.dropPressure = async (ctx, args) => {
    const s = await deps.session(ctx);
    const ids = runtimes.get(s.id)?.rt.dropPressure(args) ?? [];
    for (const id of ids) s.onCancel?.(id);
    return ids.length;
  };
  const waitTool = {
    name: WAIT_TOOL,
    label: "Long wait",
    description:
      "Wait without model turns for a timer, a file to appear, a process to exit, a GitHub Actions run to complete or a child session to report (kind child + label; one wait per label). Returns at once with a wait id; you are woken later by ONE message listing every outcome (triggers that resolve close together are batched). action start (kind + its argument, optional note), list, or cancel {id}.",
    parameters: PARAMS as never,
    async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const s = await deps.session(ctx);
      const text = (t: string, details: Record<string, unknown>, isError = false) => ({ content: [{ type: "text" as const, text: t }], details, ...(isError ? { isError: true } : {}) });
      const refuse = (t: string, kind?: unknown) => {
        s.trace({ event: "wait", decision: "refused", toolFamily: typeof kind === "string" && (WAIT_KINDS as readonly string[]).includes(kind) ? kind : null });
        return text(t, { decision: "refused" }, true);
      };
      if (s.isChild) return refuse(`${WAIT_TOOL} is for the foreman only.`);
      if (ctx.mode === "print" || ctx.mode === "json") return refuse(`${WAIT_TOOL}: long wait needs a TUI or RPC session.`, params.kind);
      const limits = limitsOf(s);
      let slot = runtimes.get(s.id);
      if (slot) slot.ctx = ctx;
      const ensure = (): WaitRuntime => {
        const rt = ensureRuntime(s, ctx);
        slot = runtimes.get(s.id);
        return rt;
      };
      if (params.action === "list") {
        const list = slot?.rt.list() ?? [];
        return text(list.length ? list.map((w) => `${w.id} ${w.kind}${w.note ? ` "${w.note}"` : ""}: ${w.ageSeconds}s waited, times out in ${w.leftSeconds}s`).join("\n") : "No active waits.", { decision: "list", waits: list });
      }
      if (params.action === "cancel") {
        const id = typeof params.id === "string" ? params.id : "";
        if (!slot?.rt.cancel(id)) return refuse(`${WAIT_TOOL}: no active wait '${oneLine(id, 40)}'.`);
        s.onCancel?.(id);
        return text(`Wait ${id} cancelled.`, { decision: "cancelled", id });
      }
      if (params.action !== "start") return refuse(`${WAIT_TOOL}: action must be start, list or cancel.`);
      const l = limits();
      const spec = parseStart(params, l, { cwd: ctx.cwd, home: deps.home, agentDir: s.agentDir, platform: deps.platform, roots: s.roots, owned: s.owned?.(), ownTasks: s.ownTasks?.(ctx.cwd) });
      if ("error" in spec) return refuse(spec.error, params.kind);
      const r = ensure().start(spec);
      if ("error" in r) return text(r.error, { decision: "refused" }, true);
      if ("deduped" in r) return text(spec.kind === "child" ? `Wait ${r.id} (child) already waits on child ${spec.label}; no second wait started, and the first wait's note stays. End your turn: you will be woken by one message.` : `Wait ${r.id} (${spec.kind}) already watches this pid; no second wait started. End your turn: you will be woken by one message.`, { decision: "start", id: r.id, kind: spec.kind, deduped: true });
      s.onStart?.(spec, r.id);
      const win = l.batchWindowSeconds;
      return text(`Wait ${r.id} (${spec.kind}) started; times out after ${l.maxSeconds}s. End your turn: you will be woken by one message${win > 0 ? ` (outcomes within ${win}s are batched)` : ""}.`, { decision: "start", id: r.id, kind: spec.kind });
    },
  } as never;
  pi.registerTool(waitTool);
  return handle;
}
