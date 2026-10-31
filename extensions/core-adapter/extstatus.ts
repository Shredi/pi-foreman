// External status hook for the Herdr sidebar (docs/herdr.md#external-status): `sidebar.statusCommand`
// (user or overlay config only) runs every `sidebar.statusSeconds`; its stdout is a JSON list of
// {label, state} items shown as extra dots. The program, its output and its stderr are untrusted: the
// program must lie outside the workspace, runs without a shell in its own process group under a 10 s
// timeout, and the items are display data only (never sent to the model, never a message, no URL kept).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DotState } from "./prdots.ts";
import { realTimers } from "./prwatch.ts";
import type { Timers } from "./prwatch.ts";
import { redactCommand } from "./trace.ts";
import { realDeep, under } from "./triage.ts";
import { resolveBin } from "./wait.ts";

export const STATUS_TIMEOUT_MS = 10_000;
export const MAX_STDOUT = 16 * 1024;
export const MAX_STDERR = 4 * 1024;
export const MAX_ITEMS = 8;
export const MAX_LABEL = 20;
const STATES: readonly DotState[] = ["fail", "run", "ok", "none"];

export interface StatusItem {
  label: string;
  state: DotState;
}
export type StatusOutcome = "ok" | "bad_output" | "failed" | "timeout" | "program_missing";

/** Words of a command line as a POSIX shell reads quotes and backslashes (no expansion of any kind); null on an open quote or an empty line. */
export function splitCommandLine(line: string): string[] | null {
  const out: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return null;
      cur = (cur ?? "") + line.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      let body = "";
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === "\\" && j + 1 < line.length && '"\\$`'.includes(line[j + 1])) j++;
        body += line[j];
      }
      if (j >= line.length) return null;
      cur = (cur ?? "") + body;
      i = j;
    } else if (c === "\\") {
      if (i + 1 >= line.length) return null;
      cur = (cur ?? "") + line[++i];
    } else if (c === " " || c === "\t" || c === "\n") {
      if (cur !== null) out.push(cur);
      cur = null;
    } else cur = (cur ?? "") + c;
  }
  if (cur !== null) out.push(cur);
  return out.length > 0 ? out : null;
}

export interface ResolveInput {
  workspace: string;
  env: NodeJS.ProcessEnv;
  platform: string;
}

/**
 * The program to run, or null (program_missing). A first word without a path separator is looked up on PATH
 * (PATHEXT on Windows); one with a separator must be absolute. The real path (symlinks resolved) must lie outside
 * the workspace's real path; `.cmd` and `.bat` programs are refused.
 */
export function resolveProgram(first: string, input: ResolveInput): string | null {
  const win = input.platform === "win32";
  if (!first || first.includes("\0")) return null;
  const sep = first.includes("/") || (win && first.includes("\\"));
  let found: string | null;
  if (sep) found = path.isAbsolute(first) ? first : null;
  else found = resolveBin(first, input.workspace, input.env, input.platform, win ? input.env.PATHEXT || ".COM;.EXE" : undefined);
  if (!found) return null;
  if (/\.(cmd|bat)$/i.test(found)) return null;
  let real: string;
  try {
    if (!fs.statSync(found).isFile()) return null;
    if (!win) fs.accessSync(found, fs.constants.X_OK);
    real = fs.realpathSync.native(found);
  } catch {
    return null;
  }
  if (/\.(cmd|bat)$/i.test(real)) return null;
  if (under(realDeep(input.workspace), real, input.platform)) return null;
  return real;
}

const CONTROL = /[\p{Cc}\p{Cf}]/gu;

/** Items of an accepted stdout, or null when the whole output is rejected. */
export function parseItems(stdout: string): StatusItem[] | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(v)) return null;
  for (const e of v) if (!e || typeof e !== "object" || Array.isArray(e) || typeof (e as { label?: unknown }).label !== "string") return null;
  const out: StatusItem[] = [];
  for (const e of (v as { label: string; state?: unknown }[]).slice(0, MAX_ITEMS)) {
    const label = Array.from(redactCommand(e.label.replace(CONTROL, "")).replace(CONTROL, "").trim()).slice(0, MAX_LABEL).join("").trim();
    if (!label) continue;
    out.push({ label, state: STATES.includes(e.state as DotState) ? (e.state as DotState) : "none" });
  }
  return out;
}

export interface StatusRunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxStdout: number;
  maxStderr: number;
}
export interface StatusRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout went over the cap (the process was stopped). */
  overflow: boolean;
  timedOut: boolean;
  error?: Error;
}
export type StatusSpawner = (program: string, args: string[], options: StatusRunOptions) => Promise<StatusRunResult>;

