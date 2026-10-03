// Run one core script: `<python> -E -s <core>/scripts/<guard>.py`, hook JSON on stdin.
import * as path from "node:path";
import { asciiJson } from "./payload.ts";
import type { Spawner } from "./spawn.ts";
import type { GuardName } from "./toolmap.ts";

export const GUARD_TIMEOUT_MS = 5_000;

export type GuardRun =
  | { status: "ran"; code: number | null; stdout: string; stderr: string }
  | { status: "failed"; failure: "no-python" | "spawn" | "timeout"; detail: string };

export interface RunGuardInput {
  /** Interpreter path, or null when none was found. */
  python: string | null;
  coreDir: string;
  guard: GuardName;
  payload: unknown;
  env: Record<string, string>;
  cwd: string;
  spawner: Spawner;
  timeoutMs?: number;
}

export async function runGuard(input: RunGuardInput): Promise<GuardRun> {
  if (!input.python) return { status: "failed", failure: "no-python", detail: "no Python >= 3.9 found" };
  const script = path.join(input.coreDir, "scripts", `${input.guard}.py`);
  // -E: ignore PYTHONPATH & co. (a stray json.py must not shadow the stdlib); -s: no user site.
  const r = await input.spawner(input.python, ["-E", "-s", script], {
    input: asciiJson(input.payload),
    env: input.env,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs ?? GUARD_TIMEOUT_MS,
  });
  if (r.error) return { status: "failed", failure: "spawn", detail: r.error.message };
  if (r.timedOut) return { status: "failed", failure: "timeout", detail: `no answer within ${(input.timeoutMs ?? GUARD_TIMEOUT_MS) / 1000} s` };
  return { status: "ran", code: r.code, stdout: r.stdout, stderr: r.stderr };
}
