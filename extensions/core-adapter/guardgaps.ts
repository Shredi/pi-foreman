// Destructive guard gaps on the adapter side (plan D5, ledger items 26, 28).
//
// 1. destructive_guard.py (core 0.22.0) exits 0 with no output (= allow) on unreadable stdin or
//    an internal exception, and treats a missing or non-string command as nothing to check. The
//    adapter therefore never sends it a shell call without a non-empty command string.
// 2. On allow it rewrites a recursive `rm` to `export PATH="$HOME/.claude/guard/bin:$PATH"; <cmd>`,
//    a guard bin dir that exists only under another harness. Until the core is re-pinned with
//    the opt-in FABLE_ORCH_GUARD_BIN (empty = no rewrite), the adapter drops a rewrite that only
//    prefixes a PATH export to a directory that does not exist; the decision itself is kept.
import * as fs from "node:fs";
import * as path from "node:path";
import type { HookDecision } from "./translate.ts";

/** Block reason when a shell call has no command string to check, else undefined. */
export function guardPayloadBlock(piTool: string, input: unknown): string | undefined {
  const cmd = input && typeof input === "object" ? (input as Record<string, unknown>).command : undefined;
  if (typeof cmd === "string" && cmd.trim() !== "") return undefined;
  const what = typeof cmd === "string" ? "an empty command" : cmd === undefined ? "no command" : `a command of type ${Array.isArray(cmd) ? "array" : typeof cmd}`;
  return `pi-foreman: the ${piTool} call has ${what}, so the destructive guard cannot check it; the call is blocked. Pass the command as a non-empty string.`;
}

const PATH_PREFIX = /^export PATH="([^"]*):\$PATH"; ([\s\S]*)$/;

/** Expand a leading `$HOME`/`${HOME}`/`~`; null when other variables remain (cannot be checked). */
export function expandGuardDir(raw: string, home: string): string | null {
  let p = raw;
  if (p.startsWith("$HOME")) p = home + p.slice(5);
  else if (p.startsWith("${HOME}")) p = home + p.slice(7);
  else if (p === "~" || p.startsWith("~/")) p = home + p.slice(1);
  if (p.includes("$")) return null;
  return path.normalize(p);
}

const defaultIsDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Drop `d.updatedInput` in place when it only prefixes `export PATH="<dir>:$PATH"; ` to the
 * original command and <dir> does not exist. Returns true when it was dropped.
 */
export function dropDeadPathRewrite(d: HookDecision, original: unknown, home: string, isDir: (p: string) => boolean = defaultIsDir): boolean {
  const updated = d.updatedInput;
  if (!updated || typeof updated.command !== "string" || typeof original !== "string") return false;
  const others = Object.keys(updated).filter((k) => k !== "command");
  if (others.length > 0) return false;
  const m = PATH_PREFIX.exec(updated.command);
  if (!m || m[2] !== original) return false;
  const dir = expandGuardDir(m[1], home);
  if (dir === null || isDir(dir)) return false;
  delete d.updatedInput;
  return true;
}
