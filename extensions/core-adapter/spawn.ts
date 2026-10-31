// Process spawning with a hard timeout. No shell, hidden window on Windows.
import { spawn } from "node:child_process";

export interface SpawnOptions {
  input?: string;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
  /** Aborting kills the child (SIGTERM, SIGKILL after 2 s) and resolves once it has closed. */
  signal?: AbortSignal;
}

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started (ENOENT, EACCES, bad cwd). */
  error?: Error;
  timedOut: boolean;
}

export type Spawner = (command: string, args: string[], options: SpawnOptions) => Promise<SpawnResult>;

const MAX_OUTPUT = 1024 * 1024;
const ABORT_KILL_GRACE_MS = 2000;

export const defaultSpawner: Spawner = (command, args, options) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: SpawnResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let aborted = false;
    const abortError = (): Error => new Error("aborted");
    const onAbort = (): void => {
      if (aborted || settled) return;
      aborted = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // already gone
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        finish({ code: null, stdout, stderr, error: abortError(), timedOut });
      }, ABORT_KILL_GRACE_MS);
    };
    if (options.signal?.aborted) {
      resolve({ code: null, stdout: "", stderr: "", error: abortError(), timedOut: false });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", error: error as Error, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // already gone
      }
      finish({ code: null, stdout, stderr, timedOut: true });
    }, options.timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
    });
    child.on("error", (error) => finish({ code: null, stdout, stderr, error, timedOut }));
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut, ...(aborted ? { error: abortError() } : {}) }));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdin?.on("error", () => {
      // EPIPE when the child exits before reading stdin; the exit code tells the story.
    });
    child.stdin?.end(options.input ?? "");
  });