/** Kill the process group of `pid` (POSIX kill(-pgid), Windows taskkill /T). */
export function killGroup(pid: number | undefined, platform: string = process.platform): void {
  if (!pid) return;
  try {
    if (platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
    else process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

export const defaultStatusSpawner: StatusSpawner = (program, args, o) =>
  new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const finish = (r: StatusRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const result = (code: number | null): StatusRunResult => ({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), overflow, timedOut });
    try {
      child = spawn(program, args, { cwd: o.cwd, env: o.env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", overflow: false, timedOut: false, error: error as Error });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
      finish(result(null));
    }, o.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (overflow) return;
      outLen += chunk.length;
      if (outLen > o.maxStdout) {
        overflow = true;
        killGroup(child.pid);
        finish(result(null));
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errLen >= o.maxStderr) return; // drained, not kept
      err.push(chunk.subarray(0, o.maxStderr - errLen));
      errLen += Math.min(chunk.length, o.maxStderr - errLen);
    });
    child.on("error", (error) => finish({ ...result(null), error }));
    child.on("close", (code) => finish(result(code)));
  });

export interface ExtStatusDeps {
  /** Not a child, with a live file to write to. */
  enabled(): boolean;
  /** sidebar.statusCommand ("" / null = off). */
  command(): string | null;
  /** sidebar.statusSeconds in ms. */
  intervalMs(): number;
  workspace(): string;
  cwd(): string;
  sessionId(): string;
  branch(): Promise<string>;
  env: NodeJS.ProcessEnv;
  platform: string;
  spawner?: StatusSpawner;
  timers?: Timers;
  trace(rec: Record<string, unknown>): void;
  changed?(): void;
}

export class ExtStatus {
  private readonly deps: ExtStatusDeps;
  private readonly timers: Timers;
  private readonly spawner: StatusSpawner;
  private list: StatusItem[] = [];
  private rejected = 0;
  private timer: unknown = null;
  private busy = false;
  private started = false;
  private disposed = false;

  constructor(deps: ExtStatusDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? realTimers;
    this.spawner = deps.spawner ?? defaultStatusSpawner;
  }

  /** Doctor text after `sidebar status: `. */
  describe(): string {
    const cmd = this.deps.command();
    if (!cmd) return "off";
    const first = splitCommandLine(cmd)?.[0] ?? "";
    return `on (${redactCommand(first).slice(0, 80)})`;
  }

  items(): StatusItem[] {
    return this.list;
  }

  start(): void {
    if (this.started || this.disposed || !this.deps.enabled() || !this.deps.command()) return;
    this.started = true;
    this.arm(0);
  }

  clear(): void {
    this.disposed = true;
    this.timers.clear(this.timer);
    this.timer = null;
    this.list = [];
  }

  private arm(ms: number): void {
    this.timers.clear(this.timer);
    this.timer = this.timers.set(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.busy || this.disposed || !this.deps.enabled()) return;
    this.busy = true;
    try {
      await this.runOnce();
    } catch {
      this.reject("failed");
    }
    this.busy = false;
    if (!this.disposed) this.arm(this.deps.intervalMs());
  }

  private set(items: StatusItem[]): void {
    const same = JSON.stringify(items) === JSON.stringify(this.list);
    this.list = items;
    if (!same) this.deps.changed?.();
  }

  /** A rejected run keeps the previous items for one more interval, then clears them. */
  private reject(outcome: StatusOutcome, stderr?: string): void {
    if (this.disposed) return;
    this.rejected += 1;
    const detail = stderr ? { stderr: redactCommand(stderr.split(/\r?\n/)[0].replace(CONTROL, "")).slice(0, 200) } : {};
    this.deps.trace({ event: "sidebar_status", outcome, count: this.list.length, ...detail });
    if (this.rejected >= 2) this.set([]);
  }

  private async runOnce(): Promise<void> {
    const line = this.deps.command();
    if (!line) return;
    const argv = splitCommandLine(line);
    const program = argv ? resolveProgram(argv[0], { workspace: this.deps.workspace(), env: this.deps.env, platform: this.deps.platform }) : null;
    if (!argv || !program) return this.reject("program_missing");
    const branch = await this.deps.branch();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.deps.env)) if (typeof v === "string") env[k] = v;
    env.PI_FOREMAN_SESSION_ID = this.deps.sessionId();
    env.PI_FOREMAN_BRANCH = branch;
    const r = await this.spawner(program, argv.slice(1), { cwd: this.deps.cwd(), env, timeoutMs: STATUS_TIMEOUT_MS, maxStdout: MAX_STDOUT, maxStderr: MAX_STDERR });
    if (this.disposed) return;
    if (r.timedOut) return this.reject("timeout");
    if (r.error) return this.reject("failed", r.error.message);
    if (r.overflow) return this.reject("bad_output");
    if (r.code !== 0) return this.reject("failed", r.stderr);
    const items = r.stdout.length > MAX_STDOUT ? null : parseItems(r.stdout);
    if (!items) return this.reject("bad_output");
    this.rejected = 0;
    this.deps.trace({ event: "sidebar_status", outcome: "ok", count: items.length });
    this.set(items);
  }
}
