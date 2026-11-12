// Return of the session's own checkout to the base branch after its PR merged (docs/tools.md#watch).
//
// The PR watch calls mergedReturn() when the watched PR is merged: the checkout the PR was opened from goes back to the updated
// base branch and the local head branch is deleted, but only when nothing can be lost. Every check runs before any change; a failed
// check changes nothing and the answer says why and what the foreman or owner does. Git runs with argv arrays (no shell).
import { execFile } from "node:child_process";
import type { SafeOpOutcome } from "./safeops.ts";
import { parseWorktrees, samePath } from "./selffinish.ts";
import { cleanTree, untrackedClash } from "./shellwriteguard.ts";

export interface ReturnDeps {
  /** A pr_status of the PR (the host's answer, never a guess from git). */
  status: (n: number) => Promise<SafeOpOutcome>;
  /** `git <args>` in `dir`; `ok` false on any failure or the timeout. */
  git: (args: string[], dir: string) => Promise<{ ok: boolean; out: string }>;
  /** A child of the session (builder, reviewer, explorer) is still running: nothing is changed then. */
  busy?: () => boolean;
}

/** `left`: the checkout was changed before a step failed (a race), and the state it was left in. */
export type NotReturned = { returned: false; reason: string; advice: string; left?: string };
export type ReturnResult = { returned: true; base: string; sha: string; deleted: string } | NotReturned;

const GIT_TIMEOUT_MS = 30_000;

/** Real git, argv only; prompts are off so a fetch never waits for input. */
export const realGit: ReturnDeps["git"] = (args, dir) =>
  new Promise((resolve) => {
    execFile("git", args, { cwd: dir, timeout: GIT_TIMEOUT_MS, windowsHide: true, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout) => resolve({ ok: !err, out: String(stdout ?? "").trim() }));
  });

const keep = (reason: string, advice: string): NotReturned => ({ returned: false, reason, advice });

/** A branch or remote name that cannot be an option: non-empty, no leading `-`. */
const plainName = (s: unknown): s is string => typeof s === "string" && s !== "" && !s.startsWith("-") && !/[\0\r\n]/.test(s);

/**
 * Switch `cwd`'s checkout from the merged PR's head branch to the updated base branch and delete the head branch.
 * Preconditions, all before any change: no child running; the host says the PR is merged; the checkout is on the PR's head branch at the PR's last head;
 * the head branch is not a remote default branch; no tracked change; the local base branch has an upstream, is not checked out elsewhere and fast-forwards to the fetched base; no untracked or ignored file is overwritten.
 */
