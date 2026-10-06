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
// inside the workspace the overlay's write protection set refuses it too.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { get } from "./config.ts";
import { isProtectedPath } from "./permoverlay.ts";
import type { OverlayRules } from "./permoverlay.ts";
import { resolveToolPath } from "./payload.ts";
import { workspaceOf } from "./python.ts";
import { realDeep, under } from "./triage.ts";
import { WAKE_MESSAGE_TYPE } from "./usage.ts";

export const WAIT_TOOL = "foreman_wait";
export const WAIT_KINDS = ["timer", "file", "pid", "ci"] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];
export const RUN_ID = /^\d{1,20}$/;
export const NOTE_MAX = 200;
export const POLL_MS: Record<WaitKind, number> = { timer: 0, file: 2000, pid: 2000, ci: 60_000 };
export const CI_TIMEOUT_MS = 30_000;
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
  | { kind: "pid"; pid: number; note: string }
  | { kind: "ci"; runId: string; note: string };

export interface PathBoundOpts {
  cwd: string;
  home: string;
  agentDir: string;
  platform: string;
  /** Overlay rules (write protection); null = baseline unreadable, workspace paths are refused. */
  overlay: OverlayRules | null;
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
      return { kind: "pid", pid: p, note };
    }
    case "ci": {
      if (!limits.ci) return { error: `${WAIT_TOOL}: ci waits are off (wait.ci is false).` };
      const r = checkRunId(params.runId);
      return "error" in r ? r : { kind: "ci", runId: r.runId, note };
    }
    default:
      return { error: `${WAIT_TOOL}: kind must be timer, file, pid or ci.` };
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
  wake: (outcomes: Outcome[]) => void;
  trace: (rec: Record<string, unknown>) => void;
}

interface Entry {
  id: string;
  kind: WaitKind;
  note: string;
  started: number;
  deadline: number;
  handles: unknown[];
  ghErrors: number;
  ghFirstError: string;
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

  start(spec: ValidSpec): { id: string } | { error: string } {
    const limits = this.d.limits();
    if (this.waits.size >= limits.maxActive) {
      this.d.trace({ event: "wait", decision: "refused", toolFamily: spec.kind });
      return { error: `${WAIT_TOOL}: ${this.waits.size} waits are active (wait.maxActive ${limits.maxActive}); cancel one first.` };
    }
    const id = `w${++this.seq}`;
    const now = this.d.now();
    const e: Entry = { id, kind: spec.kind, note: spec.note, started: now, deadline: now + limits.maxSeconds * 1000, handles: [], ghErrors: 0, ghFirstError: "" };
    this.waits.set(id, e);
    e.handles.push(this.d.timers.set(() => this.resolve(id, "timeout"), limits.maxSeconds * 1000));
    if (spec.kind === "timer") e.handles.push(this.d.timers.set(() => this.resolve(id, "elapsed"), spec.seconds * 1000));
    else this.poll(e, spec, 0);
    this.d.trace({ event: "wait", decision: "start", toolFamily: spec.kind });
    return { id };
  }

