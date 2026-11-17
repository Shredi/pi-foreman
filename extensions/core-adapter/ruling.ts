// Ruling files of the ask contract (R6 lane 4): `ruling-<n>.md` / `ruling.md` next to an `ask.md` in a handoff dir.
// Pure file-state helpers: the harness writes `.seen` when a ruling wait wakes, the blocked state is recomputed from
// the files, a ruling older than its ask is ignored. A parent ruling never satisfies the finish gate (the chair runs
// /ceremony); after a FAIL the refusal only names it.
import * as fs from "node:fs";
import * as path from "node:path";
import { forEachChild, parse } from "unbash";
import type { Command, Redirected, SyntaxNode } from "unbash";
import { inlineCode, shellWriteTargets, unresolvedWriteWords } from "./defaults.ts";
import { MAX_DEPTH, parseShell as parsePs, psDashes, psProfile } from "./psunits.ts";
import { braceVariants } from "./floors.ts";
import { isRulingName, RULING_RE } from "./rulingname.ts";
import { MAX_DEPTH as SH_DEPTH, parseShell, SHELLS } from "./shellast.ts";
import type { ShellSegment } from "./shellast.ts";

export { isRulingName };
const ASK_N_RE = /^ask-(\d{1,6})\s*$/;

const BRIEF_RE = /^brief-[A-Za-z0-9._-]{1,64}\.md$/;

/** True for a `brief-<x>.md` file name (a parent's brief to the session; not a ruling name for the ask contract). */
export const isBriefName = (name: string): boolean => BRIEF_RE.test(name);

/** A name for self-write tracking and refusals: `isRulingName`, the plan checkpoint's `ruling-plan.md` (checkpoint.ts) and `brief-<x>.md` (both lift the caps, index.ts capsReset). */
export const isTrackedRulingName = (name: string): boolean => isRulingName(name) || name === "ruling-plan.md" || isBriefName(name);

