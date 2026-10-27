// The gate's own, deterministic fact about the checkout a read path belongs to, for the review (never the model's call): a path
// outside the owned roots is `sibling-checkout` (inside a git work tree other than the current one), `agent-dir` (under the
// agent dir) or `outside`. Read-only surfaces only: read/grep/find/ls tools and path arguments of read-class shell commands.
// Any git failure counts as `outside`.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { underOwned } from "./owned.ts";
import { opsOf } from "./pathrules.ts";
import { parseShell } from "./shellast.ts";

export type PathState = "sibling-checkout" | "agent-dir" | "outside";

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const READ_COMMANDS = new Set(["find", "cat", "head", "tail", "grep", "rg", "ls", "diff", "wc"]);
const GIT_TIMEOUT_MS = 3000;
const MAX_FACTS = 5;

const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
const inside = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** The nearest existing directory of `abs` (itself when a directory). */
function existingDir(abs: string): string {
  let p = abs;
  for (;;) {
    try {
      if (fs.statSync(p).isDirectory()) return p;
    } catch {
      // not there: climb
    }
    const up = path.dirname(p);
    if (up === p) return p;
    p = up;
  }
}

/** The class of one absolute path outside the owned roots. */
export function pathState(abs: string, worktree: string, agentDir: string | undefined): PathState {
  const target = real(abs);
  if (agentDir && inside(target, real(agentDir))) return "agent-dir";
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: existingDir(target), timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return top && real(top) !== real(worktree) ? "sibling-checkout" : "outside";
  } catch {
    return "outside";
  }
}

function wordsOf(tool: string, input: unknown, command: string, cwd: string): string[] {
  if (READ_TOOLS.has(tool)) {
    const ops = opsOf(tool, (input && typeof input === "object" ? input : {}) as Record<string, unknown>) ?? [];
    return ops.flatMap(([w]) => (typeof w === "string" && !w.includes("$") ? [path.resolve(cwd, w)] : []));
  }
  const out: string[] = [];
  for (const seg of parseShell(command, { cwd })) {
    if (!READ_COMMANDS.has(path.basename(seg.program))) continue;
    for (const a of seg.argv) {
      if (a.startsWith("-") || a.includes("$") || !(a.startsWith("/") || a.startsWith("./") || a.startsWith("../") || a.includes("/"))) continue;
      out.push(path.resolve(seg.cwd ?? cwd, a));
    }
  }
  return out;
}

/** Context fact lines for the review, e.g. `path: /x/other sibling-checkout`; none for paths inside `owned` (roots may carry `*` segments). */
export function pathFacts(tool: string, input: unknown, command: string, cwd: string, worktree: string, owned: string[], agentDir?: string): string[] {
  try {
    const seen = new Set<string>();
    const roots = [worktree, ...owned];
    for (const abs of wordsOf(tool, input, command, cwd)) {
      if (seen.size >= MAX_FACTS) break;
      if (roots.some((r) => underOwned(r, abs) || underOwned(r, real(abs)))) continue;
      seen.add(`path: ${abs} ${pathState(abs, worktree, agentDir)}`);
    }
    return [...seen];
  } catch {
    return [];
  }
}