  private poll(e: Entry, spec: ValidSpec, delay: number): void {
    e.handles.push(
      this.d.timers.set(() => {
        if (!this.waits.has(e.id)) return;
        if (spec.kind === "file") {
          const size = this.d.stat(spec.path);
          if (size !== null) return this.resolve(e.id, `exists, ${size} bytes`);
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
      }, delay),
    );
  }

  private drop(id: string): Entry | undefined {
    const e = this.waits.get(id);
    if (!e) return undefined;
    for (const h of e.handles) this.d.timers.clear(h);
    this.waits.delete(id);
    return e;
  }

  resolve(id: string, outcome: string): void {
    if (this.disposed) return;
    const e = this.drop(id);
    if (!e) return;
    this.d.trace({ event: "wait", decision: "resolved", toolFamily: e.kind });
    this.governor.resolved({ id: e.id, kind: e.kind, note: e.note, outcome });
  }

  cancel(id: string): boolean {
    const e = this.drop(id);
    if (!e) return false;
    this.d.trace({ event: "wait", decision: "cancelled", toolFamily: e.kind });
    this.governor.check();
    return true;
  }

  list(): { id: string; kind: WaitKind; note: string; ageSeconds: number; leftSeconds: number }[] {
    const now = this.d.now();
    return [...this.waits.values()].map((e) => ({ id: e.id, kind: e.kind, note: e.note, ageSeconds: Math.round((now - e.started) / 1000), leftSeconds: Math.max(0, Math.round((e.deadline - now) / 1000)) }));
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

/** `gh run view <id> --json status,conclusion,url` (no shell). */
export function ghRunView(runId: string, cwd: string): Promise<CiStatus> {
  return new Promise((resolve, reject) => {
    execFile("gh", ["run", "view", runId, "--json", "status,conclusion,url"], { cwd, timeout: CI_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
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
}

const PARAMS = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["start", "list", "cancel"] },
    kind: { type: "string", enum: [...WAIT_KINDS], description: "start: what to wait for." },
    seconds: { type: "integer", minimum: 1, description: "timer: seconds to wait." },
    path: { type: "string", description: "file: resolves when this file exists (inside the workspace, its .workflow/ or <agentDir>/pi-foreman/state/wait/)." },
    pid: { type: "integer", minimum: 2, description: "pid: resolves when this process has exited." },
    runId: { type: "string", description: "ci: GitHub Actions run id (digits); resolves when the run completes." },
    note: { type: "string", maxLength: NOTE_MAX, description: "start: shown back in the wake message." },
    id: { type: "string", description: "cancel: the wait id." },
  },
  required: ["action"],
  additionalProperties: false,
};

/** Register `foreman_wait` (foreman sessions only) and its shutdown cleanup. */
export function registerWait(pi: ExtensionAPI, deps: { session: (ctx: ExtensionContext) => Promise<WaitSession>; home: string; platform: string }): void {
  const runtimes = new Map<string, { rt: WaitRuntime; ctx: ExtensionContext }>();
  pi.on("session_shutdown", async (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    runtimes.get(id)?.rt.dispose();
    runtimes.delete(id);
  });
  if (process.env.PI_SUBAGENT_CHILD === "1") return;
  pi.registerTool({
    name: WAIT_TOOL,
    label: "Long wait",
    description:
      "Wait without model turns for a timer, a file to appear, a process to exit or a GitHub Actions run to complete. Returns at once with a wait id; you are woken later by ONE message listing every outcome (triggers that resolve close together are batched). action start (kind + its argument, optional note), list, or cancel {id}.",
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
      const limits = () => waitLimits((k) => get(s.config(), `wait.${k}`));
      let slot = runtimes.get(s.id);
      if (slot) slot.ctx = ctx;
      const ensure = (): WaitRuntime => {
        if (slot) return slot.rt;
        const holder = { ctx } as { rt: WaitRuntime; ctx: ExtensionContext };
        holder.rt = new WaitRuntime({
          timers: realTimers,
          now: () => Date.now(),
          limits,
          stat: fileSize,
          alive: processAlive,
          gh: (runId) => ghRunView(runId, workspaceOf(s.cwd).root),
          trace: s.trace,
          wake: (outcomes) => {
            let idle = true;
            try {
              idle = holder.ctx.isIdle();
            } catch {
              // a stale context: treat as idle
            }
            pi.sendMessage(wakeMessage(outcomes), idle ? { triggerTurn: true } : { deliverAs: "followUp" });
          },
        });
        runtimes.set(s.id, holder);
        slot = holder;
        return holder.rt;
      };
      if (params.action === "list") {
        const list = slot?.rt.list() ?? [];
        return text(list.length ? list.map((w) => `${w.id} ${w.kind}${w.note ? ` "${w.note}"` : ""}: ${w.ageSeconds}s waited, times out in ${w.leftSeconds}s`).join("\n") : "No active waits.", { decision: "list", waits: list });
      }
      if (params.action === "cancel") {
        const id = typeof params.id === "string" ? params.id : "";
        if (!slot?.rt.cancel(id)) return refuse(`${WAIT_TOOL}: no active wait '${oneLine(id, 40)}'.`);
        return text(`Wait ${id} cancelled.`, { decision: "cancelled", id });
      }
      if (params.action !== "start") return refuse(`${WAIT_TOOL}: action must be start, list or cancel.`);
      const l = limits();
      const spec = parseStart(params, l, { cwd: ctx.cwd, home: deps.home, agentDir: s.agentDir, platform: deps.platform, overlay: s.overlay });
      if ("error" in spec) return refuse(spec.error, params.kind);
      const r = ensure().start(spec);
      if ("error" in r) return text(r.error, { decision: "refused" }, true);
      const win = l.batchWindowSeconds;
      return text(`Wait ${r.id} (${spec.kind}) started; times out after ${l.maxSeconds}s. End your turn: you will be woken by one message${win > 0 ? ` (outcomes within ${win}s are batched)` : ""}.`, { decision: "start", id: r.id, kind: spec.kind });
    },
  } as never);
}
