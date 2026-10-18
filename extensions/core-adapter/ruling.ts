// Ruling files of the ask contract (R6 lane 4): `ruling-<n>.md` / `ruling.md` next to an `ask.md` in a handoff dir.
// Pure file-state helpers: the harness writes `.seen` when a ruling wait wakes, the blocked state is recomputed from
// the files, a ruling older than its ask is ignored. A parent ruling never satisfies the finish gate (the chair runs
// /ceremony); after a FAIL the refusal only names it.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runGuard } from "./runguard.ts";
import { defaultSpawner } from "./spawn.ts";
import type { Spawner } from "./spawn.ts";

const RULING_RE = /^ruling(?:-(\d{1,6}))?\.md$/;
const ASK_N_RE = /^ask-(\d{1,6})\s*$/;

/** True for a `ruling.md` / `ruling-<n>.md` file name. */
export const isRulingName = (name: string): boolean => RULING_RE.test(name);

const mtimeOf = (p: string): number | null => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
};

const readText = (p: string): string | null => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

/** A ruling file the wait may wake on: not older than the `ask.md` beside it (no ask.md, or no mtime = fresh). */
export function rulingFresh(file: string, mtime: (p: string) => number | null = mtimeOf): boolean {
  if (!isRulingName(path.basename(file))) return true;
  const ask = mtime(path.join(path.dirname(file), "ask.md"));
  const ruling = mtime(file);
  return ask === null || ruling === null || ruling >= ask;
}

/** `needs_ruling: no` line of an ask.md: an informational ask. */
export const NEEDS_RULING_NO_RE = /^needs_ruling:[ \t]*no[ \t]*$/im;

/**
 * The ask in `dir` is unanswered: `.ask` is present and `.seen` does not name its ruling (`ruling-<n>.md` for
 * `ask-<n>`, or `ruling.md`; with no number in `.ask`, any `.seen` ends it). Never a stored flag.
 */
export function askOpen(dir: string): boolean {
  const ask = readText(path.join(dir, ".ask"));
  if (ask === null) return false;
  // an informational ask (`needs_ruling: no`) never holds the hand, whatever an older `.ask` says
  if (NEEDS_RULING_NO_RE.test(readText(path.join(dir, "ask.md")) ?? "")) return false;
  const seen = readText(path.join(dir, ".seen"));
  if (seen === null) return true;
  const named = seen.trim();
  const n = ASK_N_RE.exec(ask.trim())?.[1];
  if (n === undefined) return false;
  return !(named === `ruling-${Number(n)}.md` || named === "ruling.md");
}

const realKey = (p: string): string => {
  try {
    return path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p));
  } catch {
    return path.resolve(p);
  }
};

/** The ruling files in `dirs` with their mtimes (a snapshot before a shell command). */
export function snapshotRulings(dirs: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const dir of dirs) {
    try {
      for (const n of fs.readdirSync(dir).filter(isRulingName)) {
        const m = mtimeOf(path.join(dir, n));
        if (m !== null) out.set(path.join(dir, n), m);
      }
    } catch {
      // no dir
    }
  }
  return out;
}

/**
 * Ruling files this session wrote itself (write/edit, or a shell command that changed them). They never count as a
 * parent ruling: the foreman can write its own handoff dir, and a self-written APPROVED is no parent verdict. A file
 * is ignored while its mtime is not newer than the recorded write; a later parent write counts again.
 */
export class SelfRulings {
  private readonly written = new Map<string, number>();

  /** A write/edit of `file`: remember its mtime (only ruling names). */
  mark(file: string): void {
    if (!isRulingName(path.basename(file))) return;
    const m = mtimeOf(file);
    if (m !== null) this.written.set(realKey(file), m);
  }

  /** After a shell command: every ruling file in `dirs` new or changed since `before` was written by this session. */
  markChanged(before: Map<string, number>, dirs: string[]): void {
    for (const [f, m] of snapshotRulings(dirs)) if (before.get(f) !== m) this.written.set(realKey(f), m);
  }

  /** True when `file` (at `mtime`) is a ruling this session wrote. */
  has(file: string, mtime: number): boolean {
    const w = this.written.get(realKey(file));
    return w !== undefined && mtime <= w;
  }
}

