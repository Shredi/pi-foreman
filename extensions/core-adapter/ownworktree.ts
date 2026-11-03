// Which worktrees count as the session's own for the push guard: the session's checkout and the worktrees this session created (the session
// manifest, roundsurface.ts roundWorktrees). A plain push of the branch checked out in one of them is routine; any other linked worktree is not own.
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { GitFacts } from "./defaults.ts";
import { linkedWorktrees } from "./gate.ts";
import { realDeep } from "./triage.ts";

/** `p` as a comparison key: resolved on the platform's path flavour, trailing separators dropped, case-folded on win32 and darwin (as manifest.ts does). */
export function pathKey(p: string, platform: string): string {
  const x = platform === "win32" ? path.win32 : path.posix;
  const r = x.resolve(platform === "win32" ? p.replace(/\//g, "\\") : p);
  return platform === "win32" || platform === "darwin" ? r.toLowerCase() : r;
}

/** `dir` is `root` or lies below it (both compared as keys). */
export function pathWithin(root: string, dir: string, platform: string): boolean {
  const x = platform === "win32" ? path.win32 : path.posix;
  const r = pathKey(root, platform);
  const d = pathKey(dir, platform);
  return d === r || d.startsWith(r.endsWith(x.sep) ? r : r + x.sep);
}

/** The top level of the git worktree holding `dir` (`git rev-parse --show-toplevel` run there); null when `dir` does not exist or lies in no worktree. */
export function worktreeTop(dir: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * A predicate: the real spelling of the worktree top level of `dir` equals the real spelling of one of `roots` exactly. A subdir of a root is own; a
 * linked worktree nested inside a root, a symlink inside a root pointing out, a nonexistent or non-git path is not.
 */
export function ownWorktreeCheck(
  roots: string[],
  platform: string = process.platform,
  real: (p: string) => string = realDeep,
  top: (dir: string) => string | null = worktreeTop,
): (dir: string) => boolean {
  const all = new Set(roots.filter(Boolean).map((r) => pathKey(real(r), platform)));
  return (dir) => {
    const t = top(real(dir));
    return t !== null && all.has(pathKey(real(t), platform));
  };
}

/** The git facts of a session: `base` with `ownBranches` limited to the linked worktrees `isOwn` accepts, and `isOwnWorktree` set. */
export function sessionGitFacts(base: GitFacts, isOwn: (dir: string) => boolean): GitFacts {
  return {
    ...base,
    isOwnWorktree: isOwn,
    ownBranches: (cwd) => linkedWorktrees(cwd).filter((w) => w.branch !== null && isOwn(w.path)).map((w) => w.branch as string),
  };
}
