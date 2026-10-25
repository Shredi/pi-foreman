// Recheck-budget exemptions (ceremony.recheckBudget, harness-friction ledger item 4): a handoff poll
// (a read of the handoffs dir `<agentDir>/pi-foreman/handoffs`, ruling.md included) and a worktree
// creation/listing are not re-checks of the reviewed work. Pure: index.ts readBudgetCheck calls `recheckExempt`.
// A call is exempt only when every path operand it names is under the handoffs dir (and at least one is),
// or when it is `git worktree add|list|prune`; anything it cannot read with certainty (command
// substitution, an unknown variable) counts as before. Builders' worktrees and a ruling.md elsewhere count.
import * as path from "node:path";
import { handoffsRootOf, underOwned } from "./owned.ts";
import type { OwnedRoots } from "./owned.ts";

export interface ExemptCtx {
  cwd: string;
  home: string;
  platform: string;
  owned: OwnedRoots;
  /** R12 item 8: the session's own bg_run output dirs, `<root>/.pi/tasks/<session id>-*` (roundsurface.ts ownTaskReadable); other sessions' task dirs stay counted. */
  ownTasks?: string[];
}

const PATH_FIELDS = ["path", "file", "dir", "directory", "cwd"] as const;
const NEUTRAL_VERBS = new Set(["sleep", "echo", "true", ":", "printf", "date"]);
const WORKTREE = /^(?:git\s+(?:-C\s+\S+\s+)?worktree\s+(?:add|list|prune)(?:\s|$))/;
// R41 item 16: PR coordination and a default-branch sync are no re-check either. Plain words only (no quotes, `$`, redirects).
const PR_TOOLS: ReadonlySet<string> = new Set(["pr_status", "pr_checks", "pr_comments", "pr_watch"]);
const ARGS = String.raw`(?:\s+[A-Za-z0-9_./:=@%+,#-]+)*`;
const PR_VIEW = new RegExp(String.raw`^(?:gh|glab)\s+(?:pr|mr|run|ci)\s+(?:view|list|checks|status)${ARGS}$`);
const WORD = String.raw`[A-Za-z0-9_.:-]+`;
const PEER_READ = new RegExp(String.raw`^(?:herdr\s+(?:pane\s+read\s+${WORD}(?:\s+--lines(?:=|\s+)\d+)?|(?:agent|pane)\s+list)|(?:\S*/)?foreman\s+(?:session\s+list|worktree\s+sweep\s+--dry-run))$`);
const DEFAULT_BRANCH = String.raw`(?:main|master)`;
const GIT = String.raw`git(?:\s+-C\s+[A-Za-z0-9_./:=@%+,~-]+)?`;
const BRANCH_SYNC = new RegExp(String.raw`^${GIT}\s+(?:fetch(?:\s+origin(?:\s+${DEFAULT_BRANCH})?)?|pull\s+--ff-only(?:\s+origin(?:\s+${DEFAULT_BRANCH})?)?)$`);

function expand(w: string, c: ExemptCtx): string | null {
  let x = w;
  if (x === "~" || x.startsWith("~/")) x = path.join(c.home, x.slice(1));
  else if (x.startsWith("$HOME/") || x === "$HOME") x = path.join(c.home, x.slice(5));
  else if (x.startsWith("${HOME}/")) x = path.join(c.home, x.slice(7));
  if (/[$`]/.test(x)) return null;
  return path.resolve(c.cwd, x);
}

function ownedOrRuling(p: string, c: ExemptCtx): boolean {
  const root = handoffsRootOf(c.owned.readWrite);
  if (root && underOwned(root, p, c.platform)) return true;
  return (c.ownTasks ?? []).some((pat) => underTask(pat, p, c.platform));
}

/** `p` lies below a dir of the pattern `<tasks dir>/<prefix>*` (the one segment below the tasks dir starts with the prefix); also wait.ts checkLogPath. */
export function underTask(pat: string, p: string, platform: string): boolean {
  const impl = platform === "win32" ? path.win32 : path.posix;
  const fold = (x: string): string => (platform === "win32" || platform === "darwin" ? x.toLowerCase() : x);
  if (!pat.endsWith("*")) return false;
  const prefix = fold(impl.basename(pat).slice(0, -1));
  if (!prefix || prefix.includes("*")) return false;
  const base = fold(impl.resolve(impl.dirname(pat))).split(impl.sep);
  const t = fold(impl.resolve(p)).split(impl.sep);
  if (t.length <= base.length || !base.every((seg, n) => seg === t[n])) return false;
  return t[base.length].startsWith(prefix);
}

/** Path-like words: contain a separator or start with `~`. */
const pathLike = (w: string): boolean => /[\\/]/.test(w) || w.startsWith("~");

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
  if (WORKTREE.test(text) || PR_VIEW.test(text) || BRANCH_SYNC.test(text) || PEER_READ.test(text)) return 1;
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
  if (PR_TOOLS.has(toolName)) return true;
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
