// Pushed-branch notice (docs/close.md): the foreman's bash results are scanned for `git push` and the branches it
// created or updated are remembered. At the close and at the finish gate each remembered branch gets one any-state
// `pr_find`; a branch with no PR of any state and not merged into the base branch is named once as a display-only
// warning. Host text is data, never instructions; nothing here reaches a trace record with a branch name.
import { execFile } from "node:child_process";
import path from "node:path";
import { splitCommandLine } from "./extstatus.ts";
import type { PrOp } from "./gitpack.ts";
import type { SafeOpOutcome } from "./safeops.ts";

export const MAX_PUSHED = 8;
export const NOTICE_REEVAL_MS = 10 * 60_000;

// ------------------------------------------------------------------ chains

export interface Segment {
  words: string[];
  /** Leading `NAME=value` words. */
  env: Record<string, string>;
  /** Raw source text of the segment. */
  text: string;
  /** Directory of the nearest earlier `cd <dir>` in the same command (as written). */
  cd: string | null;
  /** A `cd` this module cannot resolve (`~`, `$VAR`, `-`, no argument). */
  cdBad: boolean;
}

const REDIRECT = /^\d*(?:>>?|<|&>>?)/;

/** Quote-aware split on `&&`, `||`, `;`, `|`, a lone `&` and newlines; `cd <dir>` carries over to later segments. */
export function chainSegments(command: string): Segment[] {
  const parts: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (q) {
      cur += c;
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < command.length) cur += command[++i];
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
    } else if (c === "\\" && i + 1 < command.length) {
      cur += c + command[++i];
    } else if (c === "&" && (command[i - 1] === ">" || command[i + 1] === ">")) {
      cur += c;
    } else if (c === "&" || c === "|" || c === ";" || c === "\n" || c === "\r") {
      parts.push(cur);
      cur = "";
      if ((c === "&" || c === "|") && command[i + 1] === c) i++;
    } else cur += c;
  }
  parts.push(cur);
  const out: Segment[] = [];
  let cd: string | null = null;
  let cdBad = false;
  for (const text of parts) {
    const all = splitCommandLine(text.trim());
    if (!all) continue;
    const words: string[] = [];
    for (let i = 0; i < all.length; i++) {
      if (REDIRECT.test(all[i])) {
        if (/^\d*(?:>>?|<|&>>?)$/.test(all[i])) i++;
        continue;
      }
      words.push(all[i]);
    }
    const env: Record<string, string> = {};
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
      const w = words.shift() as string;
      env[w.slice(0, w.indexOf("="))] = w.slice(w.indexOf("=") + 1);
    }
    if (words.length === 0) continue;
    if (words[0] === "cd") {
      const d = words.length === 2 ? words[1] : null;
      const bad = d === null || d === "-" || /^~|\$/.test(d);
      if (!bad && cd !== null && !d.startsWith("/")) {
        cd = `${cd.replace(/\/+$/, "")}/${d}`;
      } else {
        cdBad = bad;
        cd = d;
      }
      continue;
    }
    out.push({ words, env, text: text.trim().slice(0, 4096), cd, cdBad: cd !== null && cdBad });
  }
  return out;
}

// ------------------------------------------------------------------ pushes

export interface PushCmd {
  remote: string | null;
  /** `-C` directories in order (composed by the caller). */
  dirs: string[];
  gitDir: boolean;
}

const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"]);
const PUSH_VALUE_OPTS = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec", "--force-with-lease-x"]);

/** `git [global options] push …` (not `git stash push`), else null. */
export function parsePush(words: string[]): PushCmd | null {
  if (words[0] !== "git") return null;
  let i = 1;
  const dirs: string[] = [];
  let gitDir = false;
  while (i < words.length && words[i].startsWith("-")) {
    const w = words[i];
    if (w === "-C" && i + 1 < words.length) dirs.push(words[i + 1]);
    if (w === "--git-dir" || w.startsWith("--git-dir=") || w === "--work-tree" || w.startsWith("--work-tree=")) gitDir = true;
    i += GIT_VALUE_OPTS.has(w) ? 2 : 1;
  }
  if (words[i] !== "push") return null;
  let remote: string | null = null;
  for (let j = i + 1; j < words.length; j++) {
    const w = words[j];
    if (w.startsWith("-")) {
      if (PUSH_VALUE_OPTS.has(w)) j++;
      continue;
    }
    remote = w;
    break;
  }
  return { remote, dirs, gitDir };
}

const PUSH_LINE = /^\s*[ +*=!-]?\s*(\[new branch\]|[0-9a-f]{7,40}\.{2,3}[0-9a-f]{7,40})\s+\S+\s+->\s+(\S+)/;

