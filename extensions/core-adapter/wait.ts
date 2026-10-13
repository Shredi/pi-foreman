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
// inside the workspace the overlay's write protection set refuses it too. Owned dirs (owned.ts readWrite:
// the handoff dirs, subagent-artifacts, the round worktree dir) are accepted when the caller passes them.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRulingName, rulingFresh } from "./ruling.ts";
import { BG_PARAMS, BG_TOOL, ADDON_REFUSAL, addonPresent, bgLogPath, spawnDetached } from "./bg.ts";
import { get } from "./config.ts";
import { underOwned } from "./owned.ts";
import { isProtectedPath } from "./permoverlay.ts";
import type { OverlayRules } from "./permoverlay.ts";
import { resolveToolPath } from "./payload.ts";
import { workspaceOf } from "./python.ts";
import { realDeep, under } from "./triage.ts";
import { pressureOutcome } from "./pressure.ts";
import { WAKE_MESSAGE_TYPE } from "./usage.ts";

export const WAIT_TOOL = "foreman_wait";
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
  /** Overlay rules (write protection); null = baseline unreadable, workspace paths are refused. */
  overlay: OverlayRules | null;
  /** ownedRoots(...).readWrite: a file wait may also watch a path under these (default: none). */
  owned?: string[];
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
    if (!o.overlay) return { error: `pi-foreman: ${WAIT_TOOL} on '${shown}' refused: the permission baseline is unreadable, so the write protection cannot be checked. Run /foreman doctor.` };
    const ctx = { cwd: o.cwd, home: o.home, platform: o.platform };
    if (isProtectedPath(o.overlay, abs, ctx) || isProtectedPath(o.overlay, real, ctx)) {
      return { error: `pi-foreman: ${WAIT_TOOL} on '${shown}' refused: the path is under the write protection (git internals, agent or harness configuration).` };
    }
    return { path: abs };
  }
  return { error: `pi-foreman: ${WAIT_TOOL} on '${shown}' refused: a file wait must resolve (symlinks followed) inside the workspace, its .workflow/ or <agentDir>/pi-foreman/state/wait/.` };
}

/**
 * The optional `log` of a pid or ci wait (shown by `/foreman waits`, its last lines): a path the file wait bound accepts,
 * or one under `<agentDir>/pi-foreman/state/scratch/` (where foreman_bg writes). Absent or empty = none.
 */
