// Child read budget (ceremony.childReads.<role>.{warn,deny}); pure logic, index.ts wires it into
// tool_call / tool_result for child sessions only (the foreman has budget.ts ReadBudget).
//
// Counted: read, grep, find, ls and read-only bash, by distinct top-level call id. A builder's
// test, build or git-write bash call is never counted. At warn the result carries a notice;
// above deny the call is refused and the child is told to return its report with what it has
// (`STATUS: stuck` if it cannot finish: ladder trigger b). A role without limits has no budget:
// the coded defaults apply only when `ceremony.childReads` is absent from the config altogether.
import { get, type Json } from "./config.ts";
import { PACK_READ_TOOL_NAMES } from "./gitpack.ts";
import { topLevelId } from "./budget.ts";
import { isReadOnlySed } from "./sedread.ts";

export interface ChildLimits {
  warn: number;
  deny: number;
}

export const DEFAULT_CHILD_READS: Record<string, ChildLimits> = { builder: { warn: 20, deny: 40 }, reviewer: { warn: 15, deny: 30 } };
export const CHILD_READ_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls", "bash", ...PACK_READ_TOOL_NAMES]);

const posInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;

/** Per-launch allowance (R46): every file beyond 3 in `size.files` adds `perFile` to the deny, up to `max`. */
export const DEFAULT_PER_FILE: Record<string, number> = { builder: 5, reviewer: 2 };
export const DEFAULT_MAX_READS = 120;
const FREE_FILES = 3;

function roleEntry(config: Json | undefined, role: string): Record<string, unknown> | null {
  const all = get(config, "ceremony.childReads");
  if (all === undefined) return DEFAULT_CHILD_READS[role] ? {} : null;
  const e = all && typeof all === "object" ? (all as Record<string, unknown>)[role] : undefined;
  return e && typeof e === "object" ? (e as Record<string, unknown>) : null;
}

const maxOf = (o: Record<string, unknown>): number => (posInt(o.max) ? o.max : DEFAULT_MAX_READS);

/**
 * Limits of `role`, or null (no budget). `allowance` is the launch's deny (launchReadAllowance, carried in the binding); the warn
 * moves with it. The deny never exceeds the role's `max`.
 */
export function childReadLimits(config: Json | undefined, role: string, allowance?: number): ChildLimits | null {
  const o = roleEntry(config, role);
  if (!o) return null;
  const d = DEFAULT_CHILD_READS[role] ?? { warn: 20, deny: 40 };
  const base = posInt(o.deny) ? o.deny : d.deny;
  const warn = Math.min(posInt(o.warn) ? o.warn : d.warn, base);
  const deny = Math.min(maxOf(o), posInt(allowance) ? allowance : base);
  return { warn: Math.max(1, Math.min(deny - (base - warn), deny)), deny };
}

/** The deny a launch asks for: an explicit `reads` (clamped to `max`), else the size formula; `allowance` is absent when nothing changes. */
export function launchReadAllowance(config: Json | undefined, role: string, o: { files?: number; reads?: number }): { allowance?: number; clamped?: boolean } {
  const e = roleEntry(config, role);
  if (!e) return {};
  const max = maxOf(e);
  if (posInt(o.reads)) return o.reads > max ? { allowance: max, clamped: true } : { allowance: o.reads };
  const files = o.files ?? 0;
  if (files <= FREE_FILES) return {};
  const base = childReadLimits(config, role)!.deny;
  const perFile = posInt(e.perFile) ? e.perFile : DEFAULT_PER_FILE[role] ?? DEFAULT_PER_FILE.builder;
  return { allowance: Math.min(max, base + perFile * (files - FREE_FILES)) };
}

// First words of commands that only read. Pipelines and && / ; chains count when every part is one.
const READ_WORDS = new Set(["cat", "head", "tail", "ls", "grep", "egrep", "fgrep", "rg", "wc", "tree", "file", "stat", "nl", "less", "more", "cut", "sort", "uniq", "tr", "awk", "diff", "du", "realpath"]);
const GIT_READ = new Set(["log", "show", "diff", "status", "blame", "ls-files", "grep", "rev-parse", "branch", "cat-file", "ls-tree", "describe", "shortlog", "reflog"]);

/** True when a bash command only reads (conservative: anything unclear is not read-only, so not counted). */
export function isReadOnlyBash(command: unknown): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  if (/[`>]|\$\(|<\(/.test(command)) return false;
  const parts = command.split(/&&|\|\||;|\||\n/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((p) => {
    const w = p.split(/\s+/);
    const first = w[0];
    if (first === "git") {
      const sub = w.slice(1).find((x) => !x.startsWith("-"));
      return sub !== undefined && GIT_READ.has(sub) && !(sub === "branch" && w.some((x) => /^-(d|D|m|M|c|C)$|^--(delete|move|copy)$/.test(x)));
    }
    if (first === "find") return !w.some((x) => /^-(exec|execdir|delete|ok|okdir|fprint\w*)$/.test(x));
    if (first === "sed") return isReadOnlySed(p);
    if (first === "awk") return !/system\s*\(|print\s*>|\|\s*"/.test(p);
    return READ_WORDS.has(first);
  });
}

export type ChildReadDecision =
  | { kind: "allow" }
  | { kind: "warn"; count: number; text: string }
  | { kind: "deny"; count: number; reason: string };

export class ChildReads {
  private ids = new Set<string>();

  get count(): number {
    return this.ids.size;
  }

  check(toolName: string, toolCallId: string, input: unknown, limits: ChildLimits | null): ChildReadDecision {
    if (!limits || !CHILD_READ_TOOLS.has(toolName)) return { kind: "allow" };
    if (toolName === "bash" && !isReadOnlyBash((input as { command?: unknown } | null)?.command)) return { kind: "allow" };
    const top = topLevelId(toolCallId);
    if (this.ids.has(top)) return { kind: "allow" };
    const n = this.ids.size + 1;
    if (n > limits.deny) {
      return { kind: "deny", count: n - 1, reason: `pi-foreman: [child_read_budget_exceeded] ${n - 1} read calls (limit ${limits.deny}). Stop reading: return your report now with what you have. If you cannot finish, start it with "STATUS: stuck" and say what is missing.` };
    }
    this.ids.add(top);
    if (n >= limits.warn) return { kind: "warn", count: n, text: `pi-foreman: read budget ${n} of ${limits.deny} read calls. Wrap up and return your report; at ${limits.deny} further reads are refused.` };
    return { kind: "allow" };
  }
}
