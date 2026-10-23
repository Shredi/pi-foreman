// pi-foreman shell write guard (`scripts/shell_write_guard.py`, plan D3): the foreman's bash
// (and its opt-in powershell tool) may not write project files at any tier. Its edit/write tools (measured by the trivial bound)
// or a builder are the only paths; `.workflow/` stays writable. Children are not affected.
// The script lives in the package's `scripts/`, not in `core/`. Fail-closed like the git guard.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { preToolPayload } from "./payload.ts";
import type { PayloadContext } from "./payload.ts";
import { runGuard } from "./runguard.ts";
import type { GuardRun } from "./runguard.ts";
import type { Spawner } from "./spawn.ts";
import { evaluateRun } from "./translate.ts";

export const SHELL_WRITE_REFUSAL = "shell write into project files refused: use the edit/write tools (measured by the trivial bound) or delegate to a builder";

/** Core-shaped payload plus the workspace root the targets are checked against, the shell
 *  flavour (`powershell` for the foreman's opt-in powershell tool, else `bash`) and the
 *  workspace-relative dirs that stay writable (edit mode; the script defaults to `.workflow`).
 *  `ownedDirs`: absolute dirs the foreman owns (owned.ts `allowDirs`; the script's `allow_dirs`), a write
 *  strictly inside one never counts, so `cp -R node_modules ../<repo>.worktrees/<b>/node_modules` passes. */
export function shellWriteGuardPayload(input: Record<string, unknown>, pc: PayloadContext, workspace: string, piTool: "bash" | "powershell" = "bash", allowedDirs: string[] = [".workflow"], ownedDirs: string[] = []): Record<string, unknown> {
  return { ...preToolPayload(piTool, input, pc), workspace, shell: piTool, allowed_dirs: allowedDirs, ...(ownedDirs.length ? { allow_dirs: ownedDirs } : {}) };
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

export type BranchMove = { allow: true } | { allow: false; precondition: string };

// A word of a plain command: no quotes, globs, expansions, `~`, `^` or braces (those stay refused).
const PLAIN_WORD = /^[\w./@:-]+$/;
// one leading `cd <dir> &&` (r31): cdTarget checks the dir, the rest is the git command
const CD_PREFIX = /^cd[ \t]+(\S+)[ \t]+&&[ \t]+(.*)$/;
const GIT_TIMEOUT_MS = 15_000;
const GH_TIMEOUT_MS = 5_000;

function runCmd(file: string, args: string[], cwd: string, timeout: number, env?: NodeJS.ProcessEnv): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout, env, windowsHide: true, encoding: "utf8" }, (err, stdout) => resolve({ ok: !err, out: String(stdout ?? "") }));
  });
}

function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return runCmd("git", args, cwd, GIT_TIMEOUT_MS);
}