/** A parent file that lifts the review cap and the read budgets: `ruling-<n>.md` (n >= 1) or `brief-<x>.md`; never `ruling.md`, `ruling-plan.md`, `brief.md`. */
export const isCapsResetName = (name: string): boolean => {
  const n = RULING_RE.exec(name)?.[1];
  return (n !== undefined && Number(n) >= 1) || isBriefName(name);
};

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
      for (const n of fs.readdirSync(dir).filter(isTrackedRulingName)) {
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
    if (!isTrackedRulingName(path.basename(file))) return;
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
const SHELL_TOOLS = new Set(["bash", "powershell", "foreman_bg", "bg_run"]);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const shellOf = (toolName: string): "posix" | "powershell" => (toolName === "powershell" ? "powershell" : "posix");

const fold = (s: string): string => s.replace(/\\/g, "/");

/** `text` names a ruling or brief file below one of the dir spellings `forms` by its literal path. */
const namesFileIn = (text: string, forms: string[]): boolean => {
  const t = fold(text);
  return forms.some((d) => {
    const pre = `${fold(d)}/`;
    for (let i = t.indexOf(pre); i >= 0; i = t.indexOf(pre, i + 1)) {
      const name = /^[A-Za-z0-9._-]+/.exec(t.slice(i + pre.length))?.[0];
      if (name && isTrackedRulingName(name)) return true;
    }
    return false;
  });
};

/** The words of a PowerShell line as the old layer split them (psunits.ts): every unit of every pipeline, the `$( )` substitutions included. */
const psWords = (src: string, depth = 0): string[] => {
  const parsed = parsePs(psProfile(psDashes(src)).replace(/`\r\n/g, "`\n"), "powershell");
  return [...parsed.pipelines.flat(2), ...(depth < MAX_DEPTH ? parsed.subs.flatMap((s) => psWords(s, depth + 1)) : [])];
};

/** The programs whose path operands (and `--opt=value` values) the own-ruling check reads though the gate treats them as no write: the mode and owner writers. */
const MODE_WRITERS = new Set(["chmod", "chown", "chgrp"]);
/** A copier or mover: with a destination directory (`-t`, or a last operand that is one) it writes `<dir>/<basename of an operand>`. */
const COPIERS = new Set(["cp", "mv", "install", "ln"]);

const RANGE_RE = /\{(?:(-?\d+)\.\.(-?\d+)|([A-Za-z])\.\.([A-Za-z]))\}/;
const RANGE_LIMIT = 64;

/** `word` with its `{a..c}` / `{1..3}` ranges expanded (numbers or single letters, either direction), at most RANGE_LIMIT variants; the word itself when it has none. */
function rangeVariants(word: string): string[] {
  const out: string[] = [];
  const walk = (w: string): void => {
    const m = RANGE_RE.exec(w);
    if (!m) {
      out.push(w);
      return;
    }
    const num = m[1] !== undefined;
    const a = num ? parseInt(m[1], 10) : m[3].charCodeAt(0);
    const b = num ? parseInt(m[2], 10) : m[4].charCodeAt(0);
    for (let k = a; out.length < RANGE_LIMIT && (a <= b ? k <= b : k >= b); k += a <= b ? 1 : -1) {
      walk(w.slice(0, m.index) + (num ? String(k) : String.fromCharCode(k)) + w.slice(m.index + m[0].length));
    }
  };
  walk(word);
  return out;
}

/** The names a word can expand to: its ranges, then its comma lists. */
const wordVariants = (word: string): string[] => rangeVariants(word).flatMap(braceVariants);

/** At most this many expanded names are read from the brace words of one script; a word met after that is judged by its literal text, and the variable clause still judges the line. */
const VARIANT_CAP = 256;

/** At most this many string literals are read from one code text; a text with more is judged by `namesDirOrRuling` alone. */
const LITERAL_CAP = 256;
/** At most this many adjacent literals are joined into one candidate word. */
const JOIN_CAP = 8;

/** The candidate file words of inline code or an interpreter script: its string literals (also joined by `+` or `.`, up to JOIN_CAP, and each whole run from its start), and its bare path-like tokens. null over LITERAL_CAP literals. */
function codeWords(code: string): string[] | null {
  const lits: Array<{ text: string; start: number; end: number }> = [];
  for (let i = 0; i < code.length; i++) {
    const q = code[i];
    if (q !== "'" && q !== '"' && q !== "`") continue;
    let text = "";
    let j = i + 1;
    for (; j < code.length && code[j] !== q; j++) {
      if (code[j] === "\\" && j + 1 < code.length) j++;
      text += code[j];
    }
    lits.push({ text, start: i, end: j });
    if (lits.length > LITERAL_CAP) return null;
    i = j;
  }
  const out = lits.map((l) => l.text);
  const joins = (b: number): boolean => /^\s*[+.]?\s*$/.test(code.slice(lits[b - 1].end + 1, lits[b].start));
  for (let a = 0; a < lits.length; a++) {
    let joined = lits[a].text;
    const runStart = a === 0 || !joins(a);
    for (let b = a + 1; b < lits.length && (runStart || b - a < JOIN_CAP) && joins(b); b++) {
      joined += lits[b].text;
      out.push(joined);
    }
  }
  return [...out, ...(code.match(/[^\s'"`()[\]{}<>|&,;:=]+/g) ?? [])];
}

/** What a heredoc or here-string feeds: `words` the owning command's own words (a compound command's whole text), `text` those words and the heredoc or here-string, `body` the script alone. */
interface StdinText {
  words: string[];
  text: string;
  body: string;
}

/** The text each stdin-fed command or redirected compound owns: its own words and its heredoc body or here-string, nothing after the terminator. null when the parse fails or a heredoc sits on no command. */
function stdinTexts(cmd: string): StdinText[] | null {
  const script = parse(cmd);
  if (script.errors?.length) return null;
  const out: StdinText[] = [];
  let bounded = true;
  const walk = (n: SyntaxNode, owner: Command | Redirected | null): void => {
    const own = n.type === "Command" || n.type === "Redirected" ? n : owner;
    if (n.type === "HereDoc" || n.type === "HereString") {
      if (own) {
        const body = n.type === "HereDoc" ? n.body.text : (n.target?.value ?? n.target?.text ?? "");
        const head = cmd.slice(own.pos, own.end);
        out.push({ words: head.split(/[\s;&|(){}'"]+/), text: head + (n.type === "HereDoc" ? ` ${body}` : ""), body });
      } else bounded = false;
      return;
    }
    forEachChild(n, (c) => walk(c, own));
  };
  walk(script, null);
  return bounded ? out : null;
}

/**
 * Whether a shell line writes, or for PowerShell names, a ruling or brief file of the child dirs. posix: a named write target of the gate's parse
 * (shellWriteTargets: redirects, tee, cp/mv/install/ln, sed -i, git and download output options, git config --file), the text of an inline-code segment or
 * of a stdin-fed heredoc that names the file by its literal path, and a line with a write word the parse cannot resolve (a variable, substitution or brace
 * list) that also names a child dir or a ruling or brief file name. PowerShell: a word that resolves to the file, or a bare ruling name beside a word that
 * resolves to a child dir (a read too).
 */
function shellNamesRuling(toolName: string, cmd: string, cwd: string, dirs: Set<string>, childDirs: string[], inChild: (p: string) => boolean): boolean {
  const forms = childDirs.flatMap((d) => [path.resolve(d), realDir(d)]);
  if (shellOf(toolName) === "powershell") {
    const words = psWords(cmd).flatMap((w) => [w, w.replace(/^-{0,2}[A-Za-z][\w-]*[:=]/, ""), ...(codeWords(w) ?? w.match(/[A-Za-z0-9._-]+/g) ?? [])]);
    if (words.some((w) => inChild(w) || inChild(fold(w)))) return true;
    const isDir = (w: string): boolean => dirs.has(realKey(path.resolve(cwd, fold(w))));
    return words.some((w) => isTrackedRulingName(w)) && words.some(isDir);
  }
  return posixNames(cmd, cwd, cwd, childDirs, forms, inChild, 0, { left: VARIANT_CAP });
}

/** The own-ruling check of one POSIX script (the line, or the body of a shell it feeds): every word judged by its literal path and resolved against the cwd of its segment. */
function posixNames(cmd: string, cwd: string, start: string, childDirs: string[], forms: string[], inChild: (p: string) => boolean, depth: number, budget: { left: number }): boolean {
  const segs = parseShell(cmd, { cwd });
  // a word is judged against the cwd of its segment (after a `cd`) and against the cwd the line started in (the old layer's only resolution)
  // only a word with a `{` is expanded, within the one budget of the top-level call; a word past it stands as unresolved: it refuses when its literal text lies under a child dir, its cwd is in one, or (below) the line names a child dir or a ruling name
  let unresolved = false;
  let refused = false;
  const variants = (word: string, at: string | null): string[] => {
    if (!word.includes("{")) return [word];
    if (budget.left <= 0) {
      unresolved = true;
      if ([word, path.resolve(at ?? cwd, word), path.resolve(start, word)].some((w) => forms.some((f) => fold(w).includes(fold(f))))) refused = true;
      return [word];
    }
    const v = wordVariants(word);
    budget.left -= v.length;
    return v;
  };
  const hits = (words: string[], at: string | null, expand = true): boolean =>
    (expand ? words.flatMap((w) => variants(w, at)) : words).some((v) => inChild(path.resolve(at ?? cwd, v)) || inChild(path.resolve(start, v)));
  const namesDirOrRuling = (text: string): boolean => {
    const line = fold(text);
    return childDirs.some((d) => [`handoffs/${path.basename(d)}`, ...forms].some((p) => line.includes(fold(p)))) || (line.match(/[A-Za-z0-9._-]+/g) ?? []).some(isTrackedRulingName);
  };
  // the words of a code text against each cwd; a text over the literal cap is refused only when it names a child dir or a ruling name literally
  const codeHits = (code: string, ats: Array<string | null>): boolean => {
    const words = codeWords(code);
    return words === null ? namesDirOrRuling(code) : ats.some((at) => hits(words, at, false));
  };
  for (const s of segs) {
    const p = path.basename(s.program);
    const operands = s.argv.filter((a) => !a.startsWith("-"));
    const targets = shellWriteTargets([s], process.platform);
    const tvars = targets.map((t) => variants(t.path, s.cwd));
    if (tvars.some((vs) => vs.some((v) => inChild(v) || (s.cwd !== null && inChild(path.resolve(start, path.relative(s.cwd, v))))))) return true;
    if (MODE_WRITERS.has(p) && hits([...operands, ...s.argv.filter((a) => /^--[\w-]+=./.test(a)).map((a) => a.slice(a.indexOf("=") + 1))], s.cwd)) return true;
    // a copy into a directory writes <dir>/<name of the operand>; the last operand is the old layer's target even after `-t`; another operand alone is a read
    if (COPIERS.has(p)) {
      const ovars = [...new Set(operands.flatMap((o) => variants(o, s.cwd)).map((o) => path.basename(o)))];
      if (hits(operands.slice(-1), s.cwd) || tvars.some((vs) => vs.some((d) => ovars.some((o) => inChild(path.join(d, o)))))) return true;
    }
    if (s.program !== "" && inlineCode(s)) {
      const code = s.argv.join(" ");
      if (namesFileIn(code, forms) || codeHits(code, [s.cwd])) return true;
    }
  }
  // a function, select, coproc or arithmetic-for body is no segment of the parse: it is parsed again for its write words (a read of the ruling in it is no refusal)
  if (depth < SH_DEPTH && segs.some((s) => s.opaque === "function_def" || (s.opaque === "unsupported" && NO_INNER.has(s.program)))) {
    const cwds = [...new Set([cwd, start, ...segs.map((s) => s.cwd).filter((c): c is string => c !== null)])];
    for (const b of opaqueBodies(cmd)) if (cwds.some((c) => posixNames(b, c, start, childDirs, forms, inChild, depth + 1, budget))) return true;
  }
  // every heredoc and here-string text is judged by the literal path, whatever it feeds; a text that feeds a shell or interpreter segment is also read as its script (one pass, each text takes the next fed segment of the programs its words name)
  // (the gate's parse shows no heredoc segment inside an arithmetic for or a function, so the texts are always read)
  const queues = new Map<string, ShellSegment[]>();
  for (const s of segs) {
    const p = path.basename(s.program);
    if (!s.heredoc || !(s.opaque === "stdin_fed" || SHELLS.has(p))) continue;
    if (queues.has(p)) queues.get(p)!.push(s);
    else queues.set(p, [s]);
  }
  for (const t of stdinTexts(cmd) ?? []) {
    if (namesFileIn(t.text, forms)) return true;
    for (const p of new Set(t.words.map((w) => path.basename(w)))) {
      const s = queues.get(p)?.shift();
      // a shell body is parsed again; at the depth cap, and for an interpreter, its words stand for it
      if (s && (SHELLS.has(p) && depth < SH_DEPTH ? posixNames(t.body, s.cwd ?? cwd, start, childDirs, forms, inChild, depth + 1, budget) : codeHits(t.body, [s.cwd]))) return true;
    }
  }
  return refused || ((unresolved || unresolvedWriteWords(segs).length > 0) && namesDirOrRuling(cmd));
}

/** The programs the parse names for a select, coproc or arithmetic for: opaque, with no inner segments. */
const NO_INNER = new Set(["select", "coproc", "for"]);
const BODY_NODES = new Set(["Function", "Select", "Coproc", "ArithmeticFor"]);

/** The source text of the body of every function, select, coproc and arithmetic for in `cmd` (outermost only) that parses as a script. */
function opaqueBodies(cmd: string): string[] {
  const out: string[] = [];
  const walk = (n: SyntaxNode): void => {
    const b = BODY_NODES.has(n.type) ? (n as { body?: { pos: number; end: number; type: string } }).body : undefined;
    // a select or arithmetic for body ends before its heredocs: the slice runs to the end of the node, less the closing `done` or `}`
    if (b && typeof b === "object" && b.type !== "Word") out.push(n.type === "Select" || n.type === "ArithmeticFor" ? cmd.slice(b.pos, n.end).replace(/[\s;]*(?:\bdone|\})\s*$/, "") : cmd.slice(b.pos, b.end));
    else forEachChild(n, walk);
  };
  walk(parse(cmd));
  return out;
}

/**
 * Refusal reason when `toolName` writes a `ruling*.md` or `brief-*.md` inside one of `childDirs` (the dirs where this session is the child) at a
 * literal path, else undefined: write/edit `path`, foreman_copy/foreman_move `dst`, or a shell line (shellNamesRuling: the gate's parse of its write
 * surfaces), resolved against `cwd`. `*.ack` files are never ruling names; a copy source is a read.
 */
export function selfRulingRefusal(toolName: string, input: Record<string, unknown>, cwd: string, childDirs: string[]): string | undefined {
  if (childDirs.length === 0) return undefined;
  const dirs = new Set(childDirs.map(realDir));
  const inChild = (p: string): boolean => isTrackedRulingName(path.basename(p)) && dirs.has(path.dirname(realKey(path.resolve(cwd, p))));
  const words = toolName === "write" || toolName === "edit" ? [str(input.path)] : toolName === "foreman_copy" || toolName === "foreman_move" ? [str(input.dst)] : [];
  const cmd = SHELL_TOOLS.has(toolName) ? str(input.command) : null;
  if (cmd && shellNamesRuling(toolName, cmd, cwd, dirs, childDirs, inChild)) return SELF_RULING_REASON;
  return words.some((p) => p && inChild(p)) ? SELF_RULING_REASON : undefined;
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