/**
 * A parent ruling in `dirs` (`ruling.md` / `ruling-<n>.md`, first line `APPROVED` or `SHIP`) whose mtime is newer than
 * `afterMs` (the last FAIL verdict). Returns its path, or null. Only for naming it in the finish refusal: it is never a
 * verdict. `dirs` must be the dirs where this session is the child (owned.ts childHandoffDirs); `self` skips rulings
 * this session wrote.
 *
 * `restore` (reload, roundstate.ts): only `ruling.md` (never `ruling-<n>.md`), first line `APPROVED`, and its ctime
 * (which a session cannot set back) newer than `afterMs` (the ctime of both plan files). Such a ruling restores the
 * plan checkpoint approval after /reload, nothing else: the finish gate still needs a reviewer PASS.
 */
export function parentApproval(dirs: string[], afterMs: number, self?: SelfRulings, restore = false): string | null {
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter(restore ? (n) => n === "ruling.md" : isRulingName);
    } catch {
      continue;
    }
    for (const n of names) {
      const m = mtimeOf(path.join(dir, n));
      let c: number | null = null;
      try {
        c = fs.statSync(path.join(dir, n)).ctimeMs;
      } catch {
        // vanished
      }
      if (m === null || c === null || (restore ? c : m) <= afterMs || self?.has(path.join(dir, n), m)) continue;
      const first = (readText(path.join(dir, n)) ?? "").split(/\r?\n/, 1)[0].trim();
      if (first === "APPROVED" || (!restore && first === "SHIP")) return path.join(dir, n);
    }
  }
  return null;
}

/** The refusal reason when a session writes a ruling file in a dir where it is the child. */
export const SELF_RULING_REASON = "a session cannot write its own parent's ruling";

const realDir = (d: string): string => path.dirname(realKey(path.join(d, "x")));
const isDir = (d: string): boolean => {
  try {
    return fs.statSync(d).isDirectory();
  } catch {
    return false;
  }
};

/** One write surface of a shell line, as `scripts/shell_facts.py` reports it (null = computed, unresolved). */
export interface WriteFact {
  kind: string;
  path: string | null;
  dir: string | null;
  name: string | null;
  glob: boolean;
  /** A copy source (cp, install, Copy-Item): only read, never a write. */
  read?: boolean;
  /** `<target>/<source name>` of a copier: written only when the target is a directory when the command runs. */
  into?: boolean;
}
export interface ShellFacts {
  writes: WriteFact[];
  links: boolean;
  error: string | null;
}

/** How the shell facts are obtained: the python interpreter (null = none, fails closed), spawner, scratch dir. */
export interface SelfRulingDeps {
  python?: string | null;
  spawner?: Spawner;
  env?: Record<string, string>;
  /** `$FOREMAN_SCRATCH` of the session (default: the process env). */
  scratch?: string | null;
  timeoutMs?: number;
}

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Run `scripts/shell_facts.py` on a command; null when it did not answer cleanly (the caller fails closed). */
export async function shellFacts(command: string, cwd: string, shell: "bash" | "powershell", deps: SelfRulingDeps = {}): Promise<ShellFacts | null> {
  const python = deps.python === undefined ? (process.platform === "win32" ? "python" : "python3") : deps.python;
  const env = deps.env ?? Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));
  const scratch = deps.scratch === undefined ? (process.env.FOREMAN_SCRATCH ?? null) : deps.scratch;
  const run = await runGuard({ python, coreDir: PKG_ROOT, guard: "shell_facts", payload: { command, cwd, shell, scratch_dir: scratch }, env, cwd: PKG_ROOT, spawner: deps.spawner ?? defaultSpawner, timeoutMs: deps.timeoutMs });
  if (run.status !== "ran" || run.code !== 0) return null;
  try {
    const f = JSON.parse(run.stdout.trim().split(/\r?\n/).pop() ?? "") as ShellFacts;
    return Array.isArray(f.writes) && f.error === null ? f : null;
  } catch {
    return null;
  }
}