function realpathOf(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** The same precondition as `foreman_worktree_remove`: no tracked change. Tracked files only (`--untracked-files=no`); untracked and ignored files are checked by untrackedClash on a ref move. */
async function cleanTree(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  if (!r.ok) return "git status failed";
  return r.out.trim() ? "working tree not clean" : null;
}

/** HEAD is an ancestor of `ref`, or HEAD is contained in some remote branch (a pushed upstream). */
async function headContained(cwd: string, ref: string): Promise<boolean> {
  if ((await runGit(cwd, ["merge-base", "--is-ancestor", "HEAD", ref])).ok) return true;
  const up = await runGit(cwd, ["branch", "-r", "--contains", "HEAD"]);
  return up.ok && up.out.trim() !== "";
}

/** The dir a `cd <word> &&` prefix enters, when it is the session cwd or its git toplevel (realpath compare); null otherwise. */
async function cdTarget(cwd: string, word: string): Promise<string | null> {
  if (!PLAIN_WORD.test(word) || word.startsWith("-")) return null;
  const target = realpathOf(path.resolve(cwd, word));
  const here = realpathOf(cwd);
  if (!target || !here) return null;
  if (target === here) return target;
  const top = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  return top.ok && realpathOf(top.out.trim()) === target ? target : null;
}

/** HEAD's content is already in `ref`: merging HEAD into `ref` leaves `ref`'s tree (a squash merge), or every HEAD commit has a patch-equal commit in `ref` (a rebase merge). */
async function contentIn(cwd: string, ref: string): Promise<boolean> {
  const merged = await runGit(cwd, ["merge-tree", "--write-tree", ref, "HEAD"]);
  if (merged.ok) {
    const tree = await runGit(cwd, ["rev-parse", `${ref}^{tree}`]);
    if (tree.ok && merged.out.split(/\r?\n/)[0].trim() === tree.out.trim()) return true;
  }
  const cherry = await runGit(cwd, ["cherry", ref, "HEAD"]);
  return cherry.ok && !/^\+/m.test(cherry.out);
}

/** The current branch's PR is MERGED and its head is HEAD (a merged PR whose branch is gone). Detached HEAD, no gh, any error or the timeout: no. */
async function prMerged(cwd: string): Promise<boolean> {
  const branch = await runGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (!branch.ok || !branch.out.trim()) return false;
  const head = await runGit(cwd, ["rev-parse", "HEAD"]);
  const pr = await runCmd("gh", ["pr", "view", branch.out.trim(), "--json", "state,headRefOid"], cwd, GH_TIMEOUT_MS, { ...process.env, GH_PROMPT_DISABLED: "1" });
  if (!head.ok || !pr.ok) return false;
  try {
    const v = JSON.parse(pr.out) as { state?: unknown; headRefOid?: unknown };
    return v.state === "MERGED" && v.headRefOid === head.out.trim();
  } catch {
    return false;
  }
}

/** A path that `ref` adds (changed between HEAD and `ref`) exists in the worktree untracked or ignored: `reset --hard` would overwrite it. Null when none. */
async function untrackedClash(cwd: string, ref: string): Promise<string | null> {
  const top = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return "git rev-parse failed";
  const diff = await runGit(top.out.trim(), ["diff", "--name-only", "-z", "HEAD", ref]);
  if (!diff.ok) return "git diff failed";
  const paths = diff.out.split("\0").filter(Boolean);
  if (paths.length === 0) return null;
  // no --exclude-standard: ignored files count too; literal pathspecs, so a name with glob characters matches only itself
  const loose = await runGit(top.out.trim(), ["--literal-pathspecs", "ls-files", "--others", "-z", "--", ...paths]);
  if (!loose.ok) return "git ls-files failed";
  const clash = loose.out.split("\0").find(Boolean);
  return clash ? `untracked or ignored file ${clash} would be overwritten` : null;
}

async function moveToRef(cwd: string, ref: string): Promise<BranchMove> {
  const dirty = await cleanTree(cwd);
  if (dirty) return { allow: false, precondition: dirty };
  const contained = (await headContained(cwd, ref)) || (await contentIn(cwd, ref)) || (await prMerged(cwd));
  if (!contained) return { allow: false, precondition: `HEAD is neither contained in ${ref} nor in a pushed branch` };
  const clash = await untrackedClash(cwd, ref);
  return clash ? { allow: false, precondition: clash } : { allow: true };
}

/**
 * r29 foreman branch moves: the guard refuses `git switch|checkout <b>`, `git switch -C <b> <ref>` and `git reset --hard <ref>`;
 * a plain single command of exactly these shapes is allowed when its preconditions hold (branch-only git, no content change).
 * r31: one leading `cd <dir> &&` is allowed when <dir> is the session cwd or its git toplevel (realpath); the checks run there.
 * Null: not one of these shapes (the refusal stands unchanged). Children never get it (`foreman` false).
 */
export async function branchMove(command: string, cwd: string, foreman: boolean): Promise<BranchMove | null> {
  if (!foreman || /[\r\n]/.test(command)) return null;
  let line = command.trim();
  let dir = cwd;
  const cd = CD_PREFIX.exec(line);
  if (cd) {
    const target = await cdTarget(cwd, cd[1]);
    if (!target) return null;
    dir = target;
    line = cd[2];
  }
  const words = line.split(/\s+/);
  if (words[0] !== "git" || !words.slice(1).every((w) => PLAIN_WORD.test(w))) return null;
  const args = words.slice(1);
  if (args.length === 2 && (args[0] === "switch" || args[0] === "checkout") && !args[1].startsWith("-")) {
    const dirty = await cleanTree(dir);
    if (dirty) return { allow: false, precondition: dirty };
    if (!(await runGit(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${args[1]}`])).ok) return { allow: false, precondition: `no local branch ${args[1]}` };
    return { allow: true };
  }
  if (args.length === 4 && args[0] === "switch" && args[1] === "-C" && !args[2].startsWith("-") && !args[3].startsWith("-")) return moveToRef(dir, args[3]);
  if (args.length === 3 && args[0] === "reset" && args[1] === "--hard" && !args[2].startsWith("-")) return moveToRef(dir, args[2]);
  return null;
}