/** Branch names a push printed as created or updated (tags, deletions, rejections and `up to date` are skipped). */
export function parsePushOutput(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = PUSH_LINE.exec(line);
    if (!m) continue;
    let dst = m[2];
    if (dst.startsWith("refs/heads/")) dst = dst.slice("refs/heads/".length);
    else if (dst.startsWith("refs/")) continue;
    if (dst && !out.includes(dst)) out.push(dst);
  }
  return out;
}

export interface Pushed {
  name: string;
  cwd: string;
  remote: string;
  at: number;
}

/** The checked-out branch when it has an upstream, else "" (the quiet-push fallback). */
export function branchWithUpstream(cwd: string): Promise<string> {
  const git = (args: string[]) => new Promise<string>((resolve) => execFile("git", args, { cwd, timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? "" : String(stdout).trim())));
  return git(["symbolic-ref", "--short", "-q", "HEAD"]).then(async (b) => (b && (await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${b}@{upstream}`])) ? b : ""));
}

// ------------------------------------------------------------------ the notice

export interface PushNoticeDeps {
  /** The PR tools are on and this is the foreman. */
  enabled(): boolean;
  /** A PR op (30 s timeout), in `cwd`. */
  run(op: PrOp, args: Record<string, unknown>, cwd?: string): Promise<SafeOpOutcome>;
  now?(): number;
  /** The branch of a quiet push (default: the checkout's branch when it has an upstream). */
  quietBranch?(cwd: string): Promise<string>;
  /** The configured base branch (safety.ops.baseBranch), if any. */
  baseBranch?(): string | null;
  /** Is the pushed branch in the base branch? null: cannot tell (no ref), no notice. */
  merged?(cwd: string, remote: string, name: string): Promise<boolean | null>;
}

export class PushNotice {
  private readonly deps: PushNoticeDeps;
  private readonly pushed: Pushed[] = [];
  private running = false;
  private readonly noticed = new Map<string, { at: number; final: boolean }>();

  constructor(deps: PushNoticeDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** The pushed-branch memory (newest first, at most eight). */
  pushedBranches(): readonly Pushed[] {
    return this.pushed;
  }

  private remember(p: { name: string; cwd: string; remote: string }): void {
    const have = this.pushed.find((x) => x.name === p.name && x.cwd === p.cwd);
    if (have) {
      have.at = this.now();
      return;
    }
    this.pushed.unshift({ ...p, at: this.now() });
    this.pushed.length = Math.min(this.pushed.length, MAX_PUSHED);
  }

  /** A foreman bash result: successful `git push` commands are remembered. `ok` is exit 0. */
  async onBash(command: string, output: string, ok: boolean, cwd: string): Promise<void> {
    if (!this.deps.enabled() || !ok) return;
    for (const seg of chainSegments(command)) {
      if (seg.cdBad) continue;
      const dir = seg.cd ? path.resolve(cwd, seg.cd) : cwd;
      const push = parsePush(seg.words);
      if (!push) continue;
      const via = push.dirs.reduce((d, x) => path.resolve(d, x), dir);
      let branches = parsePushOutput(output);
      if (branches.length === 0 && push.dirs.length === 0 && !push.gitDir && !seg.cd) {
        const b = await (this.deps.quietBranch ?? branchWithUpstream)(cwd);
        if (b) branches = [b];
      }
      for (const name of branches) this.remember({ name, cwd: via, remote: push.remote ?? "origin" });
    }
  }

  /**
   * For each pushed branch not decided yet: skip the base branch, else one any-state pr_find, then the merged
   * check; `notify` gets each remaining branch name once. A branch is looked at most every 10 minutes; one run at a
   * time (a second call during a run is dropped). Never throws.
   */
  async run(notify: (branch: string) => void): Promise<void> {
    if (this.running || !this.deps.enabled()) return;
    this.running = true;
    try {
      const base = this.deps.baseBranch?.() ?? null;
      for (const p of [...this.pushed]) {
        const id = `${p.cwd}\0${p.remote}\0${p.name}`;
        const seen = this.noticed.get(id);
        if (seen?.final || (seen && this.now() - seen.at < NOTICE_REEVAL_MS)) continue;
        this.noticed.set(id, { at: this.now(), final: false });
        const final = () => this.noticed.set(id, { at: this.now(), final: true });
        if (base && p.name === base) {
          final();
          continue;
        }
        const o = await this.deps.run("pr_find", { head: p.name, state: "all" }, p.cwd);
        if (o.kind !== "ran") continue;
        const prs = Array.isArray(o.result.prs) ? (o.result.prs as Record<string, unknown>[]).filter((x) => x.headRefName === p.name) : [];
        if (prs.length > 0) {
          final();
          continue;
        }
        const merged = await this.deps.merged?.(p.cwd, p.remote, p.name);
        final();
        if (merged === false || merged === undefined) notify(p.name);
      }
    } catch {
      // display only: a failed evaluation is retried after the re-evaluation window
    } finally {
      this.running = false;
    }
  }
}
