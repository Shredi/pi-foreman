// R41 defaults (ledger item 4): named allow rules, evaluated per shell segment. A line is a default allow only when the floors
// found nothing (the caller ran lineFloors first), no segment is opaque and every segment matches a rule below. Anything else
// returns null and falls through to the review. Rule names: `default-<name>`.
import * as path from "node:path";
import { contained, effectCtx, gitReadWrites, GIT_READ, redirectOk, segmentEffect } from "./effects.ts";
import type { EffectCtx } from "./effects.ts";
import { injection } from "./floors.ts";
import { pathDecide, under } from "./pathrules.ts";
import type { GateRoots } from "./pathrules.ts";
import { webReadAllow } from "./webread.ts";
import type { ShellSegment } from "./shellast.ts";
import type { Redirect, Segment } from "./shellchain.ts";

/** Git facts the push and switch rules need; injected so tests stay hermetic. */
export interface GitFacts {
  currentBranch: (cwd: string) => string | null;
  /** Branches a push must never target: `main`, `master`, the remote HEAD, `safety.git.protectedBranches`. */
  protectedBranches: (cwd: string) => string[];
  /** True when `remote.*.push`, `remote.pushDefault` or `branch.*.pushRemote` is set (a push would not go where it says). */
  pushConfigured: (cwd: string) => boolean;
  /** r79: the branch has an upstream (a `commit --amend` rewrites published history). Absent: no amend is held back. */
  hasUpstream?: (cwd: string) => boolean;
  /** r79 item 3: branches checked out in the other (linked) worktrees of the repo; a plain push of one from a second worktree is as routine as the cwd branch. */
  ownBranches?: (cwd: string) => string[];
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
  "default-own-tool", "default-assign", "default-read", "default-build-test", "default-write-in",
  "default-git-read", "default-git-add", "default-git-commit", "default-git-fetch", "default-git-pull", "default-git-switch", "default-git-push", "default-gh-read",
  "default-role-launch",
] as const;

/**
 * Tools without a shell line: the own-tools enumeration. `fetch` has no default here (its built-in allow is `webReadAllow`). Undefined = no default.
 * r79 item 3: a role launch is a default only inside the owned roots; a `cwd` / `worktree` the roots do not cover (or any, when `roots` is not passed) is
 * `danger-launch-outside`.
 */
export function toolDefault(tool: string, input: unknown, opts: { child?: boolean; roots?: GateRoots; cwd?: string; platform?: string } = {}): string | undefined {
  if (OWN_TOOLS.has(tool)) return "default-own-tool";
  if (tool === "subagent" && opts.child === false && isRoleLaunch(input) && launchInside(input, opts.roots, opts.cwd, opts.platform)) return "default-role-launch";
  return undefined;
}

const LAUNCH_DIR_KEYS = ["cwd", "worktree", "workdir"] as const;

/** The `cwd` / `worktree` strings of a subagent launch. */
function launchDirs(input: unknown): string[] {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return LAUNCH_DIR_KEYS.map((k) => i[k]).filter((v): v is string => typeof v === "string" && v !== "");
}

/** Every named launch directory is in an owned root: the worktree, owned roots (sibling worktrees, state), scratch dirs, handoff dirs. No dir named = the session's own. */
function launchInside(input: unknown, roots: GateRoots | undefined, cwd: string = roots?.worktree ?? "", platform: string = process.platform): boolean {
  const dirs = launchDirs(input);
  if (dirs.length === 0) return true;
  if (!roots) return false;
  const owned = [roots.worktree, ...roots.owned, ...roots.scratch, ...roots.handoffs, ...(roots.openedHandoffs ?? [])];
  return dirs.every((d) => owned.some((r) => under(platform, r, d, cwd)));
}

/** The roles the foreman launches (ledger item 26). */
export const LAUNCH_ROLES: ReadonlySet<string> = new Set(["explorer", "builder", "reviewer"]);

/** A single launch of one named role: no `action` (management), no tasks / chain / workflow form. The adapter's role, ceremony and spawn gates run after the gate and can still refuse it. */
function isRoleLaunch(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const i = input as Record<string, unknown>;
  if (i.action !== undefined && i.action !== null && !(typeof i.action === "string" && i.action.trim() === "")) return false;
  if (i.tasks !== undefined || i.chain !== undefined || i.workflow !== undefined) return false;
  return typeof i.agent === "string" && LAUNCH_ROLES.has(i.agent);
}

