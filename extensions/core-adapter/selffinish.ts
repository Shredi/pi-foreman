// Self-finish of a child foreman session whose watched PR was merged (docs/close.md#self-finish-on-merge).
//
// The close sequence (source `pr-merged`, close.ts) calls selfFinish() after the result file and the report: one pr_status
// decides the verified-merged fact (MERGED, head ref == the target worktree's branch, head commit == the local tip). The target
// is the session's worktree when its branch is the PR head ref, else the worktree of `git worktree list` that has the head ref
// checked out (never the main worktree, never the base branch). `.workflow/` is archived into `<handoff>/workflow/`, and
// scripts/foreman_close.py `selfclean` checks every worktree precondition in this
// session (a refusal is a line for result.md and the parent, nothing is spawned). Only when all pass, the close flow's very
// last step runs the returned `spawn`: a detached python process that waits for this pi process to exit, then removes the
// worktree and the local branch and writes `<handoff>/cleanup.json`. No remote delete: a remote head branch that still
// exists is only listed (`kept:`).
import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
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
  /** `git <args>` in `dir` (default: the session's cwd); stdout trimmed, null on any failure. */
  git: (args: string[], dir?: string) => Promise<string | null>;
  /** The session's start (epoch ms): files older than it in the main worktree's `.workflow/` are not archived. */
  sinceMs?: number;
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

export interface Worktree {
  path: string;
  /** Short branch name; null when detached. */
  branch: string | null;
}

/** `git worktree list --porcelain`: the first entry is the main worktree. */
export function parseWorktrees(text: string | null): Worktree[] {
  const out: Worktree[] = [];
  for (const block of (text ?? "").split(/\r?\n\r?\n/)) {
    let wt: Worktree | null = null;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) wt = { path: line.slice("worktree ".length), branch: null };
      else if (wt && line.startsWith("branch refs/heads/")) wt.branch = line.slice("branch refs/heads/".length);
    }
    if (wt) out.push(wt);
  }
  return out;
}

/** The same directory: real path, separators and (Windows) case folded. */
export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

function pathKey(p: string): string {
  let r = path.resolve(p);
  try {
    r = fs.realpathSync.native(r);
  } catch {
    // not on disk: compare the resolved text
  }
  return process.platform === "win32" ? r.replace(/\\/g, "/").toLowerCase() : r;
}

/** `d` is `k` or below it; only a separator valid on the platform counts (on POSIX a `\` is a name character). */
export function isInside(d: string, k: string): boolean {
  return d === k || d.startsWith(k + "/") || (process.platform === "win32" && d.startsWith(k + "\\"));
}

/** The worktree of the list that contains `dir` (the longest match, so a linked worktree below the main checkout wins); null when none does. */
export function worktreeRoot(dir: string, wts: Worktree[]): string | null {
  const d = pathKey(dir);
  let best: string | null = null;
  let bestLen = -1;
  for (const w of wts) {
    const k = pathKey(w.path).replace(/[\\/]+$/, "");
    if (isInside(d, k) && k.length > bestLen) {
      best = w.path;
      bestLen = k.length;
    }
  }
  return best;
}

const ACTIONS: Record<string, string> = {
  worktree_dirty: "the owner commits or discards the changes in it",
  ignored_files: "the owner copies or deletes the ignored files in it (see the left out line)",
  not_merged: "the owner waits until the PR is merged",
};

/** Reasons for which the worktree and the branch are never removed: nothing for the owner to do. */
const NEVER = new Set(["default_branch", "main_worktree"]);

const SWEEP = "then runs `foreman worktree sweep`, which removes a worktree and its branch only when its own checks pass (docs/close.md, cleanup preconditions)";

/** The line for a cleanup that does not start: names the real worktree and branch, says what the owner does. */
function stays(target: string, branch: string, reason: string): string {
  const head = `cleanup: not started (${reason}); worktree ${target} and branch ${branch} stay: `;
  if (NEVER.has(reason)) return `${head}this worktree and branch are never removed; there is nothing for the owner to do with them`;
  const first = ACTIONS[reason] ?? `the owner resolves "${reason}" (see the cleanup preconditions in docs/close.md)`;
  return `${head}${first}, ${SWEEP}`;
}

interface CheckOut { ok?: unknown; reason?: unknown; archived?: unknown; archivedCwd?: unknown; leftOut?: unknown; remoteBranch?: unknown }

/** The archive lines of a check answer: the byte-identical `workflow archive:` line, then `workflow archive left out:` when something was. */
function archiveLines(out: CheckOut, archive: string): string[] {
  const lines: string[] = [];
  if (typeof out.archived === "number" && out.archived > 0) lines.push(`workflow archive: ${archive} (${out.archived} files)`);
  if (typeof out.archivedCwd === "number" && out.archivedCwd > 0) lines.push(`workflow archive (session cwd): ${path.join(path.dirname(archive), "workflow-cwd")} (${out.archivedCwd} files)`);
  const left = Array.isArray(out.leftOut) ? out.leftOut.filter((x): x is string => typeof x === "string") : [];
  if (left.length) lines.push(`workflow archive left out: ${left.join("; ")}`);
  return lines;
}

