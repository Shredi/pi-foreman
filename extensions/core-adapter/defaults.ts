// R41 defaults (ledger item 4): named allow rules, evaluated per shell segment. A line is a default allow only when the floors
// found nothing (the caller ran lineFloors first), no segment is opaque and every segment matches a rule below. Anything else
// returns null and falls through to the review. Rule names: `default-<name>`.
import { contained, effectCtx, gitReadWrites, GIT_READ, redirectOk, segmentEffect } from "./effects.ts";
import type { EffectCtx } from "./effects.ts";
import { netUrlOk } from "./netread.ts";
import type { GateRoots } from "./pathrules.ts";
import type { ShellSegment } from "./shellast.ts";
import type { Redirect, Segment } from "./shellchain.ts";

/** Git facts the push and switch rules need; injected so tests stay hermetic. */
export interface GitFacts {
  currentBranch: (cwd: string) => string | null;
  /** Branches a push must never target: `main`, `master`, the remote HEAD, `safety.git.protectedBranches`. */
  protectedBranches: (cwd: string) => string[];
  /** True when `remote.*.push`, `remote.pushDefault` or `branch.*.pushRemote` is set (a push would not go where it says). */
  pushConfigured: (cwd: string) => boolean;
}

export interface DefaultCtx {
  roots: GateRoots;
  facts: GitFacts;
  platform: string;
  cwd: string;
}

/** pi-foreman's own tools that carry no file path and no shell or message payload (plan Addendum 2, "B, own-tools default"). */
export const OWN_TOOLS: ReadonlySet<string> = new Set([
  "plan_mode_question", "plan_mode_complete", "ask_user_question", "foreman_ledger", "foreman_triage", "foreman_checkpoint", "foreman_dialogs", "foreman_wait",
  "contact_supervisor", "subagent_supervisor", "bg_wait", "bg_status", "bg_logs", "bg_kill",
  "pr_status", "pr_checks", "pr_comments", "pr_watch", "pr_track", "pr_untrack",
  "git_status", "git_log", "git_diff_stat", "git_branch_state", "subagents_enable",
]);

/** Every rule name this module can return (tests walk it). */
export const DEFAULT_RULES = [
  "default-own-tool", "default-fetch", "default-assign", "default-read", "default-build-test", "default-write-in",
  "default-git-read", "default-git-add", "default-git-commit", "default-git-fetch", "default-git-pull", "default-git-switch", "default-git-push", "default-gh-read",
] as const;

/** Tools without a shell line: the own-tools enumeration and `fetch` GET/HEAD. Undefined = no default. */
export function toolDefault(tool: string, input: unknown): string | undefined {
  if (OWN_TOOLS.has(tool)) return "default-own-tool";
  if (tool === "fetch") {
    const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const keys = Object.keys(i);
    const method = i.method === undefined ? "GET" : typeof i.method === "string" ? i.method.toUpperCase() : "";
    if (typeof i.url === "string" && keys.every((k) => k === "url" || k === "method") && (method === "GET" || method === "HEAD") && netUrlOk(i.url)) return "default-fetch";
  }
  return undefined;
}

