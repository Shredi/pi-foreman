// Process spawning with a hard timeout. No shell, hidden window on Windows.
import { spawn } from "node:child_process";

export interface SpawnOptions {
  input?: string;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
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
      resolve(result);
    };
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
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut }));
    child.stdin?.on("error", () => {
      // EPIPE when the child exits before reading stdin; the exit code tells the story.
    });
    child.stdin?.end(options.input ?? "");
  });
