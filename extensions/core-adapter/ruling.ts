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

/**
 * The ask in `dir` is unanswered: `.ask` is present and `.seen` does not name its ruling (`ruling-<n>.md` for
 * `ask-<n>`, or `ruling.md`; with no number in `.ask`, any `.seen` ends it). Never a stored flag.
 */
export function askOpen(dir: string): boolean {
  const ask = readText(path.join(dir, ".ask"));
  if (ask === null) return false;
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

/** The refusal reason when a session writes a ruling file in a dir where it is the child. */
export const SELF_RULING_REASON = "a session cannot write its own parent's ruling";

const REF_READ_VERBS = new Set(["cat", "head", "tail", "ls", "grep", "egrep", "fgrep", "rg", "wc", "stat", "file", "nl", "realpath", "sort", "uniq", "cut", "tr", "cd"]);

interface Seg { words: string[]; redirs: string[] }

/** Split a shell line into simple commands: quotes stripped, redirect targets kept apart from the words. */
function shellSegments(cmd: string): Seg[] {
  const segs: Seg[] = [];
  let seg: Seg = { words: [], redirs: [] };
  let cur = "";
  let inWord = false;
  let pending: "redir" | "skip" | null = null;
  const flush = (): void => {
    if (!inWord) return;
    if (pending === "redir") seg.redirs.push(cur);
    else if (pending !== "skip") seg.words.push(cur);
    pending = null;
    cur = "";
    inWord = false;
  };
  const endSeg = (): void => {
    flush();
    if (seg.words.length || seg.redirs.length) segs.push(seg);
    seg = { words: [], redirs: [] };
    pending = null;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      const end = j < 0 ? cmd.length : j;
      cur += cmd.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      inWord = true;
      for (i++; i < cmd.length && cmd[i] !== '"'; i++) {
        if (cmd[i] === "\\" && i + 1 < cmd.length) i++;
        cur += cmd[i];
      }
    } else if (c === "\\" && i + 1 < cmd.length) {
      cur += cmd[++i];
      inWord = true;
    } else if (/\s/.test(c) && c !== "\n") {
      flush();
    } else if (c === ">" || (c === "&" && cmd[i + 1] === ">")) {
      if (inWord && /^\d+$/.test(cur)) { cur = ""; inWord = false; } else flush();
      if (c === "&") i++;
      while (cmd[i + 1] === ">" || cmd[i + 1] === "|") i++;
      if (cmd[i + 1] === "&" && c === ">") {
        i++; // a descriptor duplicate (`2>&1`), no file
        while (/[\d-]/.test(cmd[i + 1] ?? "")) i++;
      } else pending = "redir";
    } else if (c === "<") {
      flush();
      while (cmd[i + 1] === "<") i++;
      pending = "skip";
    } else if (";|&\n(){}".includes(c)) {
      endSeg();
    } else {
      cur += c;
      inWord = true;
    }
  }
  endSeg();
  return segs;
}

const WRITE_ALL = new Set(["tee", "touch", "truncate"]);
const WRITE_LAST = new Set(["cp", "mv", "install", "ln", "rsync"]);
const isAssign = (w: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);

/** Words a simple command can write to (not classified as ruling or not yet), plus the directory-copy sources. */
function writeTargets(words: string[]): { targets: string[]; sources: string[] } {
  const none = { targets: [] as string[], sources: [] as string[] };
  let k = 0;
  while (k < words.length && (isAssign(words[k]) || ["sudo", "nohup", "time", "command", "env", "nice"].includes(words[k]))) k++;
  const verb = words[k];
  if (!verb) return none;
  const args = words.slice(k + 1);
  const ops = args.filter((a) => !a.startsWith("-"));
  if (WRITE_ALL.has(verb)) return { targets: ops, sources: [] };
  if (WRITE_LAST.has(verb)) {
    const ti = args.findIndex((a) => a === "-t" || a.startsWith("--target-directory"));
    if (ti >= 0) {
      const a = args[ti];
      const dir = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[ti + 1];
      return { targets: dir ? [dir] : [], sources: ops.filter((o) => o !== dir) };
    }
    return ops.length > 1 ? { targets: [ops[ops.length - 1]], sources: ops.slice(0, -1) } : none;
  }
  if (verb === "dd") return { targets: args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3)), sources: [] };
  if (verb === "sed" && args.some((a) => a === "--in-place" || a.startsWith("--in-place=") || /^-[a-zA-Z]*i/.test(a))) return { targets: ops, sources: [] };
  if (verb === "uniq") return { targets: ops.slice(1), sources: [] };
  if (verb === "sort") {
    const t: string[] = [];
    args.forEach((a, n) => {
      if (a === "-o" || a === "--output") t.push(args[n + 1] ?? "");
      else if (a.startsWith("--output=")) t.push(a.slice(9));
      else if (/^-o./.test(a)) t.push(a.slice(2));
    });
    return { targets: t.filter(Boolean), sources: [] };
  }
  return none;
}

