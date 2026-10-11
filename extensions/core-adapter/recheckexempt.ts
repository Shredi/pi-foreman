// Recheck-budget exemptions (ceremony.recheckBudget, harness-friction ledger item 4): a handoff poll
// (ruling.md, a read of the owned dirs from owned.ts) and a worktree creation/listing are not
// re-checks of the reviewed work. Pure: index.ts readBudgetCheck calls `recheckExempt`.
// A call is exempt only when every path operand it names is under an owned root or is a file named
// ruling.md (and at least one is), or when it is `git worktree add|list|prune`; anything it cannot
// read with certainty (command substitution, an unknown variable) counts as before.
import * as path from "node:path";
import { underOwned } from "./owned.ts";
import type { OwnedRoots } from "./owned.ts";

export interface ExemptCtx {
  cwd: string;
  home: string;
  platform: string;
  owned: OwnedRoots;
}

const PATH_FIELDS = ["path", "file", "dir", "directory", "cwd"] as const;
const NEUTRAL_VERBS = new Set(["sleep", "echo", "true", ":", "printf", "date"]);
const WORKTREE = /^(?:git\s+(?:-C\s+\S+\s+)?worktree\s+(?:add|list|prune)(?:\s|$))/;

const isRuling = (p: string): boolean => path.basename(p).toLowerCase() === "ruling.md";

function expand(w: string, c: ExemptCtx): string | null {
  let x = w;
  if (x === "~" || x.startsWith("~/")) x = path.join(c.home, x.slice(1));
  else if (x.startsWith("$HOME/") || x === "$HOME") x = path.join(c.home, x.slice(5));
  else if (x.startsWith("${HOME}/")) x = path.join(c.home, x.slice(7));
  if (/[$`]/.test(x)) return null;
  return path.resolve(c.cwd, x);
}

function ownedOrRuling(p: string, c: ExemptCtx): boolean {
  if (isRuling(p)) return true;
  return [...c.owned.readWrite, ...c.owned.readOnly].some((r) => underOwned(r, p, c.platform));
}

/** Path-like words: contain a separator, start with `~`, or are named ruling.md. */
const pathLike = (w: string): boolean => /[\\/]/.test(w) || w.startsWith("~") || isRuling(w);

/** Words of a shell segment without quotes; null when it holds a substitution or a redirect target we cannot judge. */
function words(seg: string): string[] | null {
  if (/\$\(|`/.test(seg)) return null;
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** 1 = exempt by its paths or worktree form, 0 = neutral, -1 = counts. */
function segmentVerdict(seg: string, c: ExemptCtx): 1 | 0 | -1 {
  const text = seg.trim();
  if (!text) return 0;
  if (WORKTREE.test(text)) return 1;
  const w = words(text);
  if (!w || w.length === 0) return -1;
  const operands = w.slice(1).filter((x) => !x.startsWith("-") && !/^[<>]|^\d?>/.test(x)).filter(pathLike);
  if (operands.length === 0) return NEUTRAL_VERBS.has(w[0]) ? 0 : -1;
  for (const o of operands) {
    const abs = expand(o, c);
    if (abs === null || !ownedOrRuling(abs, c)) return -1;
  }
  return 1;
}

/** A shell command, split into segments at `;`, `&&`, `||`, `|` and newlines. */
function bashExempt(command: string, c: ExemptCtx): boolean {
  let ok = false;
  for (const seg of command.split(/&&|\|\||[;|\n]/)) {
    const v = segmentVerdict(seg, c);
    if (v < 0) return false;
    if (v > 0) ok = true;
  }
  return ok;
}

/** Path-like string literals of a codemode script. */
function scriptExempt(code: string, c: ExemptCtx): boolean {
  const lits = [...code.matchAll(/["'`]([^"'`\n]*)["'`]/g)].map((m) => m[1]).filter((x) => pathLike(x) && !/\s/.test(x));
  if (lits.length === 0) return false;
  return lits.every((x) => {
    const abs = expand(x, c);
    return abs !== null && ownedOrRuling(abs, c);
  });
}

/** True when this read-class call is a handoff poll or a worktree creation and must not count as a re-check. */
export function recheckExempt(toolName: string, input: unknown, c: ExemptCtx): boolean {
  if (!input || typeof input !== "object") return false;
  const inp = input as Record<string, unknown>;
  if (toolName === "bash") return typeof inp.command === "string" && bashExempt(inp.command, c);
  if (toolName === "codemode") {
    const code = typeof inp.code === "string" ? inp.code : typeof inp.script === "string" ? inp.script : "";
    return code !== "" && scriptExempt(code, c);
  }
  if (toolName === "read" || toolName === "ls" || toolName === "grep" || toolName === "find") {
    const given = PATH_FIELDS.map((f) => inp[f]).filter((v): v is string => typeof v === "string" && v !== "");
    if (given.length === 0) return false;
    return given.every((g) => {
      const abs = expand(g, c);
      return abs !== null && ownedOrRuling(abs, c);
    });
  }
  return false;
}
