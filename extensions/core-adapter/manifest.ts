// Session manifest recording (session-close items 3, 4): which worktrees and scratch dirs this
// session created, so the close report can clean them up or hand them over (docs/close.md).
//
// Silent and best effort: nothing reaches the model, a failure never blocks a tool. The single
// writer is `scripts/foreman_close.py record`; this module only decides what to record.
//   - bash: walk splitChain segments tracking `cd <dir>`; `git [-C d] worktree add ... <path>`
//     records a worktree (branch from -b/-B, else basename(path) when no commit-ish and no
//     --detach, git's own default); `mkdir [-p] <path>` under `.workflow/scratch/<topic>/` or
//     `<stateDir>/scratch/<x>/` records the `<topic>` (or `<x>`) dir when it was absent at tool_call.
//   - write/edit: a target inside a `.workflow/scratch/<topic>/` subdir absent at tool_call
//     records that topic dir. Files directly in `.workflow/scratch/` are never recorded.
//   - Unparseable chains (splitChain null), `~` paths and an unknown cwd are skipped.
import * as path from "node:path";
import { splitChain } from "./shellchain.ts";
import { under } from "./triage.ts";

export type ManifestKind = "worktree" | "scratch";
export interface ManifestEntry {
  kind: ManifestKind;
  path: string;
  branch?: string;
}
export interface ManifestCtx {
  cwd: string;
  stateDir: string;
  platform: string;
}

const px = (platform: string): path.PlatformPath => (platform === "win32" ? path.win32 : path.posix);