export async function returnToBase(deps: ReturnDeps, a: { cwd: string; number: number }): Promise<ReturnResult> {
  const git = (args: string[], dir: string = a.cwd) => deps.git(args, dir);
  if (deps.busy?.()) return keep("a builder, reviewer or explorer of this session is still running", "wait until it has finished, then switch the checkout to the base branch and delete the PR branch by hand");
  const o = await deps.status(a.number);
  if (o.kind !== "ran") return keep("the host's answer for the PR could not be read", "check the PR state, then return the checkout to the base branch by hand");
  const pr = o.result;
  if (pr.state !== "merged") return keep("the host does not report the PR as merged", "nothing is changed; wait until it is merged");
  const head = pr.headRefName;
  const base = pr.baseRef;
  const last = pr.headSha;
  if (!plainName(head) || !plainName(base) || typeof last !== "string" || !last) return keep("the host's answer has no usable head branch, base branch or head commit", "return the checkout to the base branch by hand");
  if (head === base) return keep("the PR's head branch is its base branch", "nothing is deleted; switch branches by hand if needed");
  const top = await git(["rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.out) return keep("the directory is not in a git checkout", "nothing is changed");
  const dir = top.out;
  const cur = await git(["symbolic-ref", "--short", "-q", "HEAD"], dir);
  if (!cur.ok || !cur.out) return keep("HEAD is detached", `check out ${head} or the base branch by hand`);
  if (cur.out !== head) return keep(`the checkout is on ${cur.out}, not on the PR branch ${head}`, "nothing is changed here; the PR may have been opened from another checkout");
  const tip = await git(["rev-parse", "HEAD"], dir);
  if (!tip.ok || tip.out !== last) return keep(`the local ${head} is not at the PR's last head (it has commits the PR never had, or lacks some)`, `push or move those commits first (the PR was merged at ${last.slice(0, 7)}), then switch to ${base} by hand`);
  const dirty = await cleanTree(dir);
  if (dirty) return keep(`${dirty} (tracked changes, staged or not)`, "commit or stash them, then switch to the base branch by hand");
  if (!(await git(["show-ref", "--verify", "--quiet", `refs/heads/${base}`], dir)).ok) return keep(`there is no local branch ${base}`, `create it from the remote (git switch ${base}), then delete ${head} by hand`);
  const remote = await git(["config", "--get", `branch.${base}.remote`], dir);
  const merge = await git(["config", "--get", `branch.${base}.merge`], dir);
  if (!remote.ok || !plainName(remote.out) || remote.out === "." || !merge.ok || !merge.out.startsWith("refs/heads/") || !plainName(merge.out)) return keep(`the local ${base} has no upstream remote branch`, `set one (git branch --set-upstream-to <remote>/${base} ${base}), then return to it by hand`);
  // the remote default branch is never deleted: the base's remote and origin are both asked (an unset HEAD ref names nothing)
  for (const r of new Set([remote.out, "origin"])) {
    const def = await git(["symbolic-ref", "--short", "-q", `refs/remotes/${r}/HEAD`], dir);
    if (def.ok && def.out === `${r}/${head}`) return keep(`the PR's head branch ${head} is the default branch of ${r}, which is never deleted`, `nothing is changed; switch to ${base} by hand`);
  }
  const remoteRef = `refs/remotes/${remote.out}/${merge.out.slice("refs/heads/".length)}`;
  if (!(await git(["fetch", "--no-tags", "--quiet", remote.out, `${merge.out}:${remoteRef}`], dir)).ok) return keep(`fetching ${base} from ${remote.out} failed`, "check the network or the remote, then update the base branch by hand");
  if (!(await git(["merge-base", "--is-ancestor", `refs/heads/${base}`, remoteRef], dir)).ok) return keep(`the local ${base} has commits that ${remote.out}'s ${base} lacks, so it cannot fast-forward`, `look at them (git log ${remoteRef}..${base}); the owner decides, nothing is changed`);
  const elsewhere = parseWorktrees((await git(["worktree", "list", "--porcelain"], dir)).out).find((w) => w.branch === base && !samePath(w.path, dir));
  if (elsewhere) return keep(`${base} is checked out in another worktree`, "switch that worktree away from it, then return by hand");
  // untracked or ignored files the move would overwrite: first to the local base, then to its fast-forward target
  const clash = (await untrackedClash(dir, `refs/heads/${base}`)) ?? (await untrackedClash(dir, remoteRef));
  if (clash) return keep(clash, "move or delete that file, then switch to the base branch by hand");
  const state = async (): Promise<string> => {
    const b = await git(["symbolic-ref", "--short", "-q", "HEAD"], dir);
    return b.ok && b.out ? `the checkout is on ${b.out}` : "HEAD is detached";
  };
  if (!(await git(["switch", base], dir)).ok) return { ...keep(`switching to ${base} failed`, "nothing was changed; switch by hand"), left: await state() };
  if (!(await git(["merge", "--ff-only", remoteRef], dir)).ok) return { ...keep(`fast-forwarding ${base} to ${remote.out}'s ${base} failed`, `the checkout stays on ${base}; update it by hand, then delete ${head} (git branch -D ${head})`), left: await state() };
  const sha = await git(["rev-parse", "HEAD"], dir);
  if (!(await git(["branch", "-D", head], dir)).ok) return { ...keep(`deleting the local ${head} failed`, `the checkout is on the updated ${base}; delete ${head} by hand (git branch -D ${head})`), left: await state() };
  return { returned: true, base, sha: sha.out, deleted: head };
}

/** The line a merged message carries for a result. */
export function returnLine(r: ReturnResult): string {
  if (r.returned === true) return `checkout returned: switched to ${r.base} at ${r.sha.slice(0, 7)} (fast-forwarded to the remote base) and deleted the local branch ${r.deleted}`;
  return `checkout left as it is: ${r.reason}; ${r.advice}${r.left ? ` (state: ${r.left})` : ""}`;
}

export interface MergedReturnDeps extends ReturnDeps {
  /** tools.prReturnToBase. */
  enabled: () => boolean;
  /** The session's own checkout. */
  sessionCwd: () => string;
}

/**
 * The merged hook of the PR watch: the line for the merged message and its outcome; null when the key is off.
 * Acts only when the watch's checkout is the session's own checkout (toplevels compared by real path).
 */
export async function mergedReturn(deps: MergedReturnDeps, a: { cwd: string; number: number }): Promise<{ line: string; outcome: "returned" | "kept" } | null> {
  if (!deps.enabled()) return null;
  const mine = await deps.git(["rev-parse", "--show-toplevel"], deps.sessionCwd());
  const theirs = await deps.git(["rev-parse", "--show-toplevel"], a.cwd);
  if (!mine.ok || !theirs.ok || !mine.out || !samePath(mine.out, theirs.out)) {
    return { line: "checkout left as it is: the PR was opened from a checkout other than this session's own, so neither is touched; the owner returns that checkout to the base branch by hand", outcome: "kept" };
  }
  const r = await returnToBase(deps, a);
  return { line: returnLine(r), outcome: r.returned ? "returned" : "kept" };
}