const globRe = (g: string): RegExp => new RegExp(`^${g.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

/**
 * A write surface that may hit a ruling file in one of `dirs` (real paths). `moves`: the line moves or renames a path; kept
 * in the signature, unread since R14 ruling 7 reverted the `into` shortcut: an `into` fact (`cp <src> T` writes
 * `T/<src name>`) under a T that is no directory now is refused like any other write below a non-directory.
 */
export function factHitsRuling(w: WriteFact, dirs: Set<string>, links: boolean, moves = false): boolean {
  if (w.read) return false;
  // an existing file (or symlink to one) at a known path: judged by what it really is
  if (w.path && fs.existsSync(w.path)) {
    const real = realKey(w.path);
    let target = real;
    try {
      target = fs.realpathSync.native(w.path);
    } catch {
      // dangling: the lexical path stands
    }
    for (const p of [real, target]) if (isRulingName(path.basename(p)) && dirs.has(path.dirname(p))) return true;
  }
  let name = false;
  if (w.name === null) name = true;
  else if (w.glob) {
    try {
      name = ["ruling.md", "ruling-1.md"].some((n) => globRe(w.name as string).test(n));
    } catch {
      name = true;
    }
  } else name = isRulingName(w.name);
  if (!name) return false;
  if (w.dir === null || links || !isDir(w.dir)) return true;
  return dirs.has(realDir(w.dir));
}

/**
 * Refusal reason when `toolName` would write a `ruling*.md` inside one of `childDirs` (the dirs where this session is
 * the child), else undefined. write/edit `path`, foreman_copy/foreman_move `dst` are compared directly. Shell-like tools
 * are read through `scripts/shell_facts.py` (the git guard's Lexer): only a WRITE surface (redirect, cp/mv/tee/dd/sed -i
 * ..., interpreter code writes, a ruling-named argument of a non-reader) that may be such a file is refused; a computed
 * name or directory in a write position counts as one. No answer from the script (no python, timeout, unreadable line)
 * refuses. `*.ack` files are never ruling names; a copy source (`cp <H>/ruling-2.md x`) is a read.
 */
export async function selfRulingRefusal(toolName: string, input: Record<string, unknown>, cwd: string, childDirs: string[], deps: SelfRulingDeps = {}): Promise<string | undefined> {
  if (childDirs.length === 0) return undefined;
  const dirs = new Set(childDirs.map(realDir));
  const inChild = (p: string): boolean => isRulingName(path.basename(p)) && dirs.has(path.dirname(realKey(path.resolve(cwd, p))));
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  if (toolName === "write" || toolName === "edit") {
    const p = str(input.path);
    return p && inChild(p) ? SELF_RULING_REASON : undefined;
  }
  if (toolName === "foreman_copy" || toolName === "foreman_move") {
    const p = str(input.dst);
    return p && inChild(p) ? SELF_RULING_REASON : undefined;
  }
  if (toolName === "bash" || toolName === "powershell" || toolName === "foreman_bg" || toolName === "bg_run") {
    const cmd = str(input.command);
    if (!cmd) return undefined;
    const facts = await shellFacts(cmd, cwd, toolName === "powershell" ? "powershell" : "bash", deps);
    if (!facts) return SELF_RULING_REASON;
    const moves = facts.writes.some((w) => w.kind === "source" && !w.read);
    return facts.writes.some((w) => factHitsRuling(w, dirs, facts.links, moves)) ? SELF_RULING_REASON : undefined;
  }
  return undefined;
}

/** What `/foreman close` adds when the ceremony is incomplete: what the parent must still rule. */
export function rulingNeeded(missing: string[]): string {
  return missing.length === 0
    ? ""
    : `Missing: ${missing.join(", ")}. The parent must still rule on it; a ruling file never satisfies the finish gate, the owner/chair runs /ceremony <tier>.`;
}

/** Refusal addendum when a parent ruling file is newer than the last FAIL verdict: it is named, and does not lift the gate. */
export function rulingOverrideNote(ruling: string, failAt: number): string {
  return ` A parent ruling ${ruling} is newer than the last FAIL verdict (${new Date(failAt).toISOString()}), but a parent ruling never satisfies the finish gate; the owner/chair runs: /ceremony <tier>`;
}