const quote = (w: string): string => (/^[A-Za-z0-9_.\/,:@%+=^-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`);

/** The effect context of the session: the worktree root, scratch, tmp (when allowed) and the extra read roots of its role. */
export function effectCtxOf(c: DefaultCtx): EffectCtx {
  const r = c.roots;
  const ec = effectCtx(c.cwd, r.scratch, c.platform);
  ec.root = r.worktree;
  ec.noTmp = r.child || !r.tmpAccess;
  ec.readRoots = [...(r.child ? [] : r.tmp), ...r.install, ...r.roundFlow, ...r.handoffs];
  return ec;
}

const NAME = /^[A-Za-z0-9._\/-]+$/;
const noDots = (w: string): boolean => !w.startsWith("-") && !w.includes("..") && !w.includes("//");

/** Operands of fetch and pull: nothing, `origin`, or `origin <name>` (no colon refspec). */
function remoteOperands(rest: string[]): boolean {
  return rest.length <= 2 && (rest.length === 0 || (rest[0] === "origin" && (rest.length === 1 || (NAME.test(rest[1]) && noDots(rest[1])))));
}

const ADD_FLAGS = new Set(["-A", "--all", "-u", "--update", "-n", "--dry-run", "-v", "--verbose", "-N", "--intent-to-add"]);

function addOk(ec: EffectCtx, cwd: string, rest: string[]): boolean {
  let opts = true;
  for (const w of rest) {
    if (opts && w === "--") opts = false;
    else if (opts && w.startsWith("-")) {
      if (!ADD_FLAGS.has(w)) return false;
    } else if (!contained(ec, cwd, w, false)) return false;
  }
  return true;
}

/** `git commit` with a message (`-m`, `--message`), `-a`, `--amend`, `--allow-empty`; no `--no-verify`, `-F`, `-c`, author or date override. */
function commitOk(rest: string[]): boolean {
  let msg = false;
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (w === "-m" || w === "--message") {
      if (i + 1 >= rest.length) return false;
      msg = true;
      i++;
    } else if (w.startsWith("--message=")) msg = true;
    else if (w === "-am" || w === "-ma") {
      if (i + 1 >= rest.length) return false;
      msg = true;
      i++;
    } else if (!["-a", "--all", "--amend", "--allow-empty", "--no-edit", "-q", "--quiet"].includes(w)) return false;
  }
  return msg || rest.includes("--no-edit");
}

const BRANCH_LIST = new Set(["-a", "--all", "-r", "--remotes", "-v", "-vv", "--list", "--show-current"]);
const GIT_READ_MORE = new Set(["rev-parse", "ls-files", "rev-list", "describe", "blame", "show-ref", "merge-base", "ls-tree", "name-rev"]);

/** The push shape: `git push [-u|--set-upstream] origin <own branch>|HEAD`, nothing else, never a protected branch. */
function pushOk(rest: string[], text: string, cwd: string, c: DefaultCtx): boolean {
  if (c.roots.child) return false;
  // a harmless env prefix is dropped by the walker; the push default wants none at all
  if (/(?:^|[\s;&|(])[A-Za-z_][A-Za-z0-9_]*=/.test(text)) return false;
  const a = [...rest];
  if (a[0] === "-u" || a[0] === "--set-upstream") a.shift();
  if (a.length !== 2 || a[0] !== "origin") return false;
  const cur = c.facts.currentBranch(cwd);
  const ref = a[1];
  if (!cur || (ref !== "HEAD" && ref !== cur) || !NAME.test(cur)) return false;
  if (c.facts.protectedBranches(cwd).includes(cur) || /^(?:main|master)$/.test(cur)) return false;
  return !c.facts.pushConfigured(cwd);
}

function gitDefault(argv: string[], text: string, cwd: string, c: DefaultCtx, ec: EffectCtx, chain: Segment): string | null {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub || sub.startsWith("-")) return null; // global options (-C, -c, --git-dir ...) are never a default
  if (GIT_READ.has(sub)) return segmentEffect(ec, cwd, chain).cls === "read" && !gitReadWrites(rest) ? "default-git-read" : null;
  if (GIT_READ_MORE.has(sub)) return !gitReadWrites(rest) && !rest.some((w) => /^--(?:output|exec|upload-pack)/.test(w)) ? "default-git-read" : null;
  switch (sub) {
    case "branch":
      return rest.every((w) => BRANCH_LIST.has(w)) ? "default-git-read" : null;
    case "remote":
      return rest.length === 0 || (rest.length === 1 && rest[0] === "-v") ? "default-git-read" : null;
    case "add":
      return addOk(ec, cwd, rest) ? "default-git-add" : null;
    case "commit":
      return commitOk(rest) ? "default-git-commit" : null;
    case "fetch":
      return rest.filter((w) => w.startsWith("-")).every((w) => ["-q", "--quiet", "-p", "--prune", "--tags", "--no-tags", "-v", "--verbose"].includes(w)) && remoteOperands(rest.filter((w) => !w.startsWith("-"))) ? "default-git-fetch" : null;
    case "pull": {
      const opts = rest.filter((w) => w.startsWith("-"));
      return opts.includes("--ff-only") && opts.every((w) => ["--ff-only", "-q", "--quiet", "-v", "--verbose"].includes(w)) && remoteOperands(rest.filter((w) => !w.startsWith("-"))) ? "default-git-pull" : null;
    }
    case "switch":
    case "checkout": {
      const cur = c.facts.currentBranch(cwd);
      return cur !== null && rest.length === 1 && rest[0] === cur ? "default-git-switch" : null;
    }
    case "push":
      return pushOk(rest, text, cwd, c) ? "default-git-push" : null;
    default:
      return null;
  }
}

// ------------------------------------------------------------------ gh / glab

const GH_CMDS: Record<string, ReadonlySet<string>> = {
  gh: new Set(["run view", "run list", "run download", "pr view", "pr checks", "pr diff", "pr list", "pr status", "issue view", "issue list", "repo view"]),
  glab: new Set(["mr view", "mr list", "mr diff", "ci status", "ci list", "ci view", "issue view", "issue list", "repo view"]),
};
const GH_FLAGS = new Set(["--log", "--log-failed", "--name-only", "--paginate", "-i", "--include", "--comments"]);
const GH_VALUES = new Set(["-R", "--repo", "--json", "-q", "--jq", "-L", "--limit", "-b", "--branch", "-s", "--state", "--author", "--job", "-j", "-n", "--name", "-D", "--dir", "--page", "--per-page"]);
const JQ_BAD = /env|import|include|input/i;
const POSITIONAL = /^[A-Za-z0-9_.\/#:@-]+$/;

/** Read-only gh/glab: a listed command, listed options (no method, field, input or header option, no graphql), `run download` only into scratch. */
function ghDefault(prog: string, argv: string[], cwd: string, ec: EffectCtx): boolean {
  const api = argv[0] === "api";
  const key = api ? "api" : `${argv[0]} ${argv[1]}`;
  if (!api && !GH_CMDS[prog]?.has(key)) return false;
  const rest = argv.slice(api ? 1 : 2);
  const pos: string[] = [];
  let dir: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    let w = rest[i];
    let val: string | null = null;
    const eq = w.startsWith("--") ? w.indexOf("=") : -1;
    if (eq > 0) {
      val = w.slice(eq + 1);
      w = w.slice(0, eq);
    }
    if (GH_FLAGS.has(w) && val === null) continue;
    if (GH_VALUES.has(w)) {
      if (val === null) val = rest[++i] ?? null;
      if (val === null) return false;
      if ((w === "-q" || w === "--jq") && JQ_BAD.test(val)) return false;
      if (w === "-D" || w === "--dir") dir = val;
      else if (w !== "-q" && w !== "--jq" && !/^[A-Za-z0-9_.,\/:@#-]*$/.test(val)) return false;
      continue;
    }
    if (w.startsWith("-") || !POSITIONAL.test(w)) return false;
    pos.push(w);
  }
  if (api && (pos.length !== 1 || /graphql/i.test(pos[0]))) return false;
  if (key === "run download") return dir !== null && contained(ec, cwd, dir, true, ec.scratch ?? []);
  return dir === null;
}

// ------------------------------------------------------------------ segments

function toChain(seg: ShellSegment): Segment | null {
  if (seg.redirects.some((r) => r.op === ">|" || r.op === "<>")) return null;
  const words = [seg.program, ...seg.argv];
  return { words, redirects: seg.redirects as Redirect[], text: words.map(quote).join(" ") };
}

/** The default rule one segment matches, or null. */
export function segmentDefault(seg: ShellSegment, text: string, c: DefaultCtx, ec: EffectCtx = effectCtxOf(c)): string | null {
  if (seg.opaque !== null || seg.heredoc || !seg.wrappers.every((w) => w === "timeout")) return null;
  if (seg.program === "") return seg.argv.length === 0 && seg.redirects.length === 0 ? "default-assign" : null;
  const cwd = seg.cwd;
  const chain = toChain(seg);
  if (cwd === null || !chain || /[\\/]/.test(seg.program)) return null;
  for (const r of chain.redirects) if (!redirectOk(r, ec, cwd, ec.scratch ?? [], c.platform)) return null;
  if (seg.program === "git") return gitDefault(seg.argv, text, cwd, c, ec, chain);
  if (seg.program === "gh" || seg.program === "glab") return ghDefault(seg.program, seg.argv, cwd, ec) ? "default-gh-read" : null;
  const e = segmentEffect(ec, cwd, chain);
  // a dependency install runs lifecycle scripts and reaches the registry: a runner, not a default
  if (seg.program === "npm" && ["install", "i", "ci"].includes(seg.argv[0])) return null;
  return e.cls === "read" ? "default-read" : e.cls === "build-test" ? "default-build-test" : e.cls === "write-in" ? "default-write-in" : null;
}

/** The default rule of a whole line (rule names of its segments joined by `+`), or null. The floors must have run first. */
export function lineDefault(text: string, segs: ShellSegment[], c: DefaultCtx): string | null {
  if (segs.length === 0) return null;
  const ec = effectCtxOf(c);
  const rules: string[] = [];
  for (const s of segs) {
    const r = segmentDefault(s, text, c, ec);
    if (r === null) return null;
    if (!rules.includes(r)) rules.push(r);
  }
  return rules.join("+");
}