export function checkLogPath(raw: unknown, o: PathBoundOpts): { log?: string } | { error: string } {
  if (raw === undefined || raw === null || raw === "") return {};
  const abs = resolveToolPath(raw, o.cwd, o.home);
  if (!abs) return { error: `${WAIT_TOOL}: log must be a path.` };
  const real = realDeep(abs);
  const roots = [path.resolve(path.join(o.agentDir, "pi-foreman", "state", "scratch")), realDeep(path.resolve(path.join(o.agentDir, "pi-foreman", "state", "scratch")))];
  if (roots.some((r) => under(r, abs, o.platform)) && roots.some((r) => under(r, real, o.platform))) return { log: abs };
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
 * Batches resolved triggers into one wake (item 14). The first outcome opens the window; the
 * wake goes out when it closes or as soon as no wait is active. Later outcomes open a new one.
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
    const ms = this.d.windowMs();
    if (ms <= 0) return this.flush();
    this.timer = this.d.timers.set(() => this.flush(), ms);
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
  /** A file wait on a ruling file woke (the harness writes `.seen`; ask contract). */
  onRulingWake?: (file: string) => void;
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

  /** The id the next `start` will use (foreman_bg names its log with it before it spawns). */
  nextId(): string {
    return `w${this.seq + 1}`;
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
            if (isRulingName(path.basename(spec.path))) this.d.onRulingWake?.(spec.path);
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
    const e = this.drop(id);
    if (!e) return;
    this.d.trace({ event: "wait", decision: "resolved", toolFamily: e.kind });
    this.governor.resolved({ id: e.id, kind: e.kind, note: e.note, outcome: e.log ? `${outcome}; log ${e.log}` : outcome });
  }

  cancel(id: string): boolean {
    const e = this.drop(id);
    if (!e) return false;
    this.d.trace({ event: "wait", decision: "cancelled", toolFamily: e.kind });
    this.governor.check();
    return true;
  }

  /**
   * A plan, result, update or closed notice of the registry child `label`: resolves the first child wait
   * naming that label (else the first naming `any`). A notice before the wait starts is not replayed.
   */
  childNotice(label: string, kind: string, notePath: string): boolean {
    const waits = [...this.waits.values()].filter((e) => e.kind === "child");
    const hit = waits.find((e) => e.label === label) ?? waits.find((e) => e.label === "any");
    if (!hit) return false;
    this.resolve(hit.id, `child ${label}: ${kind} ${oneLine(notePath, 300)}`);
    return true;
  }

  /** Cancels every active wait (a close of the session); the cancelled ids. */
  cancelAll(): string[] {
    return [...this.waits.keys()].filter((id) => this.cancel(id));
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

/**
 * Absolute path of `name` from PATH entries that are absolute and outside the workspace (S8): an empty,
 * `.` or relative entry, or one inside the workspace, is skipped, so a planted binary is never run.
 */
export function resolveBin(name: string, workspace: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, pathExt?: string): string | null {
  const win = platform === "win32";
  const pathVar = (win ? Object.entries(env).find(([k]) => k.toLowerCase() === "path")?.[1] : env.PATH) ?? "";
  const exts = win ? (pathExt ?? (env.PATHEXT || ".COM;.EXE")).split(";").filter(Boolean) : [""];
  const ws = realDeep(workspace);
  for (const entry of pathVar.split(win ? ";" : ":")) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || dir === "." || !path.isAbsolute(dir)) continue;
    if (under(ws, realDeep(dir), platform)) continue;
    for (const ext of exts) {
      const cand = path.join(dir, `${name}${ext}`);
      try {
        if (fs.statSync(cand).isFile()) return cand;
      } catch {
        // next candidate
      }
    }
  }
  return null;
}

