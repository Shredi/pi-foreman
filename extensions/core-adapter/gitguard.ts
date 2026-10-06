// pi-foreman git guard (`scripts/git_guard.py`, design D4): payload and run helpers shared by
// the adapter (main mode: commit and push lint) and the child extension `extensions/git-guard`
// (child mode: block list). The script lives in the package's `scripts/`, not in `core/`.
import { preToolPayload } from "./payload.ts";
import type { PayloadContext } from "./payload.ts";
import { runGuard } from "./runguard.ts";
import type { GuardRun } from "./runguard.ts";
import type { Spawner } from "./spawn.ts";

export type GitGuardMode = "main" | "child";

/**
 * Main-mode fast path: the lint only looks at git commands, so a command that never names
 * git skips the Python spawn. Child mode always runs: obfuscated forms (g"i"t, `$a$b push`)
 * need the full parse there.
 */
export function mainNeedsGitGuard(command: unknown): boolean {
  return typeof command === "string" && /git/i.test(command);
}

/** Core-shaped payload plus the shell flavour and the merged `safety.git` config. */
export function gitGuardPayload(piTool: string, input: Record<string, unknown>, pc: PayloadContext, gitConfig?: unknown): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...preToolPayload(piTool, input, pc), shell: piTool === "powershell" ? "powershell" : "bash" };
  if (gitConfig && typeof gitConfig === "object" && !Array.isArray(gitConfig)) payload.foreman_git = gitConfig;
  return payload;
}

export interface GitGuardRunInput {
  python: string | null;
  /** Package root: the script is `<pkgRoot>/scripts/git_guard.py`. */
  pkgRoot: string;
  mode: GitGuardMode;
  payload: unknown;
  env: Record<string, string>;
  cwd: string;
  spawner: Spawner;
  timeoutMs?: number;
}

export function runGitGuard(input: GitGuardRunInput): Promise<GuardRun> {
  return runGuard({
    python: input.python,
    coreDir: input.pkgRoot,
    guard: "git_guard",
    args: ["--mode", input.mode],
    payload: input.payload,
    env: input.env,
    cwd: input.cwd,
    spawner: input.spawner,
    timeoutMs: input.timeoutMs,
  });
}
