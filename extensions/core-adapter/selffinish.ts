// Self-finish of a child foreman session whose watched PR was merged (docs/close.md#self-finish-on-merge).
//
// The close sequence (source `pr-merged`, close.ts) calls selfFinish() after the result file and the report: one pr_status
// decides the verified-merged fact (MERGED, head ref == this worktree's branch, head commit == the local tip), `.workflow/`
// is archived into `<handoff>/workflow/`, and scripts/foreman_close.py `selfclean` checks every worktree precondition in this
// session (a refusal is a line for result.md and the parent, nothing is spawned). Only when all pass, the close flow's very
// last step runs the returned `spawn`: a detached python process that waits for this pi process to exit, then removes the
// worktree and the local branch and writes `<handoff>/cleanup.json`. No remote delete: a remote head branch that still
// exists is only listed (`kept:`).
import { spawn as nodeSpawn } from "node:child_process";
import * as path from "node:path";
import type { SelfFinish } from "./close.ts";
import type { SafeOpOutcome } from "./safeops.ts";

export const CLEANUP_FILE = "cleanup.json";
export const ARCHIVE_DIR = "workflow";

export interface SelfFinishDeps {
  /** The worktree (the session's cwd) and the handoff dir. */
  cwd: string;
  handoff: string;
  sessionId: string;
  stateDir: string;
  /** A pr_status of this PR. */
  status: (n: number) => Promise<SafeOpOutcome>;
  /** `git <args>` in the worktree; stdout trimmed, null on any failure. */
  git: (args: string[]) => Promise<string | null>;
  /** scripts/foreman_close.py through the Python runner (the check); the stdout JSON. */
  closeScript: (args: string[]) => Promise<string>;
  /** Detached start of `foreman_close.py selfclean ...` (the cleanup). */
  spawnCleanup: (args: string[]) => void;
  pid: number;
  trusted: boolean;
}

/** The verified-merged fact: the head commit when PR `n` is MERGED, its head ref is `branch` and its head commit is `tip`; else why not. */
export async function verifyMerged(status: SelfFinishDeps["status"], n: number, branch: string, tip: string): Promise<{ sha: string } | { why: string }> {
  const o = await status(n);
  if (o.kind !== "ran") return { why: "pr_status failed" };
  const r = o.result;
  if (r.state !== "merged") return { why: `PR #${n} is not merged` };
  if (r.headRefName !== branch) return { why: `PR #${n} head ref is not ${branch}` };
  if (r.headSha !== tip) return { why: `PR #${n} head commit is not the local tip` };
  return { sha: tip };
}

/** The self-finish of the `pr-merged` close: report lines and, when every precondition holds, the detached cleanup. */
export async function selfFinish(d: SelfFinishDeps, n: number): Promise<SelfFinish> {
  const branch = await d.git(["symbolic-ref", "--short", "-q", "HEAD"]);
  const tip = await d.git(["rev-parse", "--verify", "HEAD"]);
  if (!branch || !tip) return { lines: ["cleanup: not started (the worktree has no branch checked out)"] };
  const lines: string[] = [];
  const fact = await verifyMerged(d.status, n, branch, tip);
  if ("why" in fact) lines.push(`merged fact: not verified (${fact.why}); only a branch merged into the base is removed`);
  const archive = path.join(d.handoff, ARCHIVE_DIR);
  const common = ["selfclean", "--ws", d.cwd, "--branch", branch, "--state", d.stateDir, "--session", d.sessionId, ...("sha" in fact ? ["--verified-merged", fact.sha] : []), ...(d.trusted ? ["--trusted-project"] : [])];
  let out: { ok?: unknown; reason?: unknown; archived?: unknown; remoteBranch?: unknown } = {};
  try {
    out = JSON.parse(await d.closeScript([...common, "--archive", archive])) as typeof out;
  } catch {
    out = { reason: "the check did not answer" };
  }
  if (typeof out.archived === "number" && out.archived > 0) lines.push(`workflow archive: ${archive} (${out.archived} files)`);
  if (out.ok !== true) {
    lines.push(`cleanup: not started (${typeof out.reason === "string" ? out.reason : "refused"}); the worktree and branch ${branch} stay`);
    return { lines };
  }
  if (typeof out.remoteBranch === "string") lines.push(`kept: remote branch ${branch} (enable delete head branch on merge)`);
  const cleanup = path.join(d.handoff, CLEANUP_FILE);
  lines.push(`cleanup: worktree ${d.cwd} and branch ${branch} are removed after this session exits (result: ${cleanup})`);
  return { lines, spawn: () => d.spawnCleanup([...common, "--exempt-workflow", "--wait-pid", String(d.pid), "--out", cleanup]) };
}

/** Start `cmd args` detached (own process group, no stdio, unref'd): it outlives this process on Linux, macOS and Windows. */
export function spawnDetached(cmd: string, args: string[], cwd: string, spawn: typeof nodeSpawn = nodeSpawn): void {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true, cwd });
  child.on?.("error", () => undefined);
  child.unref();
}
