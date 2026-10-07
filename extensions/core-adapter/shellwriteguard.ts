// pi-foreman shell write guard (`scripts/shell_write_guard.py`, plan D3): the foreman's bash
// (and its opt-in powershell tool) may not write project files at any tier. Its edit/write tools (measured by the trivial bound)
// or a builder are the only paths; `.workflow/` stays writable. Children are not affected.
// The script lives in the package's `scripts/`, not in `core/`. Fail-closed like the git guard.
import { preToolPayload } from "./payload.ts";
import type { PayloadContext } from "./payload.ts";
import { runGuard } from "./runguard.ts";
import type { GuardRun } from "./runguard.ts";
import type { Spawner } from "./spawn.ts";
import { evaluateRun } from "./translate.ts";

export const SHELL_WRITE_REFUSAL = "shell write into project files refused: use the edit/write tools (measured by the trivial bound) or delegate to a builder";

/** Core-shaped payload plus the workspace root the targets are checked against and the shell
 *  flavour (`powershell` for the foreman's opt-in powershell tool, else `bash`). */
export function shellWriteGuardPayload(input: Record<string, unknown>, pc: PayloadContext, workspace: string, piTool: "bash" | "powershell" = "bash"): Record<string, unknown> {
  return { ...preToolPayload(piTool, input, pc), workspace, shell: piTool };
}

export interface ShellWriteRunInput {
  python: string | null;
  /** Package root: the script is `<pkgRoot>/scripts/shell_write_guard.py`. */
  pkgRoot: string;
  payload: unknown;
  env: Record<string, string>;
  cwd: string;
  spawner: Spawner;
  timeoutMs?: number;
}

export function runShellWriteGuard(input: ShellWriteRunInput): Promise<GuardRun> {
  return runGuard({ python: input.python, coreDir: input.pkgRoot, guard: "shell_write_guard", payload: input.payload, env: input.env, cwd: input.cwd, spawner: input.spawner, timeoutMs: input.timeoutMs });
}

export type ShellWriteVerdict =
  | { decision: "allow" }
  | { decision: "refuse"; kind: string; reason: string }
  | { decision: "failure"; reason: string };

/** The write form named by the script (`kind`), reduced to a short slug: it goes to the trace. */
function kindOf(stdout: string): string {
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    try {
      const k = (JSON.parse(line) as { kind?: unknown }).kind;
      if (typeof k === "string" && /^[a-z0-9-]{1,24}$/.test(k)) return k;
    } catch {
      // not the JSON line
    }
  }
  return "unknown";
}

/** Script run -> verdict. Anything but a clean answer (no Python, timeout, crash, garbage, an ask) refuses. */
export function shellWriteVerdict(run: GuardRun, python: string | null): ShellWriteVerdict {
  const outcome = evaluateRun("shell_write_guard", run, python);
  if (outcome.kind === "failure") return { decision: "failure", reason: `${outcome.message} The call is blocked.` };
  if (outcome.d.decision === "none" || outcome.d.decision === "allow") return { decision: "allow" };
  const reason = outcome.d.reason || `pi-foreman: ${SHELL_WRITE_REFUSAL}`;
  return { decision: "refuse", kind: run.status === "ran" ? kindOf(run.stdout) : "unknown", reason };
}
