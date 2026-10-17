// Ruling files of the ask contract (R6 lane 4): `ruling-<n>.md` / `ruling.md` next to an `ask.md` in a handoff dir.
// Pure file-state helpers: the harness writes `.seen` when a ruling wait wakes, the blocked state is recomputed from
// the files, a ruling older than its ask is ignored. A parent ruling never satisfies the finish gate (the chair runs
// /ceremony); after a FAIL the refusal only names it.
import * as fs from "node:fs";
import * as path from "node:path";
import { expandScratchVar } from "./childscratch.ts";

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
const realFull = (p: string): string => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return realKey(p);
  }
};

/** Pure read verbs whose operands are read positions (R10 item 7, Addendum A). */
const READ_POS_VERBS = new Set(["ls", "cat", "head", "tail", "wc", "stat", "diff"]);
/** A word the shell takes as is: no variable, glob, quote, escape, substitution or redirect character. */
const LITERAL = /^[\w./,:@+=%^-]+$/;
const SEGMENT_SEP = /(&&|\|\||[;|\n]|(?<![<>&])&(?![>&]))/;
/** A move of the working dir, bash or PowerShell spelling (PowerShell is case-insensitive). */
const MOVE = /\b(cd|pushd|popd|Set-Location|Push-Location|Pop-Location)\b/i;
/** Any assignment word (`NAME=`, `NAME+=`) or PowerShell `$x =` binding. */
const ASSIGN = /(^|[\s;&|(`])[A-Za-z_]\w*\+?=|\$[\w:]+\s*=(?!=)/;
/** A bare (not `$NAME`/`${NAME}`) mention of a variable that steers path resolution: a binding, export, read or for. */
const PATH_VARS = /(^|[^\w${])(CDPATH|FOREMAN_SCRATCH|HOME|OLDPWD|PWD)\b/;

/**
 * R10 item 7 (F1, F2): a line whose shell part moves the cwd, holds a backslash (escape or line continuation) or binds a
 * variable is read as a whole: no segment is masked, since a relative target or a segment split may not be what it seems.
 */
const opaqueShell = (s: string): boolean => MOVE.test(s) || s.includes("\\") || ASSIGN.test(s) || PATH_VARS.test(s);

/**
 * `text` with every segment removed that only reads with a literal word list: a pure read verb (READ_POS_VERBS) whose
 * output redirect targets lie outside every handoff dir, or a flag-light `cp` whose sources do not name a ruling and
 * whose destination lies outside (a cp/install SOURCE naming `ruling*` is never relaxed: `cp -s`/`-l` alias it).
 * Only the shell part before the first heredoc line counts; a heredoc body (interpreter code) is never removed.
 */
function maskReads(text: string, outside: (p: string) => boolean): string {
  const h = /(?<!<)<<(?!<)/.exec(text);
  const end = h ? text.indexOf("\n", h.index) : -1;
  const shell = h && end >= 0 ? text.slice(0, end) : text;
  const body = h && end >= 0 ? text.slice(end) : "";
  if (opaqueShell(shell)) return text;
  const parts = shell.split(SEGMENT_SEP);
  return parts.map((seg, i) => (i % 2 === 0 && readOnlySegment(seg, outside) ? "" : seg)).join("") + body;
}

function readOnlySegment(seg: string, outside: (p: string) => boolean): boolean {
  const t = seg.trim().split(/\s+/).filter(Boolean);
  if (t.length < 2) return false;
  if (t[0] === "cp") {
    if (t.some((w) => /[<>]/.test(w))) return false;
    const ops = t.slice(1).filter((w) => !/^-[aRrpfvnLHP]+$/.test(w));
    if (ops.length < 2 || ops.some((w) => w.startsWith("-") || !LITERAL.test(w))) return false;
    const dst = ops[ops.length - 1];
    return ops.slice(0, -1).every((w) => !/ruling/.test(path.basename(w))) && outside(dst);
  }
  if (!READ_POS_VERBS.has(t[0])) return false;
  for (let i = 1; i < t.length; i++) {
    const w = t[i];
    if (w.startsWith("<<")) return false;
    const r = /^(\d*>>?|\d*>\||&>>?|<)(.*)$/.exec(w);
    if (!r) {
      if (!LITERAL.test(w)) return false;
      continue;
    }
    const target = r[2] || t[++i];
    if (target === undefined) return false;
    if (r[1] !== "<" && /^&\d$/.test(target)) continue;
    if (!LITERAL.test(target) || (r[1] !== "<" && !outside(target))) return false;
  }
  return true;
}

/**
 * True when a `cd`/`pushd`/`Set-Location` in `text` may land in a handoff dir: its target is not a literal path
 * (after `$FOREMAN_SCRATCH` is resolved), is an option, is relative after an earlier move, or lies in a handoff dir.
 */
function movesUnsafe(text: string, cwd: string, inHandoff: (p: string) => boolean): boolean {
  // F2/F3: a backslash may hide a move (`c\d`), CDPATH reroutes a relative cd, a bound HOME/PWD/OLDPWD steers `~`/`cd`
  if (text.includes("\\") || /CDPATH/.test(text) || PATH_VARS.test(text)) return true;
  if (MOVE.test(text) && ASSIGN.test(text)) return true;
  let n = 0;
  for (const m of text.matchAll(new RegExp(MOVE.source, "gi"))) {
    const rest = text.slice(m.index + m[0].length);
    const t = /^[ \t]+([^\s;&|)]+)/.exec(rest)?.[1];
    if (!t || t.startsWith("-") || !LITERAL.test(t)) return true;
    if (n++ > 0 && !path.isAbsolute(t)) return true;
    if (inHandoff(path.resolve(cwd, t))) return true;
  }
  return false;
}

/**
 * Refusal reason when `toolName` would write a `ruling*.md` inside one of `childDirs` (the dirs where this session is
 * the child), else undefined. write/edit `path`, foreman_copy/foreman_move `dst`; shell-like tools fail closed: any word
 * naming such a file (or a ruling name next to a mention of a child dir) is refused unless the command is a pure read.
 * R10 item 7: read positions (operands of a pure read verb, a non-ruling `cp` source copied outside) do not count, a
 * `$FOREMAN_SCRATCH` resolves to `scratch`, and a `cd` to a literal dir outside every handoff dir is no move.
 */
export function selfRulingRefusal(toolName: string, input: Record<string, unknown>, cwd: string, childDirs: string[], scratch: string[] = []): string | undefined {
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
    let text = cmd;
    // F4: a line that binds FOREMAN_SCRATCH (any mention beyond a `$FOREMAN_SCRATCH`/`${FOREMAN_SCRATCH}` read) keeps it dynamic
    const bindsScratch = /FOREMAN_SCRATCH/.test(cmd.replace(/\$FOREMAN_SCRATCH\b|\$\{FOREMAN_SCRATCH\}/g, ""));
    for (const d of bindsScratch ? [] : scratch) {
      const t = expandScratchVar(cmd, d);
      if (t !== null) {
        text = t;
        break;
      }
    }
    const roots = [...new Set([...childDirs.map((d) => path.resolve(d)), ...dirs])];
    const inHandoff = (p: string): boolean => {
      const a = path.resolve(cwd, p);
      return [a, realFull(a)].some((x) => roots.some((d) => x === d || x.startsWith(d + path.sep)));
    };
    const masked = maskReads(text, (p) => !inHandoff(p));
    const words = masked.split(/[\s;&|<>()]+/).filter(Boolean).map(unquote);
    // a plain prose word (`ruling:`, `ruling.ts:180`) cannot name a ruling file; any path, quote, glob or `.md` keeps it
    const named = words.filter((w) => /ruling/.test(w) && !(/^[\w.,:-]+$/.test(w) && !/ruling[^/]*\.md/i.test(w)));
    const dynamic = words.some((w) => /[*?[$]/.test(w));
    const mentionsDir = [...childDirs, ...dirs].some((d) => masked.includes(d));
    const moves = MOVE.test(masked); // a relative word may not mean the file it seems to
    if (named.some(inChild)) return SELF_RULING_REASON;
    if (named.length > 0 && (mentionsDir || moves || dynamic)) return SELF_RULING_REASON;
    return dynamic && (mentionsDir || movesUnsafe(text, cwd, inHandoff)) ? SELF_RULING_REASON : undefined;
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
