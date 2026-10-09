// Comment-only touch-up after a PASS (retro-harvest item 6). At a review PASS the reviewed working
// tree is recorded as a git tree object (the index plus every non-ignored worktree file, written
// through a temporary index, so a clean tree works the same). A later revision is withdrawn when the
// working tree differs from that snapshot only in docs (`*.md`, `docs/`) or in comments: each changed
// Go, Rust, TypeScript/JavaScript or Python file keeps identical code tokens once its comments are
// stripped and its whitespace normalised. String literals are kept verbatim (a `//` inside one is
// code). Anything this scanner is unsure of (unknown language, JSX, an unterminated literal, a
// directive comment such as `//go:build`, a Rust doctest fence, cgo) is NOT comment-only.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { langOf } from "./diffscan.ts";

const GIT_TIMEOUT_MS = 10_000;
const MAX_BLOB = 2_000_000;

export interface TreeSnap {
  cwd: string;
  tree: string;
}

/** A docs file: `*.md` anywhere, or anything under a `docs/` directory. */
export function isDocsPath(file: string): boolean {
  const p = file.replace(/\\/g, "/");
  return /\.md$/i.test(p) || /(^|\/)docs\//.test(p);
}

// ------------------------------------------------------------------ scanner

type Lang = "go" | "rust" | "ts" | "py";
const LIT = "\u0001";

class Scan {
  pos = 0;
  out = "";
  lits: string[] = [];
  readonly src: string;
  constructor(src: string) {
    this.src = src;
  }
  get done(): boolean {
    return this.pos >= this.src.length;
  }
  at(k = 0): string {
    return this.src[this.pos + k] ?? "";
  }
  starts(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }
  /** A literal from `from` to the current position: kept verbatim, a placeholder in the code. */
  lit(from: number): void {
    this.lits.push(this.src.slice(from, this.pos));
    this.out += LIT;
  }
  /** A comment from `from` to here: dropped; a newline inside a block comment stays a line break. */
  comment(from: number): void {
    this.out += this.src.slice(from, this.pos).includes("\n") ? "\n" : " ";
  }
}

class Doubt extends Error {}

/** Quoted literal up to an unescaped `q`; `multiline` false refuses a raw newline. */
function quoted(s: Scan, q: string, multiline: boolean, escapes = true): void {
  s.pos += q.length;
  for (;;) {
    if (s.done) throw new Doubt();
    if (escapes && s.at() === "\\") {
      s.pos += 2;
      continue;
    }
    if (s.starts(q)) {
      s.pos += q.length;
      return;
    }
    if (!multiline && s.at() === "\n") throw new Doubt();
    s.pos++;
  }
}

function lineComment(s: Scan): string {
  const from = s.pos;
  while (!s.done && s.at() !== "\n") s.pos++;
  return s.src.slice(from, s.pos);
}

function blockComment(s: Scan, nest: boolean): string {
  const from = s.pos;
  s.pos += 2;
  let depth = 1;
  while (depth > 0) {
    if (s.done) throw new Doubt();
    if (nest && s.starts("/*")) {
      depth++;
      s.pos += 2;
    } else if (s.starts("*/")) {
      depth--;
      s.pos += 2;
    } else s.pos++;
  }
  return s.src.slice(from, s.pos);
}