const KNOWN_VERBS = new Set([...REF_READ_VERBS, ...WRITE_ALL, ...WRITE_LAST, "dd", "sed", "echo", "printf", "git", "env", "pwd", "true", "false", "rm", "mkdir", "sleep", "find", "diff", "test", "export"]);

const realDir = (d: string): string => path.dirname(realKey(path.join(d, "x")));

/**
 * Refusal reason when `toolName` would write a `ruling*.md` inside one of `childDirs` (the dirs where this session is
 * the child), else undefined. write/edit `path`, foreman_copy/foreman_move `dst`; shell-like tools fail closed: any word
 * naming such a file (or a ruling name next to a mention of a child dir) is refused unless the command is a pure read.
 */
export function selfRulingRefusal(toolName: string, input: Record<string, unknown>, cwd: string, childDirs: string[]): string | undefined {
  return selfRulingTarget(toolName, input, cwd, childDirs) === undefined ? undefined : SELF_RULING_REASON;
}

/** The refusal message naming the matched target, or undefined when the call is allowed. */
export function selfRulingMessage(toolName: string, input: Record<string, unknown>, cwd: string, childDirs: string[]): string | undefined {
  const t = selfRulingTarget(toolName, input, cwd, childDirs);
  return t === undefined ? undefined : `${SELF_RULING_REASON} (target: ${t})`;
}

/** The write target (word or path) that would write a ruling file in a child dir, or undefined. */
export function selfRulingTarget(toolName: string, input: Record<string, unknown>, cwd: string, childDirs: string[]): string | undefined {
  if (childDirs.length === 0) return undefined;
  const dirs = new Set(childDirs.map(realDir));
  const inChildAt = (base: string, p: string): boolean => isRulingName(path.basename(p)) && dirs.has(path.dirname(realKey(path.resolve(base, p))));
  const inChild = (p: string): boolean => inChildAt(cwd, p);
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  if (toolName === "write" || toolName === "edit") {
    const p = str(input.path);
    return p && inChild(p) ? p : undefined;
  }
  if (toolName === "foreman_copy" || toolName === "foreman_move") {
    const p = str(input.dst);
    return p && inChild(p) ? p : undefined;
  }
  if (toolName === "bash" || toolName === "powershell" || toolName === "foreman_bg" || toolName === "bg_run") {
    const cmd = str(input.command);
    if (!cmd) return undefined;
    const mentionsDir = [...childDirs, ...dirs].some((d) => cmd.includes(d));
    const rulingAnywhere = /ruling/.test(cmd);
    const moves = /\b(cd|pushd|Set-Location)\b/.test(cmd);
    const dynWord = (w: string): boolean => /[*?[$`]/.test(w);
    let at = cwd;
    for (const seg of shellSegments(cmd)) {
      const verb = seg.words.find((w) => !isAssign(w));
      if (verb === "cd" || verb === "pushd") {
        const arg = seg.words.slice(seg.words.indexOf(verb) + 1).find((w) => !w.startsWith("-"));
        if (arg && !dynWord(arg)) at = path.resolve(at, arg);
      }
      const { targets, sources } = writeTargets(seg.words);
      const all = [...seg.redirs.filter((r) => !r.startsWith("/dev/")), ...targets];
      for (const t of all) {
        if (inChildAt(at, t) || inChild(t)) return t;
        if (isRulingName(path.basename(t)) && (mentionsDir || moves)) return t;
        if (dynWord(t) && (mentionsDir || rulingAnywhere)) return t;
        // copying a ruling-named source into a child dir itself
        if (dirs.has(realKey(path.resolve(at, t))) || dirs.has(realKey(path.resolve(cwd, t)))) {
          const s = sources.find((x) => isRulingName(path.basename(x)) || dynWord(x) && rulingAnywhere);
          if (s !== undefined) return s;
        }
      }
      // a command that is neither a viewer nor a known writer: fail closed on a ruling word next to a dir mention
      if (verb && !KNOWN_VERBS.has(verb) && !isAssign(verb)) {
        const w = seg.words.find((x) => /ruling/.test(x) && (inChildAt(at, x) || mentionsDir || moves || dynWord(x)));
        if (w !== undefined) return w;
      }
    }
    return undefined;
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