export const resolveGh = (workspace: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | null => resolveBin("gh", workspace, env, platform);

/** `gh run view <id> --json status,conclusion,url` (no shell; gh resolved by resolveGh, cwd = workspace). */
export function ghRunView(runId: string, cwd: string): Promise<CiStatus> {
  return new Promise((resolve, reject) => {
    const gh = resolveGh(cwd);
    if (!gh) return reject(new Error(GH_MISSING));
    execFile(gh, ["run", "view", runId, "--json", "status,conclusion,url"], { cwd, timeout: CI_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || "").trim() || err.message));
      try {
        const j = JSON.parse(String(stdout)) as Record<string, unknown>;
        resolve({ status: String(j.status ?? ""), conclusion: String(j.conclusion ?? ""), url: String(j.url ?? "") });
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
  overlay: OverlayRules | null;
  /** The merged config (read at each use, so a reload applies). */
  config: () => unknown;
  trace: (rec: Record<string, unknown>) => void;
  /** ownedRoots(...).readWrite, read at each use (the foreman only). */
  owned?: () => string[];
  /** Called with a started wait's spec (the finish gate's waiting_for_parent state). */
  onStart?: (spec: ValidSpec, id: string) => void;
  /** Called after a wait was cancelled (the finish gate may leave waiting_for_parent). */
  onCancel?: (id: string) => void;
  /** Called when a file wait on a ruling file woke (the harness writes `.seen`; askcontract.ts). */
  onRulingWake?: (file: string) => void;
  /** Appends a pending steer.md (steer.ts) to a wake message text. */
  steer?: (text: string) => string;
  /** The current pressure level and reasons (pressure waits). */
  pressure?: () => { level: string; reasons: string[] };
  /** True when no child run is active (pressure queue waits). */
  idle?: () => boolean;
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
    label: { type: "string", description: "child: the label of a session opened by `foreman session open`, or any; resolves on its next plan, result, update or closed notice (a notice that came before the wait started is not replayed)." },
    note: { type: "string", maxLength: NOTE_MAX, description: "start: shown back in the wake message." },
    log: { type: "string", description: "start, pid or ci: a log file shown by `/foreman waits` (last 5 lines) and named in the wake message." },
    id: { type: "string", description: "cancel: the wait id." },
  },
  required: ["action"],
  additionalProperties: false,
};

/** Register `foreman_wait` (foreman sessions only) and its shutdown cleanup. */
export function registerWait(pi: ExtensionAPI, deps: { session: (ctx: ExtensionContext) => Promise<WaitSession>; home: string; platform: string }): { active: (sessionId: string) => ReturnType<WaitRuntime["list"]>; childNotice: (sessionId: string, label: string, kind: string, notePath: string) => boolean; cancelAll: (sessionId: string) => string[]; onChange: (sessionId: string, cb: () => void) => () => void; startPressure: (ctx: ExtensionContext, spec: Extract<ValidSpec, { kind: "pressure" }>) => Promise<{ id: string } | { error: string }> } {
  const runtimes = new Map<string, { rt: WaitRuntime; ctx: ExtensionContext }>();
  const listeners = new Map<string, Set<() => void>>();
  const handle = {
    onChange: (sessionId: string, cb: () => void) => {
      const set = listeners.get(sessionId) ?? new Set<() => void>();
      listeners.set(sessionId, set);
      set.add(cb);
      return () => void set.delete(cb);
    },
    active: (sessionId: string) => runtimes.get(sessionId)?.rt.list() ?? [],
    childNotice: (sessionId: string, label: string, kind: string, notePath: string) => runtimes.get(sessionId)?.rt.childNotice(label, kind, notePath) ?? false,
    cancelAll: (sessionId: string) => runtimes.get(sessionId)?.rt.cancelAll() ?? [],
    startPressure: async (_ctx: ExtensionContext, _spec: Extract<ValidSpec, { kind: "pressure" }>): Promise<{ id: string } | { error: string }> => ({ error: "pressure waits are for the foreman only" }),
  };
  pi.on("session_shutdown", async (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    runtimes.get(id)?.rt.dispose();
    runtimes.delete(id);
    listeners.delete(id);
  });
  if (process.env.PI_SUBAGENT_CHILD === "1") return handle;
  const limitsOf = (s: WaitSession) => () => waitLimits((k) => get(s.config(), `wait.${k}`));
  /** The session's runtime, created with its first wait; foreman_wait and foreman_bg share it. */
  const ensureRuntime = (s: WaitSession, ctx: ExtensionContext): WaitRuntime => {
    const have = runtimes.get(s.id);
    if (have) {
      have.ctx = ctx;
      return have.rt;
    }
    const holder = { ctx } as { rt: WaitRuntime; ctx: ExtensionContext };
    holder.rt = new WaitRuntime({
      timers: realTimers,
      now: () => Date.now(),
      limits: limitsOf(s),
      stat: fileSize,
      mtime: fileMtime,
      onRulingWake: (file) => s.onRulingWake?.(file),
      alive: processAlive,
      gh: (runId) => ghRunView(runId, workspaceOf(s.cwd).root),
      ghRefusal: () => (resolveGh(workspaceOf(s.cwd).root) ? null : `ci waits are refused: ${GH_MISSING}`),
      trace: s.trace,
      pressure: s.pressure,
      idle: s.idle,
      changed: () => {
        for (const cb of [...(listeners.get(s.id) ?? [])]) cb();
      },
      wake: (outcomes) => {
        let idle = true;
        try {
          idle = holder.ctx.isIdle();
        } catch {
          // a stale context: treat as idle
        }
        const msg = wakeMessage(outcomes);
        if (s.steer) msg.content = s.steer(msg.content);
        pi.sendMessage(msg, idle ? { triggerTurn: true } : { deliverAs: "followUp" });
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
  const waitTool = {
    name: WAIT_TOOL,
    label: "Long wait",
    description:
      "Wait without model turns for a timer, a file to appear, a process to exit, a GitHub Actions run to complete or a child session to report (kind child + label). Returns at once with a wait id; you are woken later by ONE message listing every outcome (triggers that resolve close together are batched). action start (kind + its argument, optional note), list, or cancel {id}.",
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
      const spec = parseStart(params, l, { cwd: ctx.cwd, home: deps.home, agentDir: s.agentDir, platform: deps.platform, overlay: s.overlay, owned: s.owned?.() });
      if ("error" in spec) return refuse(spec.error, params.kind);
      const r = ensure().start(spec);
      if ("error" in r) return text(r.error, { decision: "refused" }, true);
      if ("deduped" in r) return text(`Wait ${r.id} (${spec.kind}) already watches this pid; no second wait started. End your turn: you will be woken by one message.`, { decision: "start", id: r.id, kind: spec.kind, deduped: true });
      s.onStart?.(spec, r.id);
      const win = l.batchWindowSeconds;
      return text(`Wait ${r.id} (${spec.kind}) started; times out after ${l.maxSeconds}s. End your turn: you will be woken by one message${win > 0 ? ` (outcomes within ${win}s are batched)` : ""}.`, { decision: "start", id: r.id, kind: spec.kind });
    },
  } as never;
  // foreman_bg (bg.ts): the tool_call hook has already run every bash guard on `command` (index.ts); this only spawns.
  pi.registerTool({
    name: BG_TOOL,
    label: "Background run",
    description:
      "Run one shell command detached (own process group; stdout and stderr go to a log file under the pi-foreman state scratch dir) and wait for it without model turns: registers a pid wait, returns the wait id and the log path at once, and you are woken when the process has exited. The command is guarded exactly like a bash call. Parameters: command, note (shown in the sidebar and `/foreman waits`).",
    parameters: BG_PARAMS as never,
    async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const s = await deps.session(ctx);
      const text = (t: string, details: Record<string, unknown>, isError = false) => ({ content: [{ type: "text" as const, text: t }], details, ...(isError ? { isError: true } : {}) });
      const refuse = (t: string) => {
        s.trace({ event: "wait", decision: "refused", toolFamily: "pid" });
        return text(t, { decision: "refused" }, true);
      };
      if (s.isChild) return refuse(`${BG_TOOL} is for the foreman only.`);
      if (ctx.mode === "print" || ctx.mode === "json") return refuse(`${BG_TOOL}: a long wait needs a TUI or RPC session.`);
      const command = typeof params.command === "string" ? params.command : "";
      if (!command.trim()) return refuse(`${BG_TOOL}: command must be a non-empty string.`);
      let tools: string[] = [];
      try {
        tools = pi.getAllTools().map((t) => t.name);
      } catch {
        // no tool list: fall back to the package directory check
      }
      if (addonPresent(tools, { agentDir: s.agentDir, cwd: ctx.cwd })) return refuse(ADDON_REFUSAL);
      const rt = ensureRuntime(s, ctx);
      const full = rt.capacityError();
      if (full) return refuse(full);
      const id = rt.nextId();
      const note = oneLine(params.note, NOTE_MAX) || oneLine(command, 60);
      const log = bgLogPath(path.join(s.agentDir, "pi-foreman", "state"), s.id, id);
      const run = spawnDetached(command, ctx.cwd, log, deps.platform);
      if ("error" in run) return refuse(run.error);
      const spec: ValidSpec = { kind: "pid", pid: run.pid, note, log };
      const r = rt.start(spec);
      if ("error" in r) {
        try {
          process.kill(deps.platform === "win32" ? run.pid : -run.pid, "SIGKILL");
        } catch {
          // already gone
        }
        return text(r.error, { decision: "refused" }, true);
      }
      s.onStart?.(spec, r.id);
      return text(`Background run ${r.id} (pid ${run.pid}) started; log ${log}. End your turn: you will be woken by one message when it has exited (exit code not knowable; read the log).`, { decision: "start", id: r.id, kind: "pid", pid: run.pid, log });
    },
  } as never);
  // foreman_wait stays the last tool this module registers (a host that keeps only the last one keeps the long-standing tool).
  pi.registerTool(waitTool);
  return handle;
}