/** An absolute path for `word` against `cwd`, or null (home-relative, empty, unknown cwd, drive-relative). */
function resolveWord(word: string, cwd: string | null, platform: string): string | null {
  if (!word || word.startsWith("~")) return null;
  const x = px(platform);
  const w = platform === "win32" ? word.replace(/\//g, "\\") : word;
  if (platform === "win32" && /^[A-Za-z]:(?![\\/])/.test(w)) return null; // C:foo: cwd of that drive unknown
  if (x.isAbsolute(w)) return x.resolve(w);
  return cwd === null ? null : x.resolve(cwd, w);
}

/**
 * The scratch dir a path lies in: `<...>/.workflow/scratch/<topic>` (the path must be at least
 * `minDepth` components below `scratch`), or `<stateDir>/scratch/<x>`. null = not scratch.
 */
export function scratchDirOf(abs: string, c: ManifestCtx, minDepth: number): string | null {
  const x = px(c.platform);
  const stateScratch = x.join(x.resolve(c.stateDir), "scratch");
  if (under(stateScratch, abs, c.platform) && abs.length > stateScratch.length) {
    const rel = x.relative(stateScratch, abs).split(/[\\/]/).filter(Boolean);
    if (rel.length >= minDepth) return x.join(stateScratch, rel[0]);
  }
  const parts = abs.split(/[\\/]/);
  const fold = (s: string) => (c.platform === "win32" || c.platform === "darwin" ? s.toLowerCase() : s);
  for (let i = parts.length - 2; i >= 0; i--) {
    if (fold(parts[i]) !== ".workflow" || fold(parts[i + 1]) !== "scratch") continue;
    const below = parts.slice(i + 2).filter(Boolean);
    if (below.length < minDepth) return null;
    return parts.slice(0, i + 3).join(x.sep) || null;
  }
  return null;
}

/** Value-taking options of `git worktree add` (besides -b/-B). */
const WT_VALUE = new Set(["--reason"]);
/** Value-taking git global options (separate-word form). */
const GIT_GLOBAL_VALUE = new Set(["-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

function worktreeAdd(words: string[], cwd: string | null, platform: string): ManifestEntry | null {
  let k = 1;
  let gitCwd = cwd;
  while (k < words.length && words[k].startsWith("-")) {
    const w = words[k];
    if (w === "-C") {
      if (k + 1 >= words.length) return null;
      gitCwd = resolveWord(words[k + 1], gitCwd, platform);
      k += 2;
    } else if (GIT_GLOBAL_VALUE.has(w)) k += 2;
    else k += 1;
  }
  if (words[k] !== "worktree" || words[k + 1] !== "add") return null;
  const args = words.slice(k + 2);
  let branch: string | undefined;
  let detach = false;
  const pos: string[] = [];
  let opts = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (opts && a === "--") opts = false;
    else if (opts && (a === "-b" || a === "-B")) branch = args[++i];
    else if (opts && /^-[bB]./.test(a)) branch = a.slice(2);
    else if (opts && WT_VALUE.has(a)) i++;
    else if (opts && (a === "--detach" || a === "-d")) detach = true;
    else if (opts && a.startsWith("-")) continue;
    else pos.push(a);
  }
  if (!pos.length || gitCwd === null) return null;
  const p = resolveWord(pos[0], gitCwd, platform);
  if (!p) return null;
  if (!branch && !detach && pos.length === 1) branch = px(platform).basename(p);
  return branch ? { kind: "worktree", path: p, branch } : { kind: "worktree", path: p };
}

/** What a successful bash `command` (run in `c.cwd`) would create: worktrees and scratch dirs. */
export function bashCandidates(command: unknown, c: ManifestCtx): ManifestEntry[] {
  if (typeof command !== "string") return [];
  const chain = splitChain(command);
  if (!chain) return [];
  const out: ManifestEntry[] = [];
  let cwd: string | null = px(c.platform).resolve(c.cwd);
  for (const seg of chain.segments) {
    const w = seg.words;
    if (w[0] === "cd") {
      cwd = w.length === 2 && w[1] !== "-" ? resolveWord(w[1], cwd, c.platform) : null;
      continue;
    }
    if (w[0] === "git") {
      const e = worktreeAdd(w, cwd, c.platform);
      if (e) out.push(e);
      continue;
    }
    if (w[0] === "mkdir") {
      let opts = true;
      for (const a of w.slice(1)) {
        if (opts && a === "--") opts = false;
        else if (opts && a.startsWith("-")) continue;
        else {
          const abs = resolveWord(a, cwd, c.platform);
          const dir = abs ? scratchDirOf(abs, c, 1) : null;
          if (dir) out.push({ kind: "scratch", path: dir });
        }
      }
    }
  }
  return dedupe(out);
}

/** The scratch topic dir a write/edit target lies in (never a file directly in `.workflow/scratch/`). */
export function writeCandidates(target: unknown, c: ManifestCtx): ManifestEntry[] {
  if (typeof target !== "string") return [];
  const abs = resolveWord(target, px(c.platform).resolve(c.cwd), c.platform);
  const dir = abs ? scratchDirOf(abs, c, 2) : null;
  return dir ? [{ kind: "scratch", path: dir }] : [];
}

function dedupe(es: ManifestEntry[]): ManifestEntry[] {
  const seen = new Set<string>();
  return es.filter((e) => {
    const k = `${e.kind}\0${e.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Manifest session and owner: a child appends to its foreman's manifest with its launch id as owner. */
export function manifestOwner(s: { id: string; isChild: boolean; foremanSession?: string | null; launchId?: string | null }, env: Record<string, string | undefined>): { session: string; owner: string } {
  if (!s.isChild) return { session: s.id, owner: s.id };
  return { session: s.foremanSession || env.PI_SUBAGENT_PARENT_SESSION || s.id, owner: s.launchId || s.id };
}

/** `foreman_close.py record` arguments for one entry. */
export function recordArgs(e: ManifestEntry, o: { session: string; owner: string; stateDir: string }): string[] {
  return ["record", "--kind", e.kind, "--path", e.path, ...(e.branch ? ["--branch", e.branch] : []), "--owner", o.owner, "--session", o.session, "--state", o.stateDir];
}

const MAX_PENDING = 256;

/** Pre-state at tool_call, entries to record at a successful tool_result. */
export class ManifestRecorder {
  private pending = new Map<string, ManifestEntry[]>();
  private readonly exists: (p: string) => boolean;
  constructor(exists: (p: string) => boolean) {
    this.exists = exists;
  }

  onToolCall(id: string, toolName: string, input: Record<string, unknown> | undefined, c: ManifestCtx): void {
    let es: ManifestEntry[] = [];
    try {
      if (toolName === "bash") es = bashCandidates(input?.command, c);
      else if (toolName === "write" || toolName === "edit") es = writeCandidates(input?.path, c);
    } catch {
      es = [];
    }
    // A scratch dir counts only when it did not exist before the call.
    es = es.filter((e) => e.kind === "worktree" || !this.exists(e.path));
    if (!es.length) return;
    if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value as string);
    this.pending.set(id, es);
  }

  /** Entries to record (they exist now); empty for an error result or nothing pending. */
  onToolResult(id: string, isError: boolean): ManifestEntry[] {
    const es = this.pending.get(id);
    this.pending.delete(id);
    if (!es || isError) return [];
    return es.filter((e) => this.exists(e.path));
  }
}

/** Run `record` for each entry; never throws. */
export async function recordEntries(es: ManifestEntry[], o: { session: string; owner: string; stateDir: string }, run: (args: string[]) => Promise<unknown>): Promise<void> {
  for (const e of es) {
    try {
      await run(recordArgs(e, o));
    } catch {
      // best effort: the sweep is the backstop
    }
  }
}
