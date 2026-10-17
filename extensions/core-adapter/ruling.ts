// Ruling files of the ask contract (R6 lane 4): `ruling-<n>.md` / `ruling.md` next to an `ask.md` in a handoff dir.
// Pure file-state helpers: the harness writes `.seen` when a ruling wait wakes, the blocked state is recomputed from
// the files, a ruling older than its ask is ignored. A parent ruling never satisfies the finish gate (the chair runs
// /ceremony); after a FAIL the refusal only names it.
import * as fs from "node:fs";
import * as path from "node:path";

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
  /** Session-owned background jobs still running (R11 S1): launch time, ruling snapshot at launch, exit probe. */
  private readonly jobs = new Map<string, { start: number; before: Map<string, number>; dirs: () => string[]; alive: () => boolean }>();
  /** [launch, observed exit] of every closed job: a ruling whose mtime falls inside one is self-written. */
  private readonly spans: [number, number][] = [];

  /**
   * A background job of this session started (foreman_bg, bg_run, a bash call that backgrounds): until its exit is
   * observed, every ruling file that appears or changes is self-written. `dirs` gives the session's child handoff
   * dirs (read at launch and again at the exit). The job stays open until `watchJob` gives an exit probe that returns
   * false (no probe: open for the session's life).
   */
  openJob(id: string, dirs: () => string[], now: number = Date.now()): void {
    if (!this.jobs.has(id)) this.jobs.set(id, { start: now, before: snapshotRulings(dirs()), dirs, alive: () => true });
  }

  /** How the exit of job `id` is observed (true while it runs). */
  watchJob(id: string, alive: () => boolean): void {
    const j = this.jobs.get(id);
    if (j) j.alive = alive;
  }

  /** Job `id` exited: a fresh snapshot marks every ruling changed since its launch; its time span stays self-written. */
  closeJob(id: string, now: number = Date.now()): void {
    const j = this.jobs.get(id);
    if (!j) return;
    this.jobs.delete(id);
    this.markChanged(j.before, j.dirs());
    this.spans.push([j.start, now]);
  }

  /** Closes every job whose exit probe says it has exited (a throwing probe keeps it open). */
  private sweep(): void {
    for (const [id, j] of [...this.jobs]) {
      let alive = true;
      try {
        alive = j.alive();
      } catch {
        // unknown: stays open
      }
      if (!alive) this.closeJob(id);
    }
  }

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

  /**
   * True when `file` (at `mtime`) is a ruling this session wrote, or may have written: its mtime lies in a closed
   * job's span, or a background job is still open and the file is new or changed since that job's launch (fail closed).
   */
  has(file: string, mtime: number): boolean {
    this.sweep();
    const key = realKey(file);
    const w = this.written.get(key);
    if (w !== undefined && mtime <= w) return true;
    if (this.spans.some(([a, b]) => mtime >= a && mtime <= b)) return true;
    for (const j of this.jobs.values()) {
      if (mtime >= j.start) return true;
      const was = [...j.before].find(([f]) => realKey(f) === key);
      if (was === undefined || was[1] !== mtime) return true;
    }
    return false;
  }
}

/**
 * A shell command that may leave a job running after its tool result (R11 S1): a `&` that is not `&&`, `>&`, `&>`
 * or `|&`, or `nohup` / `disown` / `setsid`. Quoted text counts too (`sh -c '... &'`): any doubt is a background job.
 */
export function backgroundsJob(command: unknown): boolean {
  if (typeof command !== "string") return false;
  if (/(?:^|[^A-Za-z0-9_-])(?:nohup|disown|setsid)(?![A-Za-z0-9_-])/.test(command)) return true;
  return command.replace(/&&|>&|&>|\|&/g, "  ").includes("&");
}

/** The pid a foreman_bg / bg_run result names (`details.pid`, else `pid N` in its text), or null. */
export function jobPid(details: unknown, text: string): number | null {
  const d = details && typeof details === "object" ? (details as Record<string, unknown>).pid : undefined;
  if (typeof d === "number" && Number.isInteger(d) && d > 1) return d;
  const m = /\bpid\b\D{0,3}(\d{2,10})\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * A parent ruling in `dirs` (`ruling.md` / `ruling-<n>.md`, first line `APPROVED` or `SHIP`) whose mtime is newer than
 * `afterMs` (the last FAIL verdict). Returns its path, or null. Only for naming it in the finish refusal: it is never a
 * verdict. `dirs` must be the dirs where this session is the child (owned.ts childHandoffDirs); `self` skips rulings
 * this session wrote.
 */
export function parentApproval(dirs: string[], afterMs: number, self?: SelfRulings): string | null {
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter(isRulingName);
    } catch {
      continue;
    }
    for (const n of names) {
      const m = mtimeOf(path.join(dir, n));
      if (m === null || m <= afterMs || self?.has(path.join(dir, n), m)) continue;
      const first = (readText(path.join(dir, n)) ?? "").split(/\r?\n/, 1)[0].trim();
      if (first === "APPROVED" || first === "SHIP") return path.join(dir, n);
    }
  }
  return null;
}