/** The self-finish of the `pr-merged` close: report lines and, when every precondition holds, the detached cleanup. */
export async function selfFinish(d: SelfFinishDeps, n: number): Promise<SelfFinish> {
  const status = await d.status(n);
  const pr = status.kind === "ran" ? status.result : null;
  const headRef = typeof pr?.headRefName === "string" && pr.headRefName ? pr.headRefName : null;
  const baseRef = typeof pr?.baseRef === "string" && pr.baseRef ? pr.baseRef : null;
  const cwdBranch = await d.git(["symbolic-ref", "--short", "-q", "HEAD"]);
  const wts = parseWorktrees(await d.git(["worktree", "list", "--porcelain"]));
  const root = worktreeRoot(d.cwd, wts);
  if (!root) {
    const snap = await snapshotOnly(d, d.cwd, cwdBranch ?? headRef ?? "HEAD");
    return { lines: [...snap, `cleanup: not started (the session cwd ${d.cwd} is in no worktree of this repository); nothing is removed; the owner runs \`foreman worktree sweep\` from a worktree of the repository, which removes a worktree and its branch only when its own checks pass`] };
  }
  let target = root;
  let branch = cwdBranch;
  if (headRef && cwdBranch !== headRef) {
    const w = wts.find((x) => x.branch === headRef);
    branch = headRef;
    if (!w) {
      const lines = [`merged fact: not verified (PR #${n} head branch ${headRef} is not checked out in a worktree of this repository)`];
      const snap = await snapshotOnly(d, root, cwdBranch ?? headRef);
      const kept = samePath(root, wts[0].path)
        ? `worktree ${root} is the main checkout and is never removed; branch ${headRef} is checked out in no worktree and nothing is done with it; there is nothing for the owner to do with them`
        : `worktree ${root} stays; branch ${headRef} is checked out in no worktree and nothing is done with it; the owner decides about worktree ${root}: \`foreman worktree sweep\` removes a worktree and its branch only when its own checks pass (docs/close.md, cleanup preconditions)`;
      lines.push(...snap, `cleanup: not started; nothing is removed: ${kept}`);
      return { lines };
    }
    target = w.path;
  }
  const isMain = samePath(target, wts[0].path);
  if (!branch) {
    if (isMain) {
      const snap = await snapshotOnly(d, root, "HEAD");
      return { lines: [...snap, `cleanup: not started (worktree ${target} is the main checkout and has no branch checked out); nothing is removed: worktree ${target} is never removed; there is nothing for the owner to do with it`] };
    }
    return { lines: [`cleanup: not started (the worktree ${target} has no branch checked out); nothing is removed: worktree ${target} stays; the owner checks out the round's branch in it, ${SWEEP}`] };
  }
  const lines: string[] = [];
  if (isMain || branch === baseRef) {
    const why = isMain ? `worktree ${target} is the main checkout` : `branch ${branch} is the base branch of PR #${n}`;
    const kept = isMain
      ? `worktree ${target} is the main checkout and is never removed; branch ${branch} stays while it is checked out there; there is nothing for the owner to do with them`
      : `worktree ${target} stays and branch ${branch} is the PR base branch and is kept; there is nothing for the owner to do with the branch`;
    const snap = await snapshotOnly(d, root, branch);
    return { lines: [...snap, `cleanup: not started (${why}); nothing is removed: ${kept}`] };
  }
  const tip = await d.git(["rev-parse", "--verify", "HEAD"], samePath(target, root) ? undefined : target);
  if (!tip) return { lines: [`cleanup: not started (the worktree ${target} has no commit checked out); nothing is removed: worktree ${target} and branch ${branch} stay; the owner commits the round's work in it, ${SWEEP}`] };
  const fact = await verifyMerged(async () => status, n, branch, tip);
  if ("why" in fact) lines.push(`merged fact: not verified (${fact.why}); only a branch merged into the base is removed`);
  const archive = path.join(d.handoff, ARCHIVE_DIR);
  const common = ["selfclean", "--ws", target, "--branch", branch, "--state", d.stateDir, "--session", d.sessionId, ...("sha" in fact ? ["--verified-merged", fact.sha] : []), ...(d.trusted ? ["--trusted-project"] : [])];
  let out: CheckOut = {};
  try {
    out = JSON.parse(await d.closeScript([...common, "--archive", archive, "--session-cwd", root, ...since(d)])) as CheckOut;
  } catch {
    out = { reason: "the check did not answer" };
  }
  lines.push(...archiveLines(out, archive));
  if (out.ok !== true) {
    const reason = typeof out.reason === "string" ? out.reason : "refused";
    lines.push(stays(target, branch, reason));
    return { lines };
  }
  if (typeof out.remoteBranch === "string") lines.push(`kept: remote branch ${branch} (enable delete head branch on merge)`);
  const cleanup = path.join(d.handoff, CLEANUP_FILE);
  lines.push(`cleanup: worktree ${target} and branch ${branch} are removed after this session exits (result: ${cleanup})`);
  return { lines, spawn: () => d.spawnCleanup([...common, "--exempt-workflow", "--wait-pid", String(d.pid), "--out", cleanup]) };
}

const since = (d: SelfFinishDeps): string[] => (d.sinceMs === undefined ? [] : ["--since", String(d.sinceMs / 1000)]);

/** The snapshot of the session's own cwd when no worktree is a target or the cleanup is refused up front (the answer's ok is ignored: nothing is removed). */
async function snapshotOnly(d: SelfFinishDeps, ws: string, branch: string): Promise<string[]> {
  const archive = path.join(d.handoff, ARCHIVE_DIR);
  try {
    const out = JSON.parse(await d.closeScript(["selfclean", "--ws", ws, "--branch", branch, "--state", d.stateDir, "--session", d.sessionId, ...(d.trusted ? ["--trusted-project"] : []), "--archive", archive, ...since(d)])) as CheckOut;
    return archiveLines(out, archive);
  } catch {
    return [];
  }
}

/** Start `cmd args` detached (own process group, no stdio, unref'd): it outlives this process on Linux, macOS and Windows. */
export function spawnDetached(cmd: string, args: string[], cwd: string, spawn: typeof nodeSpawn = nodeSpawn): void {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true, cwd });
  child.on?.("error", () => undefined);
  child.unref();
}
