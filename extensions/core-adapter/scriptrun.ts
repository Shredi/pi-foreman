// Runner of an owner-approved script. Only the harness spawns it: the approved BYTES go to a new file created exclusively
// (mode 0700) in a new private temp dir, that file runs under POSIX sh with a fixed argv and environment, and file and dir are
// removed in every outcome. The path in the scratch dir is never executed. Nothing here inspects the script's text.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getShellConfig as piGetShellConfig } from "@earendil-works/pi-coding-agent";
import { bgSpawnFlags } from "./bg.ts";
import type { ShellConfigFn } from "./bg.ts";
import { stripChildIntercomEnv } from "./childenv.ts";
import { msysEnv } from "./env.ts";
import { killGroup } from "./extstatus.ts";
import { redactCommand } from "./trace.ts";

export type ScriptRunKind = "dry" | "run";

export const SCRIPT_TIMEOUT_DEFAULT_S = 600;
export const SCRIPT_TIMEOUT_MAX_S = 3600;
export const SCRIPT_TAIL_LINES = 40;
export const SCRIPT_TAIL_BYTES = 4 * 1024;
export const SCRIPT_DRY_ARG = "--dry-run";

/** `<scratch root>/script-<name>-<hash8>-<dry|run>-<n>.log`; the name keeps letters, digits, `.`, `_`, `-`. */
export function scriptLogPath(scratchRoot: string, name: string, hash: string, kind: ScriptRunKind, n: number): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "script";
  return path.join(scratchRoot, `script-${safe}-${hash.slice(0, 8)}-${kind}-${n}.log`);
}

/** scriptLogPath with the first `n` from `from` on that names no existing file, so no run writes into an earlier log. */
export function freshScriptLogPath(scratchRoot: string, name: string, hash: string, kind: ScriptRunKind, from: number = 1): string {
  let n = Math.max(1, Math.floor(from));
  while (n < from + 10_000 && fs.existsSync(scriptLogPath(scratchRoot, name, hash, kind, n))) n++;
  return scriptLogPath(scratchRoot, name, hash, kind, n);
}

/** The time limit in seconds: default 600, at most 3600. */
export function scriptTimeoutSeconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(value, SCRIPT_TIMEOUT_MAX_S) : SCRIPT_TIMEOUT_DEFAULT_S;
}

/** The POSIX shell that runs the run file: `/bin/sh`; on win32 Git Bash (Pi's shell config), never cmd.exe. Null when there is none. */
export function scriptShell(platform: string = process.platform, opts: { getShellConfig?: ShellConfigFn; shellPath?: string } = {}): string | null {
  if (platform !== "win32") return "/bin/sh";
  try {
    const cfg = (opts.getShellConfig ?? piGetShellConfig)(opts.shellPath || undefined);
    if (cfg.commandTransport === "stdin") return null;
    return path.win32.isAbsolute(cfg.shell) && /(^|[\\/])(bash|sh)(\.exe)?$/i.test(cfg.shell) ? cfg.shell : null;
  } catch {
    return null;
  }
}

/** The fixed argv after the shell: the run file, plus `--dry-run` on a dry run only. */
export function scriptArgv(file: string, kind: ScriptRunKind): string[] {
  return kind === "dry" ? [file, SCRIPT_DRY_ARG] : [file];
}

/** The environment of a run: `env` without the intercom identity, with the MSYS switches on win32; DRY_RUN=1 on a dry run, no DRY_RUN on a real run. */
export function scriptEnv(env: NodeJS.ProcessEnv, kind: ScriptRunKind, platform: string = process.platform, config?: unknown): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, ...msysEnv(platform, config) };
  stripChildIntercomEnv(out);
  for (const k of Object.keys(out)) if ((platform === "win32" ? k.toUpperCase() : k) === "DRY_RUN") delete out[k];
  if (kind === "dry") out.DRY_RUN = "1";
  return out;
}