/** A comment the toolchain reads (build tags, compiler pragmas, type-checker switches): kept as code. */
function directive(lang: Lang, text: string, line: number): boolean {
  if (lang === "go") return /^\/\/(go:|line |export |extern |\s*\+build)/.test(text);
  if (lang === "ts") return /^\/\/\/\s*<(reference|amd)/.test(text) || /^\/[/*]\s*(@ts-|@jsx|#\s*source)/.test(text);
  if (lang === "py") return (line === 0 && text.startsWith("#!")) || (line < 2 && /coding[:=]/.test(text)) || /^#\s*type:/.test(text);
  return false;
}

function lineNo(s: Scan): number {
  let n = 0;
  for (let i = 0; i < s.pos; i++) if (s.src[i] === "\n") n++;
  return n;
}

function scanGo(s: Scan): void {
  if (/^\s*import\s+"C"/m.test(s.src)) throw new Doubt(); // cgo: the comment above import "C" is C code
  while (!s.done) {
    const from = s.pos;
    const c = s.at();
    if (s.starts("//")) {
      const t = lineComment(s);
      if (directive("go", t, 0)) s.out += t;
      else s.comment(from);
    } else if (s.starts("/*")) {
      blockComment(s, false);
      s.comment(from);
    } else if (c === '"' || c === "'") {
      quoted(s, c, false);
      s.lit(from);
    } else if (c === "`") {
      quoted(s, "`", true, false);
      s.lit(from);
    } else {
      s.out += c;
      s.pos++;
    }
  }
}

const RUST_CHAR = /'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F_]{1,6}\}|.)|[^\\'\n\r])'/uy;

function scanRust(s: Scan): void {
  while (!s.done) {
    const from = s.pos;
    const c = s.at();
    const prev = s.src[s.pos - 1] ?? "";
    const ident = /[A-Za-z0-9_]/.test(prev);
    if (s.starts("//")) {
      const t = lineComment(s);
      if (/^\/\/[/!]/.test(t) && t.includes("```")) throw new Doubt(); // doc comment fence: a doctest is code
      s.comment(from);
    } else if (s.starts("/*")) {
      const t = blockComment(s, true);
      if (/^\/\*[*!]/.test(t) && t.includes("```")) throw new Doubt();
      s.comment(from);
    } else if (!ident && /^(?:br|cr|r)#*"/.test(s.src.slice(s.pos, s.pos + 260))) {
      const m = /^(?:br|cr|r)(#*)"/.exec(s.src.slice(s.pos))!;
      s.pos += m[0].length - 1;
      quoted(s, `"${m[1]}`, true, false);
      s.lit(from);
    } else if (!ident && (s.starts('b"') || s.starts('c"'))) {
      s.pos++;
      quoted(s, '"', true);
      s.lit(from);
    } else if (c === '"') {
      quoted(s, '"', true);
      s.lit(from);
    } else if (c === "'") {
      RUST_CHAR.lastIndex = s.pos;
      const m = RUST_CHAR.exec(s.src);
      if (m) {
        s.pos += m[0].length;
        s.lit(from);
      } else {
        s.out += c; // a lifetime or a label
        s.pos++;
      }
    } else {
      s.out += c;
      s.pos++;
    }
  }
}

const REGEX_AFTER = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|in|of|void|delete|throw|new|yield|await|instanceof))\s*$/;

/** TypeScript / JavaScript code until `close` (a template `}`) or the end; returns at `close`. */
function scanTs(s: Scan, close: string | null): void {
  let depth = 0;
  while (!s.done) {
    const from = s.pos;
    const c = s.at();
    if (close && c === "}" && depth === 0) return;
    if (s.starts("//")) {
      const t = lineComment(s);
      if (directive("ts", t, 0)) s.out += t;
      else s.comment(from);
    } else if (s.starts("/*")) {
      const t = blockComment(s, false);
      if (directive("ts", t, 0)) s.out += t;
      else s.comment(from);
    } else if (c === '"' || c === "'") {
      quoted(s, c, false);
      s.lit(from);
    } else if (c === "`") {
      template(s);
      s.lit(from);
    } else if (c === "/" && REGEX_AFTER.test(s.out.slice(-40).replace(new RegExp(LIT, "g"), "x"))) {
      s.pos++;
      let cls = false;
      for (;;) {
        if (s.done || s.at() === "\n") throw new Doubt();
        const d = s.at();
        if (d === "\\") s.pos++;
        else if (d === "[") cls = true;
        else if (d === "]") cls = false;
        else if (d === "/" && !cls) break;
        s.pos++;
      }
      s.pos++;
      s.lit(from);
    } else {
      if (c === "{") depth++;
      if (c === "}") depth--;
      s.out += c;
      s.pos++;
    }
  }
  if (close) throw new Doubt();
}

/** A template literal with `${...}` fields scanned as code (their comments are not stripped: kept verbatim). */
function template(s: Scan): void {
  s.pos++;
  for (;;) {
    if (s.done) throw new Doubt();
    const c = s.at();
    if (c === "\\") s.pos += 2;
    else if (c === "`") {
      s.pos++;
      return;
    } else if (s.starts("${")) {
      s.pos += 2;
      const inner = new Scan(s.src);
      inner.pos = s.pos;
      scanTs(inner, "}");
      s.pos = inner.pos + 1;
    } else s.pos++;
  }
}

const PY_PREFIX = /(?:[rRbBuUfF]|[rR][bBfF]|[bBfF][rR])?(?:'''|"""|'|")/y;

function scanPy(s: Scan, close: string | null): void {
  let depth = 0;
  while (!s.done) {
    const from = s.pos;
    const c = s.at();
    if (close && c === "}" && depth === 0) return;
    const prev = s.src[s.pos - 1] ?? "";
    PY_PREFIX.lastIndex = s.pos;
    const m = /[A-Za-z0-9_]/.test(prev) ? null : PY_PREFIX.exec(s.src);
    if (c === "#") {
      const line = lineNo(s);
      const t = lineComment(s);
      if (directive("py", t, line)) s.out += t;
      else s.comment(from);
    } else if (m) {
      const q = m[0].replace(/^[A-Za-z]+/, "");
      const prefix = m[0].slice(0, m[0].length - q.length).toLowerCase();
      s.pos += prefix.length;
      if (prefix.includes("f")) fstring(s, q);
      else quoted(s, q, q.length === 3); // a backslash keeps the quote open in raw strings too
      s.lit(from);
    } else {
      if (c === "{") depth++;
      if (c === "}") depth--;
      s.out += c;
      s.pos++;
    }
  }
  if (close) throw new Doubt();
}

/** An f-string: `{...}` replacement fields (not `{{`) are scanned as code, nested quotes included. */
function fstring(s: Scan, q: string): void {
  s.pos += q.length;
  for (;;) {
    if (s.done) throw new Doubt();
    if (s.at() === "\\") {
      s.pos += 2;
      continue;
    }
    if (s.starts(q)) {
      s.pos += q.length;
      return;
    }
    if (q.length === 1 && s.at() === "\n") throw new Doubt();
    if (s.starts("{{") || s.starts("}}")) s.pos += 2;
    else if (s.at() === "{") {
      s.pos++;
      const inner = new Scan(s.src);
      inner.pos = s.pos;
      scanPy(inner, "}");
      s.pos = inner.pos + 1;
    } else s.pos++;
  }
}

/** Code without comments, whitespace normalised (Python keeps indentation), and the literals; null = unsure. */
export function codeTokens(lang: Lang, src: string): { code: string; lits: string[] } | null {
  if (src.includes(LIT)) return null;
  const s = new Scan(src.replace(/\r\n?/g, "\n"));
  try {
    if (lang === "go") scanGo(s);
    else if (lang === "rust") scanRust(s);
    else if (lang === "ts") scanTs(s, null);
    else scanPy(s, null);
  } catch (e) {
    if (e instanceof Doubt) return null;
    throw e;
  }
  const code = s.out
    .split("\n")
    .map((l) => {
      const body = l.replace(/[ \t\f\v]+/g, " ").trimEnd();
      return lang === "py" ? body : body.trimStart();
    })
    .filter((l) => l.trim() !== "")
    .join("\n");
  return { code, lits: s.lits };
}

/** True when `before` and `after` of `file` differ only in comments and whitespace (docs files always). */
export function isCommentOnlyChange(file: string, before: string, after: string): boolean {
  if (isDocsPath(file)) return true;
  if (/\.(tsx|jsx)$/i.test(file)) return false; // JSX text may hold `//`
  const lang = langOf(file);
  if (!lang) return false;
  const a = codeTokens(lang, before);
  const b = codeTokens(lang, after);
  if (!a || !b) return false;
  return a.code === b.code && a.lits.length === b.lits.length && a.lits.every((l, i) => l === b.lits[i]);
}

// ------------------------------------------------------------------ git side

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, env, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * MAX_BLOB, encoding: "utf8" }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/** The working tree of `cwd` as a git tree (index + non-ignored worktree files) via a temporary index; null on any failure. */
export async function worktreeTree(cwd: string): Promise<string | null> {
  const top = (await git(cwd, ["rev-parse", "--show-toplevel"]))?.trim();
  const idx = (await git(cwd, ["rev-parse", "--git-path", "index"]))?.trim();
  if (!top || !idx) return null;
  let dir: string | null = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-snap-"));
    const tmp = path.join(dir, "index");
    const real = path.resolve(cwd, idx);
    if (fs.existsSync(real)) fs.copyFileSync(real, tmp);
    const env = { ...process.env, GIT_INDEX_FILE: tmp };
    if ((await git(top, ["add", "-A"], env)) === null) return null;
    const tree = (await git(top, ["write-tree"], env))?.trim() ?? "";
    return /^[0-9a-f]{40,64}$/.test(tree) ? tree : null;
  } catch {
    return null;
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Files changed between the snapshot and the current working tree when every change is
 * comment-only (`.workflow/` ignored: ledger, notes, scratch); null when any change is code or the
 * check could not run. An empty list = nothing changed.
 */
export async function commentOnlySince(snap: TreeSnap): Promise<string[] | null> {
  const now = await worktreeTree(snap.cwd);
  if (!now) return null;
  const top = (await git(snap.cwd, ["rev-parse", "--show-toplevel"]))?.trim();
  const raw = top ? await git(top, ["diff-tree", "-r", "--no-renames", "-z", snap.tree, now]) : null;
  if (raw === null || !top) return null;
  const parts = raw.split("\0");
  const files: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) (\w)/.exec(parts[i]);
    const file = parts[i + 1];
    if (!m) return null;
    if (file.startsWith(".workflow/")) continue;
    files.push(file);
    if (isDocsPath(file)) continue;
    if (m[5] !== "M" || m[1] !== m[2] || !m[1].startsWith("100")) return null;
    const before = await git(top, ["cat-file", "blob", m[3]]);
    const after = await git(top, ["cat-file", "blob", m[4]]);
    if (before === null || after === null || before.length > MAX_BLOB || after.length > MAX_BLOB) return null;
    if (!isCommentOnlyChange(file, before, after)) return null;
  }
  return files;
}