/** A gate a parent ruling line may lift: `review-cap: +N` (ceremony.reviewRuns) or `read-budget: +N` (ceremony.foremanReads). */
export type RulingLiftKey = "review-cap" | "read-budget";

/**
 * The lift a parent ruling grants for `key`: the line `<key>: +N` of the NEWEST `ruling*.md` in `dirs`, or null. `dirs`
 * must be the dirs where this session is the child (owned.ts childHandoffDirs), so a ruling written by one of its own
 * children (a dir where it is the parent) never counts. The ruling counts only when it is the parent's: not written by
 * this session (`self`) and not older than the session's ask.md or plan.md beside it (one of them must exist). Each
 * ruling file lifts each key once (its path, recorded in `used`): a changed or touched old ruling never lifts again,
 * a new parent ruling comes as a new file (`ruling-<n>.md`).
 */
export function parentRulingLift(dirs: string[], key: RulingLiftKey, self: SelfRulings | undefined, used: Set<string>): { file: string; n: number } | null {
  let newest: { file: string; m: number } | null = null;
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter(isRulingName);
    } catch {
      continue;
    }
    for (const n of names) {
      const file = path.join(dir, n);
      const m = mtimeOf(file);
      if (m !== null && (newest === null || m > newest.m)) newest = { file, m };
    }
  }
  if (newest === null || self?.has(newest.file, newest.m)) return null;
  const anchors = ["ask.md", "plan.md"].map((f) => mtimeOf(path.join(path.dirname(newest.file), f))).filter((m): m is number => m !== null);
  if (anchors.length === 0 || newest.m < Math.max(...anchors)) return null;
  const line = new RegExp(`^${key}:[ \\t]*\\+(\\d{1,4})[ \\t]*$`, "im").exec(readText(newest.file) ?? "");
  const n = line ? Number(line[1]) : 0;
  if (n < 1) return null;
  const id = `${key}|${realKey(newest.file)}`;
  if (used.has(id)) return null;
  used.add(id);
  return { file: newest.file, n };
}

/** The refusal reason when a session writes a ruling file in a dir where it is the child. */
export const SELF_RULING_REASON = "a session cannot write its own parent's ruling";

const REF_READ_VERBS = new Set(["cat", "head", "tail", "ls", "grep", "egrep", "fgrep", "rg", "wc", "stat", "file", "nl", "realpath", "sort", "uniq", "cut", "tr", "cd"]);
/** `-o` is --only-matching for these, not an output file. */
const REF_ONLY_MATCHING = new Set(["grep", "egrep", "fgrep", "rg", "ls"]);

/** A command that only reads with a plain viewer verb (no redirect, background job, substitution, output option). */
function pureRead(command: string): boolean {
  if (/[`>&]|\$\(|<\(|\$\{/.test(command.replace(/&&/g, ";"))) return false;
  const parts = command.split(/&&|\|\||;|\||\n/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => {
    const w = p.split(/\s+/);
    if (!REF_READ_VERBS.has(w[0])) return false;
    // `uniq IN OUT` and `tr`'s sets are operands: uniq writes its second operand, so it takes none here
    if (w[0] === "uniq" && w.slice(1).some((x) => !x.startsWith("-"))) return false;
    if (w[0] === "sort" && w.some((x) => /^-[^-]*[oT]|^--(output|compress-program|temporary)/.test(x))) return false;
    return REF_ONLY_MATCHING.has(w[0]) || !w.some((x) => /^--?o(utput)?\b/.test(x));
  });
}

const unquote = (w: string): string => w.replace(/^['"]+|['"]+$/g, "");
const realDir = (d: string): string => path.dirname(realKey(path.join(d, "x")));

/**
 * Refusal reason when `toolName` would write a `ruling*.md` inside one of `childDirs` (the dirs where this session is
 * the child), else undefined. write/edit `path`, foreman_copy/foreman_move `dst`; shell-like tools fail closed: any word
 * naming such a file (or a ruling name next to a mention of a child dir) is refused unless the command is a pure read.
 */
export function selfRulingRefusal(toolName: string, input: Record<string, unknown>, cwd: string, childDirs: string[]): string | undefined {
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
    if (!cmd || pureRead(cmd)) return undefined;
    const words = cmd.split(/[\s;&|<>()]+/).filter(Boolean).map(unquote);
    const named = words.filter((w) => /ruling/.test(w));
    const dynamic = words.some((w) => /[*?[$]/.test(w));
    const mentionsDir = [...childDirs, ...dirs].some((d) => cmd.includes(d));
    const moves = /\b(cd|pushd|Set-Location)\b/.test(cmd); // a relative word may not mean the file it seems to
    if (named.some(inChild)) return SELF_RULING_REASON;
    if (named.length > 0 && (mentionsDir || moves || dynamic)) return SELF_RULING_REASON;
    return dynamic && (mentionsDir || moves) ? SELF_RULING_REASON : undefined;
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