/** The last lines of a log (at most 40 lines and 4 KiB), secrets redacted as in the trace. The log file itself stays as written. */
export function scriptLogTail(logPath: string): string {
  try {
    const fd = fs.openSync(logPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, SCRIPT_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      let lines = buf.toString("utf8").replace(/\r?\n$/, "").split(/\r?\n/);
      if (size > len && lines.length > 1) lines = lines.slice(1); // the first line is cut
      return redactCommand(lines.slice(-SCRIPT_TAIL_LINES).join("\n"));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

export interface ScriptRunInput {
  /** The bytes that run (approved, or an allowed fix of them). */
  bytes: Buffer;
  kind: ScriptRunKind;
  /** Workspace root. */
  cwd: string;
  logPath: string;
  /** Default 600, at most 3600. */
  timeoutSeconds?: number;
  signal?: AbortSignal;
  platform?: string;
  env?: NodeJS.ProcessEnv;
  /** The config object for `msysEnv`. */
  config?: unknown;
  getShellConfig?: ShellConfigFn;
  shellPath?: string;
  /** Parent of the private run dir (default: the OS temp dir). */
  tmpDir?: string;
}

export interface ScriptRunResult {
  kind: ScriptRunKind;
  exitCode: number | null;
  signal: string | null;
  seconds: number;
  /** The time limit was hit and the process group killed. */
  timedOut: boolean;
  aborted: boolean;
  logPath: string;
  /** Last lines of the log, redacted. */
  tail: string;
  /** Set when the shell could not be started. */
  error?: string;
}

export interface ScriptRunRefusal {
  code: "no_posix_shell";
  error: string;
}

/** Run `bytes` once and wait for its exit. Never rejects. */
export async function runScript(input: ScriptRunInput): Promise<ScriptRunResult | ScriptRunRefusal> {
  const platform = input.platform ?? process.platform;
  const shell = scriptShell(platform, input);
  if (!shell) return { code: "no_posix_shell", error: "pi-foreman: foreman_script refused (no_posix_shell): no POSIX shell found (on Windows the script runs in Git Bash; cmd.exe is never used). Install Git for Windows or set Pi's shellPath." };
  const started = Date.now();
  const done = (r: Partial<ScriptRunResult>): ScriptRunResult => ({ kind: input.kind, exitCode: null, signal: null, seconds: Math.round((Date.now() - started) / 100) / 10, timedOut: false, aborted: false, logPath: input.logPath, tail: scriptLogTail(input.logPath), ...r });
  // aborted before the start: nothing spawns, no run file, no log
  if (input.signal?.aborted) return done({ aborted: true, tail: "" });
  let dir: string | null = null;
  let logFd: number | null = null;
  try {
    dir = fs.mkdtempSync(path.join(input.tmpDir ?? os.tmpdir(), "pi-foreman-script-"));
    const file = path.join(dir, "run.sh");
    const fd = fs.openSync(file, "wx", 0o700);
    try {
      fs.writeFileSync(fd, input.bytes);
    } finally {
      fs.closeSync(fd);
    }
    fs.mkdirSync(path.dirname(input.logPath), { recursive: true, mode: 0o700 });
    // "wx": a log is new per run (freshScriptLogPath); on win32 it also grants the write access the MSYS runtime needs (bg.ts)
    logFd = fs.openSync(input.logPath, "wx", 0o600);
    const arg = platform === "win32" ? file.split("\\").join("/") : file;
    const child = spawn(shell, scriptArgv(arg, input.kind), { cwd: input.cwd, ...bgSpawnFlags(platform), stdio: ["ignore", logFd, logFd], env: scriptEnv(input.env ?? process.env, input.kind, platform, input.config) });
    const end = await new Promise<Partial<ScriptRunResult>>((resolve) => {
      let timedOut = false;
      let aborted = false;
      const kill = (): void => killGroup(child.pid, platform);
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, scriptTimeoutSeconds(input.timeoutSeconds) * 1000);
      const onAbort = (): void => {
        aborted = true;
        kill();
      };
      const finish = (r: Partial<ScriptRunResult>): void => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        // POSIX: what the script left in its process group ends with it; win32: the tree kill needs a live root, so nothing after a normal exit
        if (platform !== "win32") kill();
        resolve({ ...r, timedOut, aborted });
      };
      child.on("error", (err) => finish({ error: `could not start ${shell}: ${err.message}` }));
      child.on("exit", (code, sig) => finish({ exitCode: code, signal: sig }));
      if (input.signal?.aborted) onAbort();
      else input.signal?.addEventListener("abort", onAbort, { once: true });
    });
    return done(end);
  } catch (err) {
    return done({ error: `could not run the script: ${(err as Error).message}` });
  } finally {
    if (logFd !== null) {
      try {
        fs.closeSync(logFd);
      } catch {
        // already closed
      }
    }
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // left for the OS temp cleanup
      }
    }
  }
}