const quote = (w: string): string => (/^[A-Za-z0-9_.\/,:@%+=^-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`);

/** The effect context of the session: the worktree root, scratch, tmp (when allowed) and the extra read roots of its role. */
export function effectCtxOf(c: Pick<DefaultCtx, "roots" | "platform" | "cwd">): EffectCtx {
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

/** The push shape: `git push [-u|--set-upstream] origin <own branch>|HEAD`, nothing else, never a protected branch. Own = the cwd branch or a branch of a linked worktree of the same repo. */
function pushOk(rest: string[], text: string, cwd: string, c: DefaultCtx): boolean {
  if (c.roots.child) return false;
  // a harmless env prefix is dropped by the walker; the push default wants none at all
  if (/(?:^|[\s;&|(])[A-Za-z_][A-Za-z0-9_]*=/.test(text)) return false;
  const a = [...rest];
  if (a[0] === "-u" || a[0] === "--set-upstream") a.shift();
  if (a.length !== 2 || a[0] !== "origin") return false;
  const cur = c.facts.currentBranch(cwd);
  const ref = a[1];
  if (!cur) return false;
  const target = ref === "HEAD" ? cur : ref;
  if (target !== cur && !(c.facts.ownBranches?.(cwd) ?? []).includes(target)) return false;
  if (!NAME.test(target)) return false;
  if (c.facts.protectedBranches(cwd).includes(target) || /^(?:main|master)$/.test(target)) return false;
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
      return commitOk(rest) && !(rest.includes("--amend") && c.facts.hasUpstream?.(cwd)) ? "default-git-commit" : null;
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
  gh: new Set(["run view", "run list", "run download", "pr view", "pr checks", "pr diff", "pr list", "pr status", "issue view", "issue list", "issue status", "repo view", "search prs", "search issues", "search repos", "search commits", "search code", "release view", "release list", "label list"]),
  glab: new Set(["mr view", "mr list", "mr diff", "ci status", "ci list", "ci view", "issue view", "issue list", "repo view", "release view", "release list", "label list"]),
};
const GH_FLAGS = new Set(["--log", "--log-failed", "--name-only", "--paginate", "-i", "--include", "--comments"]);
const GH_VALUES = new Set(["-R", "--repo", "--json", "-q", "--jq", "-L", "--limit", "-b", "--branch", "-s", "--state", "--author", "--job", "-j", "-n", "--name", "-D", "--dir", "--page", "--per-page"]);
const JQ_BAD = /env|import|include|input/i;
const POSITIONAL = /^[A-Za-z0-9_.\/#:@-]+$/;
const API_FIELD_OPTS = new Set(["-f", "-F", "--field", "--raw-field"]);
const API_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const API_VALUE = /^[A-Za-z0-9_.,:\/#-]*$/;
const API_QUERY = /^[A-Za-z0-9_ {}():,"]+$/;
const API_WRITE_WORD = /mutation|subscription/i;

/** Read-only gh/glab: a listed command, listed options (no input or header option; `api` takes `-X GET` and plain `key=value` fields only with `-X GET` or a literal graphql query without mutation), `run download` only into scratch. */
function ghDefault(prog: string, argv: string[], cwd: string, ec: EffectCtx): boolean {
  const api = argv[0] === "api";
  const key = api ? "api" : `${argv[0]} ${argv[1]}`;
  if (!api && !GH_CMDS[prog]?.has(key)) return false;
  const rest = argv.slice(api ? 1 : 2);
  const pos: string[] = [];
  let dir: string | null = null;
  let get = false;
  let query: string | null = null;
  let fields = 0;
  for (let i = 0; i < rest.length; i++) {
    let w = rest[i];
    let val: string | null = null;
    const eq = w.startsWith("--") ? w.indexOf("=") : -1;
    if (eq > 0) {
      val = w.slice(eq + 1);
      w = w.slice(0, eq);
    }
    if (GH_FLAGS.has(w) && val === null) continue;
    if (api && (w === "-X" || w === "--method")) {
      if (val === null) val = rest[++i] ?? null;
      if (val !== "GET") return false;
      get = true;
      continue;
    }
    if (api && API_FIELD_OPTS.has(w)) {
      if (val === null) val = rest[++i] ?? null;
      const kv = val === null ? -1 : val.indexOf("=");
      if (val === null || kv < 0) return false;
      const k = val.slice(0, kv);
      const v = val.slice(kv + 1);
      if (!API_KEY.test(k) || API_WRITE_WORD.test(v)) return false;
      if (k === "query") {
        if (query !== null || !API_QUERY.test(v) || !/^\s*(?:\{|query\b)/.test(v)) return false;
        query = v;
      } else if (!API_VALUE.test(v)) return false;
      fields++;
      continue;
    }
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
  if (api) {
    const f = apiFlags(rest);
    if (pos.length !== 1 || (f.method !== null && f.method !== "GET") || f.override !== null) return false;
    const gql = /^graphql$/i.test(pos[0]);
    if (/graphql/i.test(pos[0]) && !gql) return false;
    // a field makes gh send a POST unless the method is GET; graphql is a POST that is a read only for a literal query operation
    if (gql ? query === null : fields > 0 && !get) return false;
    if (query !== null && !gql) return false;
  }
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
  // r79 item 3: a segment of the dangerous class is never a built-in allow (the class is the question the classifier answers)
  if (dangerSegment(seg, { roots: c.roots, platform: c.platform, cwd: c.cwd, facts: c.facts }) !== null) return null;
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

// ------------------------------------------------------------------ the dangerous class (r79 item 3)
//
// Calls no rule decided and no built-in allow covers are safe under mode `auto`, unless one of these entries matches. A match goes to the
// classifier (mode auto), to the owner (mode ask) or runs (mode allow). The table is data: `name` and `reason` are what logs, dialogs and the
// classifier prompt show. No built-in allow above matches a dangerous call: `segmentDefault` returns null for a dangerous segment.

export interface DangerEnv {
  roots: GateRoots;
  platform: string;
  cwd: string;
  facts?: GitFacts;
}

/** What the dangerous class sees of a call. `segments` is the parse of a shell tool's line; `text` its raw text. */
export interface DangerCall {
  tool: string;
  input: unknown;
  segments?: ShellSegment[];
  text?: string;
}

export interface DangerRule {
  /** `danger-<name>`. */
  name: string;
  /** One line: why this class asks. */
  reason: string;
  test: (call: DangerCall, env: DangerEnv) => boolean;
}

export interface DangerHit {
  name: string;
  reason: string;
}

const progOf = (s: ShellSegment): string => (s.program.split(/[\\/]/).pop() ?? s.program).toLowerCase().replace(/\.exe$/, "");

/** The non-flag words of an argv; the flags in `valued` swallow the next word. */
function positionals(argv: string[], valued: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i];
    if (valued.has(w)) i++;
    else if (!w.startsWith("-")) out.push(w);
  }
  return out;
}

const live = (c: DangerCall): ShellSegment[] => (c.segments ?? []).filter((s) => s.opaque === null && s.program !== "");
const BASH_TOOL_NAMES: ReadonlySet<string> = new Set(["bash", "foreman_bg", "bg_run", "powershell"]);

/** An operand that names another machine: `host:path`, `user@host:path`, `ssh://`, `rsync://`. */
const remoteOperand = (w: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(w) || (!w.startsWith("-") && !/^[A-Za-z]:[\\/]/.test(w) && /^(?:[^@\s/:]+@)?[^\s/:@]+:/.test(w));

const KUBE = new Set(["kubectl", "oc"]);
const KUBE_VALUED = new Set(["-n", "--namespace", "--context", "--kubeconfig", "-s", "--server", "--cluster", "--user", "-l", "--selector", "-o", "--output"]);
const KUBE_READ = new Set(["get", "describe", "logs", "explain", "version"]);
const SYSTEMD_READ = new Set(["status", "list-units", "list-unit-files", "list-timers", "list-sockets", "list-dependencies", "show", "is-active", "is-enabled", "is-failed", "cat"]);
const LAUNCHCTL_READ = new Set(["list", "print", "print-disabled", "blame", "version", "help", "error"]);
const CLOUD = new Set(["gcloud", "aws", "az", "flyctl", "fly", "vercel", "netlify", "wrangler"]);
const CLOUD_BARE = new Set(["flyctl", "fly", "vercel", "netlify", "wrangler"]);
const CLOUD_READ = new Set(["describe", "get", "list", "ls", "show", "logs", "status", "whoami"]);
const CLOUD_WRITE = /^(?:delete|rm|remove|create|put|update|deploy|publish|push|apply|terminate|start|stop|run|invoke|cp|mv|sync|set|add|attach|detach|reboot|scale|promote|rollback|destroy|launch|import|up|down|restart|exec|ssh)$|^(?:delete|create|put|update|terminate|start|stop|run|invoke|remove)-/;
const HELPFLAG = (a: string[]): boolean => a.some((w) => /^(?:--help|-h|--version|-v|-V|version|help)$/.test(w));

function deploySeg(s: ShellSegment): boolean {
  const p = progOf(s);
  const a = s.argv;
  const pos = positionals(a, KUBE.has(p) ? KUBE_VALUED : new Set());
  if (p === "ssh") return !HELPFLAG(a);
  if (p === "scp" || p === "sftp" || p === "rsync") return a.some(remoteOperand);
  if (KUBE.has(p)) return pos.length > 0 && !KUBE_READ.has(pos[0]) && !(pos[0] === "config" && pos[1] === "view");
  if (p === "helm") return ["install", "upgrade", "uninstall", "rollback", "delete"].includes(pos[0]);
  if (p === "terraform" || p === "tofu") return ["apply", "destroy", "import"].includes(pos[0]);
  if (p === "pulumi") return ["up", "destroy"].includes(pos[0]);
  if (p.startsWith("ansible")) return true;
  if (p === "docker" || p === "podman" || p === "docker-compose") {
    const v = p === "docker-compose" ? ["compose", ...pos] : pos;
    return ["push", "run", "exec", "rm"].includes(v[0]) || (v[0] === "compose" && ["up", "down", "restart"].includes(v[1]));
  }
  if (p === "systemctl") return pos.length > 0 && !SYSTEMD_READ.has(pos[0]);
  if (p === "service") return pos.length >= 2 && pos[1] !== "status";
  if (p === "launchctl") return pos.length > 0 && !LAUNCHCTL_READ.has(pos[0]);
  if (p === "crontab") return a.includes("-e") || a.includes("-r") || positionals(a, new Set(["-u"])).length > 0;
  if (CLOUD.has(p)) {
    if (pos.length === 0) return CLOUD_BARE.has(p) && !HELPFLAG(a);
    const read = pos.some((w) => CLOUD_READ.has(w) || /^(?:describe|list|get)-/.test(w));
    return !read || pos.some((w) => CLOUD_WRITE.test(w));
  }
  return false;
}

const GH_VALUED = new Set(["-R", "--repo", "--hostname", "-b", "--branch", "-B", "--base", "-H", "--head", "-t", "--title", "--body", "-q", "--jq", "--json", "-L", "--limit", "-s", "--state", "-a", "--assignee", "-l", "--label", "-m", "--milestone", "-A", "--author", "-X", "--method", "-f", "-F", "--field", "--raw-field", "--input", "--template", "-D", "--dir", "-n", "--name", "-j", "--job", "--page", "--per-page", "--cache", "-p"]);
const GH_SAFE = new Set(["pr create", "pr view", "pr list", "pr diff", "pr checks", "pr status", "issue view", "issue list", "issue status", "label list", "repo view", "repo clone", "run view", "run list", "run watch", "run download", "release view", "release list", "release download", "auth status", "config get", "config list"]);
const GLAB_SAFE = new Set(["mr create", "mr view", "mr list", "mr diff", "ci status", "ci list", "ci view", "issue view", "issue list", "label list", "release view", "release list", "repo view", "repo clone", "auth status", "config get"]);

/** What the flags of a `gh api` / `glab api` call say; one parser for the dangerous class and the built-in read allow. */
export interface ApiFlags {
  /** The effective method, upper-cased: the LAST `-X` / `--method` wins (gh honours the last), null when none was given. */
  method: string | null;
  /** The method of an `X-HTTP-Method-Override` header (the last one), upper-cased. */
  override: string | null;
  /** Any `-f|-F|--field|--raw-field` (gh sends a POST for it unless the method is GET). */
  fields: boolean;
  input: boolean;
  /** The literal `query=` field value (the last), null when none. */
  query: string | null;
}

export function apiFlags(a: string[]): ApiFlags {
  const f: ApiFlags = { method: null, override: null, fields: false, input: false, query: null };
  const header = (v: string | undefined): void => {
    const m = v === undefined ? null : /^\s*x-http-method-override\s*:\s*(\S*)/i.exec(v);
    if (m) f.override = m[1].toUpperCase();
  };
  for (let i = 0; i < a.length; i++) {
    const w = a[i];
    if (w === "--") break;
    if (w === "-X" || w === "--method") f.method = (a[++i] ?? "").toUpperCase();
    else if (w.startsWith("--method=")) f.method = w.slice(9).toUpperCase();
    else if (/^-X.+/.test(w)) f.method = w.slice(2).toUpperCase();
    else if (w === "-H" || w === "--header") header(a[++i]);
    else if (w.startsWith("--header=")) header(w.slice(9));
    else if (/^-H.+/.test(w)) header(w.slice(2));
    else if (/^--input(?:=|$)/.test(w)) f.input = true;
    else {
      let v: string | undefined;
      if (/^(?:-f|-F|--field|--raw-field)$/.test(w)) v = a[++i];
      else if (/^--(?:field|raw-field)=/.test(w)) v = w.slice(w.indexOf("=") + 1);
      else if (/^-[fF].+/.test(w)) v = w.slice(2);
      else continue;
      f.fields = true;
      if (v !== undefined && v.startsWith("query=")) f.query = v.slice(6);
    }
  }
  return f;
}

/** `gh api` / `glab api` writes: a last method other than GET, a method-override header other than GET / HEAD, or fields / input (which make gh send a POST). */
function apiWrites(a: string[], graphql = false): boolean {
  const f = apiFlags(a);
  if (f.override !== null && f.override !== "GET" && f.override !== "HEAD") return true;
  if (graphql) return f.method !== null && f.method !== "GET" && f.method !== "POST" ? true : !graphqlRead(f);
  if (f.method !== null) return f.method !== "GET";
  return f.fields || f.input;
}

/**
 * A `gh api graphql` call is a read when its query is a literal `-f|-F|--field|--raw-field query=<text>` without the word `mutation`. A query from a
 * file (`--input`, `query=@file`) or no literal query is opaque, so it counts as a write.
 */
function graphqlRead(f: ApiFlags): boolean {
  const query = f.query;
  return !f.input && query !== null && query !== "" && !query.startsWith("@") && !/^\$|mutation/i.test(query);
}

function forgeSeg(s: ShellSegment): boolean {
  const p = progOf(s);
  if (p !== "gh" && p !== "glab") return false;
  const pos = positionals(s.argv, GH_VALUED);
  if (HELPFLAG(s.argv) && pos.length === 0) return false;
  if (pos.length === 0 || pos[0] === "help" || pos[0] === "version" || pos[0] === "status" || pos[0] === "search") return false;
  if (pos[0] === "api") return apiWrites(s.argv, pos[1] === "graphql");
  return !(p === "gh" ? GH_SAFE : GLAB_SAFE).has(`${pos[0]} ${pos[1] ?? ""}`);
}

function publishSeg(s: ShellSegment): boolean {
  const p = progOf(s);
  const pos = positionals(s.argv);
  if (["npm", "pnpm", "yarn", "bun"].includes(p)) return pos[0] === "publish" || (pos[0] === "npm" && pos[1] === "publish");
  if (p === "cargo") return pos[0] === "publish";
  if (p === "twine") return pos[0] === "upload";
  if (p === "gem") return pos[0] === "push";
  if (p === "docker" || p === "podman") return pos[0] === "push";
  if (p === "gh") return pos[0] === "release" && pos[1] === "upload";
  return false;
}

const METHOD_READ = new Set(["GET", "HEAD"]);

function netWriteSeg(s: ShellSegment): boolean {
  const p = progOf(s);
  const a = s.argv;
  if (["nc", "ncat", "netcat", "socat"].includes(p)) return true;
  if (p === "curl") {
    for (let i = 0; i < a.length; i++) {
      const w = a[i];
      const m = w === "-X" || w === "--request" || /^-[A-Za-z]*X$/.test(w) ? a[i + 1] : w.startsWith("--request=") ? w.slice(10) : /^-X.+/.test(w) ? w.slice(2) : undefined;
      if (m !== undefined && !METHOD_READ.has(m.toUpperCase())) return true;
      if (/^--(?:data(?:-[a-z]+)?|form(?:-string)?|upload-file|json)(?:=|$)/.test(w) || /^-[a-zA-Z]*[dFT]/.test(w) && !w.startsWith("--")) return true;
    }
    return false;
  }
  if (p === "wget") {
    for (let i = 0; i < a.length; i++) {
      const w = a[i];
      if (/^--(?:post-data|post-file|body-data|body-file)(?:=|$)/.test(w)) return true;
      const m = w === "--method" ? a[i + 1] : w.startsWith("--method=") ? w.slice(9) : undefined;
      if (m !== undefined && !METHOD_READ.has(m.toUpperCase())) return true;
    }
    return false;
  }
  if (p === "http" || p === "https" || p === "xh" || p === "xhs") {
    if (a.some((w) => /^(?:--form|-f|--json|-j|--multipart)$/.test(w))) return true;
    const pos = positionals(a);
    if (pos[0] !== undefined && /^[A-Za-z]+$/.test(pos[0]) && ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(pos[0].toUpperCase()) && !METHOD_READ.has(pos[0].toUpperCase())) return true;
    return pos.some((w) => /^[\w.-]+(?::=|=(?!=)|@)/.test(w));
  }
  return false;
}

const PKG = new Set(["npm", "pnpm", "yarn", "bun"]);
const PKG_VERBS = new Set(["install", "i", "ci", "add", "uninstall", "remove", "rm", "un"]);
const SYS_PKG = new Set(["apt", "apt-get", "dnf", "yum", "choco", "winget", "scoop"]);
const SYS_VERBS = new Set(["install", "remove", "uninstall", "purge", "upgrade", "autoremove", "reinstall", "erase", "add"]);
const BREW_READ = new Set(["list", "ls", "info", "search", "outdated", "deps", "uses", "leaves", "doctor", "config", "--prefix", "--version", "--cellar", "--repository"]);

function installSeg(s: ShellSegment): boolean {
  const p = progOf(s);
  const a = s.argv;
  const pos = positionals(a);
  if (PKG.has(p)) return PKG_VERBS.has(pos[0]) || pos[0] === "dlx" || (p === "yarn" && pos.length === 0 && !HELPFLAG(a));
  if (p === "npx" || p === "bunx" || p === "uvx") return true;
  if (p === "pip" || p === "pip3") return pos[0] === "install" || pos[0] === "uninstall";
  if (p === "uv") return pos[0] === "pip" && (pos[1] === "install" || pos[1] === "uninstall");
  if (/^python[0-9.]*$/.test(p)) return a[0] === "-m" && a[1] === "pip" && (a.includes("install") || a.includes("uninstall"));
  if (p === "cargo" || p === "gem") return pos[0] === "install" || pos[0] === "uninstall";
  if (p === "brew") return !(pos.length === 0 ? a.some((w) => BREW_READ.has(w)) : BREW_READ.has(pos[0]));
  if (SYS_PKG.has(p)) return SYS_VERBS.has(pos[0]);
  if (p === "pacman") return a.some((w) => /^-(?:S$|S[^sicgl]|R|U)/.test(w));
  return false;
}

const GIT_GLOBAL_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** The git subcommand and its words, past the global options. */
function gitParts(a: string[]): { sub: string | undefined; rest: string[] } {
  let i = 0;
  while (i < a.length && a[i].startsWith("-")) i += GIT_GLOBAL_VALUED.has(a[i]) ? 2 : 1;
  return { sub: a[i], rest: a.slice(i + 1) };
}

const URLISH = /:\/\/|^[^@\s/]+@[^:\s]+:|^file:|^[./~]|^[A-Za-z]:[\\/]/;
const PUSH_VALUED = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec", "--signed"]);

/**
 * A `git push` that only publishes the session's own branches: no URL remote, no tag, `--tags`, `--mirror`, `--all`, delete or colon refspec, and every
 * refspec `HEAD` or a branch that is the cwd branch or checked out in a linked worktree of the repo. `git push` and `git push origin` push the current branch.
 * Anything else is `danger-git` (the push floors deny force and protected-branch pushes before this question).
 */
function pushOwn(rest: string[], cwd: string, env: DangerEnv): boolean {
  if (rest.some((w) => w.startsWith("--repo=") && URLISH.test(w.slice(7)))) return false;
  if (rest.some((w) => /^--(?:tags|mirror|all|branches|delete|prune|follow-tags)$/.test(w) || /^-[A-Za-z]*d[A-Za-z]*$/.test(w))) return false;
  const pos = positionals(rest, PUSH_VALUED);
  const remote = pos[0];
  if (remote !== undefined && URLISH.test(remote)) return false;
  const refs = pos.slice(1);
  if (refs.length === 0) return true;
  const own = new Set([...(env.facts?.currentBranch(cwd) ? [env.facts.currentBranch(cwd) as string] : []), ...(env.facts?.ownBranches?.(cwd) ?? [])]);
  return refs.every((r) => {
    if (r === "HEAD") return true;
    if (r === "tag" || r.startsWith("+") || r.includes(":")) return false;
    return own.has(r.replace(/^refs\/heads\//, ""));
  });
}

function gitSeg(s: ShellSegment, env: DangerEnv): boolean {
  if (progOf(s) !== "git") return false;
  const { sub, rest } = gitParts(s.argv);
  const flag = (re: RegExp): boolean => rest.some((w) => re.test(w));
  switch (sub) {
    case "reset":
      return rest.includes("--hard");
    case "clean":
      return (flag(/^-[a-z]*f/) || rest.includes("--force")) && !(flag(/^-[a-z]*n/) || rest.includes("--dry-run"));
    case "checkout": {
      const dd = rest.indexOf("--");
      return (dd >= 0 && rest.length > dd + 1) || rest.includes(".") || rest.some((w) => ["-f", "--force", "--ours", "--theirs", "-p", "--patch"].includes(w));
    }
    case "restore":
      return !((rest.includes("--staged") || rest.includes("-S")) && !rest.includes("--worktree") && !rest.includes("-W"));
    case "branch":
      return flag(/^-[a-zA-Z]*[dD]/) || rest.includes("--delete");
    case "push":
      return !pushOwn(rest, s.cwd ?? env.cwd, env);
    case "rebase":
    case "filter-branch":
    case "filter-repo":
      return true;
    case "commit":
      return rest.includes("--amend") && env.facts?.hasUpstream?.(s.cwd ?? env.cwd) === true;
    case "stash":
      return rest[0] === "drop" || rest[0] === "clear";
    case "worktree":
      return rest[0] === "remove" || rest[0] === "prune";
    case "reflog":
      return rest[0] === "expire";
    case "gc":
      return flag(/^--prune(?:=|$)/);
    default:
      return false;
  }
}

const DETACH = new Set(["nohup", "setsid", "disown"]);
const detachSeg = (s: ShellSegment): boolean => DETACH.has(progOf(s)) || s.wrappers.some((w) => DETACH.has(w));

function processSeg(s: ShellSegment): boolean {
  const p = progOf(s);
  const a = s.argv;
  const pos = positionals(a);
  if (["kill", "pkill", "killall", "taskkill", "chown", "mount"].includes(p)) return true;
  if (p === "chmod") return a.some((w) => /^-[a-zA-Z]*R/.test(w) || w === "--recursive");
  if (p === "defaults") return pos[0] === "write" || pos[0] === "delete";
  if (p === "reg") return pos[0] === "add" || pos[0] === "delete";
  if (p === "launchctl") return pos[0] === "load" || pos[0] === "unload";
  return false;
}

function injectSeg(s: ShellSegment): boolean {
  return injection(s, progOf(s)) !== null;
}

const segs = (test: (s: ShellSegment, env: DangerEnv) => boolean) => (c: DangerCall, env: DangerEnv): boolean => live(c).some((s) => test(s, env));

/** A path tool that writes where no path rule allows (`pathDecide` found no root that covers it). */
function pathWriteOutside(c: DangerCall, env: DangerEnv): boolean {
  if (!["write", "edit", "foreman_move", "foreman_copy"].includes(c.tool)) return false;
  const i = (c.input && typeof c.input === "object" ? c.input : {}) as Record<string, unknown>;
  if (!["path", "file_path", "filePath", "dst"].some((k) => typeof i[k] === "string")) return false;
  return pathDecide(c.tool, c.input, env.cwd, env.roots, env.platform) === undefined;
}

/** Operands of a command: the words that are no option, past `--` all of them; the options in `valued` swallow the next word. */
function operands(a: string[], valued: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  let opts = true;
  for (let i = 0; i < a.length; i++) {
    const w = a[i];
    if (opts && w === "--") opts = false;
    else if (opts && valued.has(w)) i++;
    else if (!opts || !w.startsWith("-") || w === "-") out.push(w);
  }
  return out;
}

/** The values of an option given as `-t X`, `-tX`, `--long X` or `--long=X`. */
function optValues(a: string[], short: string[], long: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < a.length; i++) {
    const w = a[i];
    if (w === "--") break;
    if (short.includes(w) || long.includes(w)) {
      if (a[i + 1] !== undefined) out.push(a[++i]);
    } else if (long.some((l) => w.startsWith(`${l}=`))) out.push(w.slice(w.indexOf("=") + 1));
    else if (!w.startsWith("--") && short.some((s) => w.startsWith(s) && w.length > s.length)) out.push(w.slice(2));
  }
  return out;
}

const GIT_WRITE_SUBS = new Set(["commit", "add", "rm", "mv", "merge", "rebase", "reset", "checkout", "switch", "restore", "stash", "tag", "cherry-pick", "revert", "apply", "am", "pull", "fetch", "clone", "init", "clean", "worktree", "branch", "submodule", "config", "gc", "prune", "update-index", "update-ref", "notes", "bisect"]);
const PKG_READ_VERBS = new Set(["ls", "list", "ll", "la", "view", "info", "show", "search", "help", "config", "root", "prefix", "bin", "whoami", "outdated", "why", "explain", "docs", "licenses", "version", "-v", "--version"]);
const CODE_FLAG: Record<string, RegExp> = { python: /^-[A-Za-z]*c(?:.+)?$/, node: /^(?:-[A-Za-z]*[ep]|--eval(?:=.*)?|--print(?:=.*)?)$/, nodejs: /^(?:-[A-Za-z]*[ep]|--eval(?:=.*)?|--print(?:=.*)?)$/, bun: /^(?:-e|--eval(?:=.*)?|--print(?:=.*)?)$/, perl: /^-[A-Za-z]*[eE]$/, ruby: /^-[A-Za-z]*e$/, php: /^-[A-Za-z]*r$/, lua: /^-[A-Za-z]*e$/, rscript: /^-e$/ };

/** An interpreter run with code on its command line (`python3 -c`, `node -e`, `perl -e` ...): the code is not read by the gate. */
function inlineCode(s: ShellSegment): boolean {
  const p = progOf(s);
  if (p === "deno") return s.argv[0] === "eval";
  const key = /^python/.test(p) ? "python" : p.replace(/[0-9.]+$/, "");
  const re = CODE_FLAG[key];
  if (!re) return false;
  for (const w of s.argv) {
    if (key === "python" && (w === "-m" || !w.startsWith("-"))) return false;
    if (/\.(?:[cm]?js|ts|mts|cts|pl|rb|php|lua)$/.test(w)) return false;
    if (re.test(w)) return true;
  }
  return false;
}

/** The path words one segment writes (resolved against its cwd by the caller); `.` stands for the cwd itself. In-place and output-flag forms included. */
function writeTargets(s: ShellSegment): string[] {
  const p = progOf(s);
  const a = s.argv;
  switch (p) {
    case "sed": {
      const scripts = optValues(a, ["-e"], ["--expression"]);
      const files = operands(a, new Set(["-e", "-f", "--expression", "--file"])).filter((w) => w !== "");
      if (scripts.length === 0 && optValues(a, ["-f"], ["--file"]).length === 0 && files.length > 0) scripts.push(files.shift() as string);
      const inPlace = a.some((w) => w === "--in-place" || w.startsWith("--in-place=") || (!w.startsWith("--") && /^-[A-Za-z]*i/.test(w)));
      const wfiles: string[] = [];
      for (const sc of scripts) for (const m of sc.matchAll(/(?:^|[;{}\n/])\s*w\s*([^\s;}]+)/g)) wfiles.push(m[1]);
      return [...(inPlace ? files : []), ...wfiles];
    }
    case "truncate":
      return operands(a, new Set(["-s", "--size", "-r", "--reference"]));
    case "perl":
      return a.some((w) => /^-[pnla]*i/.test(w)) ? operands(a, new Set(["-e", "-E", "-I"])) : [];
    case "dd":
      return a.filter((w) => w.startsWith("of=")).map((w) => w.slice(3));
    case "sort":
      return optValues(a, ["-o"], ["--output"]);
    case "cp":
    case "mv":
    case "install":
    case "ln": {
      const t = optValues(a, ["-t"], ["--target-directory"]);
      const ops = operands(a, new Set(["-S", "--suffix", "-m", "--mode", "-o", "--owner", "-g", "--group", "-t", "--target-directory"]));
      if (p === "mv") return [...t, ...ops];
      if (t.length) return t;
      if (p === "install" && a.includes("-d")) return ops;
      if (p === "ln" && ops.length === 1) return ["."];
      return ops.length >= 2 ? [ops[ops.length - 1]] : [];
    }
    case "rm":
    case "rmdir":
    case "unlink":
    case "shred":
    case "mkdir":
    case "touch":
      return operands(a);
    case "awk":
    case "gawk": {
      const inplace = a.some((w, i) => w === "-iinplace" || w === "--include=inplace" || ((w === "-i" || w === "--include") && a[i + 1] === "inplace"));
      if (!inplace) return [];
      const ops = operands(a, new Set(["-f", "-v", "-F", "-i", "--include", "-e"]));
      return optValues(a, ["-f"], ["--file"]).length ? ops : ops.slice(1);
    }
    case "patch": {
      const dir = optValues(a, ["-d"], ["--directory"]);
      const out = optValues(a, ["-o"], ["--output"]);
      const files = operands(a, new Set(["-d", "--directory", "-o", "--output", "-i", "--input", "-r", "--reject-file", "-p", "--strip", "-B", "-V", "-Y", "-z", "-F"]));
      return [...(dir.length ? dir : ["."]), ...out, ...files];
    }
    case "rsync": {
      const ops = operands(a, new Set(["-e", "--rsh", "--exclude", "--include", "--exclude-from", "--include-from", "--files-from", "--filter", "-f"]));
      return ops.length >= 2 ? [ops[ops.length - 1]] : [];
    }
    case "tar":
      return a.some((w) => /^-[A-Za-z]*x|^--extract$|^--get$/.test(w)) || /^[A-Za-z]*x/.test(a[0] ?? "") ? [...optValues(a, ["-C"], ["--directory"]), "."] : [];
    case "unzip":
      return [...optValues(a, ["-d"], []), "."];
    case "git": {
      const { sub, rest } = gitParts(a);
      if (sub === undefined || !GIT_WRITE_SUBS.has(sub)) return [];
      const head = a.slice(0, a.indexOf(sub));
      const extra = [...optValues(head, [], ["--git-dir", "--work-tree"])];
      if ((sub === "clone" || sub === "init") && operands(rest).length >= (sub === "clone" ? 2 : 1)) extra.push(operands(rest)[operands(rest).length - 1]);
      return [".", ...extra];
    }
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun": {
      const prefix = optValues(a, p === "pnpm" ? ["-C"] : [], ["--prefix", "--dir", "--cwd", "--workspace-root"]);
      if (prefix.length) return prefix;
      const verb = operands(a, new Set(["--prefix", "--dir", "--cwd", "-w", "--workspace"]))[0];
      return verb !== undefined && PKG_READ_VERBS.has(verb) ? [] : a.some((w) => PKG_READ_VERBS.has(w) && w.startsWith("-")) ? [] : ["."];
    }
    case "make":
      return [...optValues(a, ["-C"], ["--directory"]), "."];
    case "cargo":
    case "go": {
      const verb = operands(a)[0];
      const write = p === "cargo" ? ["build", "test", "run", "clean", "install", "add", "remove", "update", "fmt", "fix", "init", "new", "bench", "doc"] : ["build", "test", "run", "install", "get", "mod", "generate", "clean", "fmt"];
      if (verb === undefined || !write.includes(verb)) return [];
      return [".", ...optValues(a, p === "go" ? ["-C"] : [], ["--manifest-path", "--target-dir"]).map((w) => (w.endsWith("Cargo.toml") ? w.slice(0, -10) || "." : w))];
    }
    default:
      return [];
  }
}

const SINK = new Set(["-", "/dev/null", "/dev/stdout", "/dev/stderr", ""]);

/** The write target `w` (run from `cwd`) lies where the path rules allow a write: the worktree, scratch, and (outside children) the OS temp dir. */
function writable(w: string, cwd: string | null, env: DangerEnv): boolean {
  if (SINK.has(w)) return true;
  if (cwd === null && !path.isAbsolute(w) && !path.win32.isAbsolute(w)) return false;
  return pathDecide("write", { path: w }, cwd ?? env.cwd, env.roots, env.platform) !== undefined;
}

/** A shell segment that writes (a redirect, an in-place or output-flag form, a write-class effect) outside the worktree, scratch and tmp. */
function shellWriteOutside(c: DangerCall, env: DangerEnv): boolean {
  const ec = effectCtxOf(env);
  for (const s of live(c)) if (writeTargets(s).some((w) => !writable(w, s.cwd, env))) return true;
  for (const s of live(c)) {
    const cwd = s.cwd ?? env.cwd;
    const chain = toChain(s);
    if (!chain) continue;
    for (const r of chain.redirects) if (r.op !== "<" && r.op !== "dup" && !redirectOk(r, ec, cwd, ec.scratch ?? [], env.platform) && !contained(ec, cwd, r.target, true)) return true;
    // the redirects are judged above; the effect class of the words alone (a redirect into the worktree is write-out to segmentEffect)
    if (segmentEffect(ec, cwd, { ...chain, redirects: [] }).cls === "write-out") return true;
  }
  return false;
}

const MCP_READ = /^(?:list|get|search|read|take|find|describe)_/;

/** An `mcp__server__tool` call that is not named as a read; `navigate_page` to a plain URL is a read. */
function mcpAct(c: DangerCall): boolean {
  if (!c.tool.startsWith("mcp__")) return false;
  const name = c.tool.split("__").slice(2).join("__") || c.tool;
  if (MCP_READ.test(name)) return false;
  if (name === "navigate_page") {
    const i = (c.input && typeof c.input === "object" ? c.input : {}) as Record<string, unknown>;
    const type = i.type === undefined ? "url" : i.type;
    if (type === "back" || type === "forward" || type === "reload") return false;
    return !(type === "url" && typeof i.url === "string" && /^https?:\/\/[^/?#@\s]*(?:[/?#]|$)/i.test(i.url));
  }
  return true;
}

/** A role launch outside the owned roots, a workflow script, or a tasks / chain form. Management actions are no launch. */
function launchOutside(c: DangerCall, env: DangerEnv): boolean {
  if (c.tool !== "subagent") return false;
  const i = (c.input && typeof c.input === "object" ? c.input : {}) as Record<string, unknown>;
  if (i.action !== undefined && i.action !== null && !(typeof i.action === "string" && i.action.trim() === "")) return false;
  if (i.tasks !== undefined || i.chain !== undefined || i.workflow !== undefined) return true;
  return !launchInside(c.input, env.roots, env.cwd, env.platform);
}

/** `fetch` / `curl` / `wget` that webReadAllow does not pass (S5: the finding-6 fixes decide between silent allow and the classifier). */
function webNotRead(c: DangerCall, env: DangerEnv): boolean {
  const cmd = (c.input && typeof c.input === "object" ? (c.input as Record<string, unknown>).command : undefined) as unknown;
  if (c.tool !== "fetch" && !(BASH_TOOL_NAMES.has(c.tool) && typeof cmd === "string")) return false;
  const v = webReadAllow(c.tool, c.input, { cwd: env.cwd, scratch: env.roots.scratch, platform: env.platform });
  return v.candidate && !v.ok;
}

const detached = (c: DangerCall): boolean => !!c.text && BASH_TOOL_NAMES.has(c.tool) && c.tool !== "bg_run" && c.tool !== "foreman_bg" && /(?:^|[^&\\])&\s*$/.test(c.text.trim());

export const DANGER_RULES: readonly DangerRule[] = [
  { name: "danger-write-outside", reason: "writes files outside the worktree, the session's scratch dir and the OS temp dir", test: (c, e) => pathWriteOutside(c, e) || shellWriteOutside(c, e) },
  { name: "danger-deploy", reason: "reaches another machine or changes a deployment, cluster, service or cloud account", test: segs(deploySeg) },
  { name: "danger-forge", reason: "changes something on the code forge (merge, close, comment, create or delete, a non-GET API call)", test: segs(forgeSeg) },
  { name: "danger-publish", reason: "publishes a package, image or release", test: segs(publishSeg) },
  { name: "danger-net-write", reason: "sends data over the network (a method other than GET or HEAD, a body, an upload, a raw socket, or a download with credentials or an unsafe target)", test: (c, e) => segs(netWriteSeg)(c, e) || webNotRead(c, e) },
  { name: "danger-install", reason: "installs, runs or removes software from a package registry", test: segs(installSeg) },
  { name: "danger-git", reason: "changes git history or discards work (hard reset, clean, discarding checkout or restore, branch delete, push to a URL, rebase, amend of published work, stash drop, worktree removal, history rewrite)", test: segs(gitSeg) },
  { name: "danger-process", reason: "controls processes or system settings (kill, recursive chmod, chown, mount, defaults write, registry edits, detaching a process)", test: (c, e) => segs(processSeg)(c, e) || (c.tool !== "bg_run" && c.tool !== "foreman_bg" && segs(detachSeg)(c, e)) || detached(c) },
  { name: "danger-inject", reason: "types text into another terminal pane, which another session reads as its own input", test: segs(injectSeg) },
  { name: "danger-opaque", reason: "the shell line cannot be read exactly (substitution, eval, an unknown variable, an unparsed form or an interpreter one-liner such as python -c or node -e)", test: (c, e) => (c.segments ?? []).some((s) => s.opaque !== null) || segs(inlineCode)(c, e) },
  { name: "danger-mcp-act", reason: "an MCP tool that acts on an outside system (its name is not a read)", test: (c) => mcpAct(c) },
  { name: "danger-launch-outside", reason: "launches a session in a directory outside the owned roots, or a workflow script, tasks or chain", test: (c, e) => launchOutside(c, e) },
];

/** True when the call writes outside the worktree and the session's scratch (the `danger-write-outside` entry on its own; gate.ts childDenied). */
export function writesOutside(call: DangerCall, env: DangerEnv): boolean {
  return pathWriteOutside(call, env) || shellWriteOutside(call, env);
}

/** `gh pr create`, `glab mr create`: opens a pull or merge request. */
export function createsPullRequest(segments: ShellSegment[]): boolean {
  return segments.some((s) => {
    const p = progOf(s);
    const pos = positionals(s.argv, GH_VALUED);
    return (p === "gh" && pos[0] === "pr" && pos[1] === "create") || (p === "glab" && pos[0] === "mr" && pos[1] === "create");
  });
}

/** The first dangerous-class entry a call falls into, or null. */
export function dangerMatch(call: DangerCall, env: DangerEnv): DangerHit | null {
  for (const r of DANGER_RULES) if (r.test(call, env)) return { name: r.name, reason: r.reason };
  return null;
}

const SEGMENT_RULES = [deploySeg, forgeSeg, publishSeg, netWriteSeg, installSeg, gitSeg, (s: ShellSegment) => processSeg(s) || detachSeg(s), injectSeg] as const;

/** The `danger-*` name of a single non-opaque segment (every entry that needs no path facts), or null. `segmentDefault` refuses such a segment. */
export function dangerSegment(seg: ShellSegment, env: DangerEnv): string | null {
  if (seg.opaque !== null || seg.program === "") return null;
  const names = ["danger-deploy", "danger-forge", "danger-publish", "danger-net-write", "danger-install", "danger-git", "danger-process", "danger-inject"];
  const i = SEGMENT_RULES.findIndex((f) => f(seg, env));
  return i < 0 ? null : names[i];
}
