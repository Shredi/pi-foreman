// The judge's file reads (docs/permissions.md "What it may read"): the judge may answer `read` with paths instead of a verdict; this module decides what of
// those paths is shown. Any absolute path is shown (labelled by the worktree, cwd or a helper's own folder it lies in, else by its filesystem root) except inside
// the Pi agent dir outside its allow-listed parts (the agent dir wins over a project root that contains it), and when an exclusion (secret paths, login and token
// files, git and Claude folders, histories) names it. The gate parses no command text: the model names the paths, this module checks the folder bound and the exclusions.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Json } from "./config.ts";
import { get } from "./config.ts";
import { secretPath } from "./floors.ts";
import type { FloorEnv } from "./floors.ts";
import { redactCommand } from "./trace.ts";

/** Entries directly under the Pi agent dir that may be read (everything else there stays closed). */
export const AGENT_ALLOW: readonly string[] = ["sessions", "agents", "skills", "prompts", "pi-foreman", "pi-subagents", "missions", "AGENTS.md", "foreman.json", "settings.json"];
export const MAX_FILE_BYTES = 16 * 1024;
export const MAX_FILE_LINES = 400;
export const MAX_JSONL_LINES = 40;
export const MAX_JSONL_LINE_CHARS = 1000;
/** The line scan reads at most this much of a file. */
export const MAX_SCAN_BYTES = 1024 * 1024;
export const MAX_LISTING = 200;
const MAX_LISTING_SCAN = 2000;
/** File block text over all rounds of one verdict. */
export const MAX_READ_BUDGET = 64 * 1024;
export const MAX_PATHS_PER_ROUND = 8;
export const MAX_PATH_CHARS = 500;
export const MAX_READ_ROUNDS = 2;
const LOG_PATH_CHARS = 200;

export interface ReadRoot {
  label: string;
  real: string;
  lex: string;
  /** A trusted install root (Pi, npm, the pi-foreman package): it wins over the agent dir when it lies inside it. */
  install?: boolean;
}

export interface JudgeReadScope {
  /** Relative paths of the judge resolve against this. */
  cwd: string;
  roots: ReadRoot[];
  agent?: { real: string; lex: string };
  platform: string;
  floorEnv: FloorEnv;
}

export type ReadOutcome = "ok" | "dir" | "not-found" | "withheld" | "outside" | "changed" | "binary" | "budget";

/** What one requested path gave (cache and log). */
export interface ReadRecord {
  asked: string;
  outcome: ReadOutcome;
  real?: string;
  /** Decimal strings of the bigint stat: a 64-bit NTFS file id loses its low bits as a double. */
  dev?: string;
  ino?: string;
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  ancestor?: string;
}

export interface ReadBlock {
  /** The path asked, the real path and the outcome. */
  header: string;
  body: string;
}

/** Test hook: runs between the check's stat and the open of a file or folder. */
export const readHooks: { afterStat?: (real: string) => void } = {};

const folds = (platform: string): boolean => platform === "darwin" || platform === "win32";
const fold = (platform: string, s: string): string => (folds(platform) ? s.toLowerCase() : s);

function inside(platform: string, child: string, root: string): boolean {
  const rel = path.relative(fold(platform, root), fold(platform, child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

const segs = (platform: string, root: string, child: string): string[] => {
  const rel = path.relative(fold(platform, root), fold(platform, child));
  return rel ? rel.split(path.sep) : [];
};

const realOf = (p: string): string | undefined => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return undefined;
  }
};

/**
 * The read scope of one judge call; undefined when `gate.judgeReads` is false. A project root that does not exist is dropped. Every other absolute path lies
 * in the root of its own filesystem (drive or share), so the exclusions alone decide what is shown.
 */
export function judgeReadScope(a: { cwd: string; worktree: string; out?: string; scratch?: string; agentDir: string; home?: string; platform?: string; config: Json | undefined; readRoots?: string[]; install?: string[] }): JudgeReadScope | undefined {
  if (get(a.config, "gate.judgeReads") === false) return undefined;
  const platform = a.platform ?? process.platform;
  const roots: ReadRoot[] = [];
  for (const [label, p] of [["<worktree>", a.worktree], ["<cwd>", a.cwd], ["<out>", a.out], ["<scratch>", a.scratch]] as const) {
    if (!p) continue;
    const real = realOf(p);
    if (!real) continue;
    if (roots.some((r) => fold(platform, r.real) === fold(platform, real))) continue;
    roots.push({ label, real, lex: path.resolve(p) });
  }
  // the session's read roots (pathrules.ts readRootsOfGate) and its install roots, as labelled roots like the worktree
  for (const [label, list, install] of [["<root>", a.readRoots ?? [], false], ["<install>", a.install ?? [], true]] as const) {
    for (const p of list) {
      const real = realOf(p);
      if (!real) continue;
      const dup = roots.findIndex((r) => fold(platform, r.real) === fold(platform, real));
      if (dup >= 0) {
        if (install) roots[dup].install = true;
        continue;
      }
      roots.push({ label, real, lex: path.resolve(p), ...(install ? { install: true } : {}) });
    }
  }
  const agentReal = realOf(a.agentDir);
  return {
    cwd: a.cwd,
    roots,
    ...(agentReal ? { agent: { real: agentReal, lex: path.resolve(a.agentDir) } } : {}),
    platform,
    floorEnv: { cwd: a.cwd, platform, agentDir: a.agentDir, ...(a.home ? { home: a.home } : {}) },
  };
}

// ------------------------------------------------------------------ the path check

const NAME_EXACT = new Set(["auth.json", "models.json", "models-store.json", "trust.json", "claude-bridge", ".git", ".claude", ".adb-mcp-backup", "cc-cli-logs", ".claude.json", ".envrc", ".pgpass", ".vault-token", ".history", "kubeconfig", ".htpasswd", "token.txt", ".secrets", "token"]);
const NAME_PREFIX = ["mcp.json", "claude-bridge", "claudecfg-", "claude-config"];

/** True when a path segment names a file or folder that is never shown. */
const withheldName = (seg: string): boolean => {
  const s = seg.toLowerCase();
  return NAME_EXACT.has(s) || s.startsWith("secrets.") || s.startsWith("secret.") || /^(service[-_]account|client_secret).*\.json$/.test(s) || s.endsWith(".token") || NAME_PREFIX.some((p) => s.startsWith(p)) || s.endsWith(".tfvars") || s.includes(".tfstate") || /^\..*_history$/.test(s);
};

interface Place {
  label: string;
  rel: string[];
  agent: boolean;
}

/** Where a real path lies: the agent dir first, else the most specific project root, else the root of its filesystem (drive or share on Windows); null only for a path without a root. */
function placeOf(real: string, scope: JudgeReadScope): Place | null {
  const pf = scope.platform;
  const installRoot = scope.roots.some((r) => r.install && inside(pf, real, r.real));
  if (scope.agent && !installRoot && inside(pf, real, scope.agent.real)) return { label: "<agent>", rel: segs(pf, scope.agent.real, real), agent: true };
  let best: ReadRoot | undefined;
  for (const r of scope.roots) if (inside(pf, real, r.real) && (!best || r.real.length > best.real.length)) best = r;
  if (best) return { label: best.label, rel: segs(pf, best.real, real), agent: false };
  const pp = pf === "win32" ? path.win32 : path;
  const top = pp.parse(real).root;
  if (!top) return null;
  const rel = pp.relative(top, real);
  return { label: `<${top}>`, rel: rel ? rel.split(pp.sep) : [], agent: false };
}

/** The segments a lexical path adds to the root it lies in (all of its segments when it lies in none). */
function lexicalSegs(lex: string, scope: JudgeReadScope): string[] {
  const pf = scope.platform;
  const roots = [...(scope.agent ? [scope.agent.lex] : []), ...scope.roots.map((r) => r.lex)].filter((r) => inside(pf, lex, r)).sort((a, b) => b.length - a.length);
  return roots.length ? segs(pf, roots[0], lex) : lex.split(/[\\/]/).filter(Boolean);
}

interface Resolution {
  outcome: "ok" | "dir" | "not-found" | "withheld" | "outside";
  real?: string;
  ancestor?: string;
  st?: fs.BigIntStats;
  window?: { from: number; to: number };
  /** The asked name, `#L…` suffix included, exists as it is and was read as that file. */
  literal?: boolean;
  why?: string;
}

const WINDOW = /^([\s\S]*)#L(\d+)-(\d+)$/;

/** The check of one asked path: bound first, then exclusions; a missing path is `not-found` only inside the bound. A file that exists under its literal name (`#L…` included) is read as that file. */
export function resolveReadable(asked: string, scope: JudgeReadScope): Resolution {
  const m = WINDOW.exec(asked);
  if (m) {
    // A name that exists (a link included) answers as itself; only a name that does not exist is read as a window.
    // The literal note shows only for a name that was read; any other outcome is the plain one, so the answer does not show that an unreadable name exists.
    if (literalExists(asked, scope)) {
      const literal = resolvePath(asked, undefined, scope);
      return literal.outcome === "ok" || literal.outcome === "dir" ? { ...literal, literal: true } : literal;
    }
  }
  return resolvePath(m ? m[1] : asked, m ? { from: Math.max(1, Number(m[2])), to: Math.max(1, Number(m[3])) } : undefined, scope);
}

/** The asked path with a leading `~` expanded, as a raw string: no normalizing, so the OS resolves `..` after the links before it. */
function expandAsked(asked: string, scope: JudgeReadScope): string {
  // A leading `~` is the home folder (headers and hints show it that way); `~user` and `$VAR` stay as they are. The expanded path is checked like any absolute one.
  const home = scope.floorEnv.home ?? os.homedir();
  if (home && (asked === "~" || asked.startsWith("~/") || (scope.platform === "win32" && asked.startsWith("~\\")))) return home + asked.slice(1);
  return asked;
}

/** True when the asked name exists as it is (a dangling link included). */
function literalExists(asked: string, scope: JudgeReadScope): boolean {
  const p = expandAsked(asked, scope);
  if (!p || p.includes("\0")) return false;
  try {
    fs.lstatSync(path.isAbsolute(p) ? p : scope.cwd + path.sep + p);
    return true;
  } catch {
    return false;
  }
}

/** The nearest existing folder is named only when a read there is allowed (same places and precedence as reads). */
function ancestorReadable(real: string, scope: JudgeReadScope): boolean {
  const place = placeOf(real, scope);
  if (!place) return false;
  return !place.agent || AGENT_ALLOW.some((n) => fold(scope.platform, n) === fold(scope.platform, place.rel[0] ?? ""));
}

/** True when a path lies in a place that is never shown: a withheld segment (`extra` are more segments to test), the agent `pi-foreman/remote/` folder, or a secret path. */
function withheldPlace(real: string, place: Place, scope: JudgeReadScope, extra: string[] = [], lex?: string): boolean {
  const pf = scope.platform;
  if ([...place.rel, ...extra].some(withheldName)) return true;
  if (place.agent && fold(pf, place.rel[0] ?? "") === "pi-foreman" && fold(pf, place.rel[1] ?? "") === "remote") return true;
  return secretPath(real, scope.floorEnv, true) !== null || (lex !== undefined && secretPath(lex, scope.floorEnv, true) !== null);
}

/** True when a place may be shown: a project root, or an allow-listed part of the agent dir. */
function readablePlace(place: Place | null, scope: JudgeReadScope): place is Place {
  return !!place && (!place.agent || AGENT_ALLOW.some((n) => fold(scope.platform, n) === fold(scope.platform, place.rel[0] ?? "")));
}

/** True when every `..` of the raw path follows a prefix that lies in a readable place and is not withheld; a `..` after a withheld or outside folder would show whether that folder exists. */
function dotDotsReadable(p: string, scope: JudgeReadScope): boolean {
  const parts = p.split(scope.platform === "win32" ? /[\\/]/ : "/");
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] !== "..") continue;
    const raw = parts.slice(0, i).join(path.sep);
    const prefix = path.isAbsolute(p) ? raw || path.sep : raw ? scope.cwd + path.sep + raw : scope.cwd;
    const real = realOf(prefix);
    if (!real) return false;
    const place = placeOf(real, scope);
    if (!readablePlace(place, scope) || withheldPlace(real, place, scope, lexicalSegs(path.resolve(prefix), scope))) return false;
  }
  return true;
}

function resolvePath(asked: string, window: { from: number; to: number } | undefined, scope: JudgeReadScope): Resolution {
  const p = expandAsked(asked, scope);
  const outside = (): Resolution => ({ outcome: "outside" });
  if (!p || p.includes("\0")) return outside();
  if (!dotDotsReadable(p, scope)) return outside();
  let lex: string;
  let anc: string;
  const tail: string[] = [];
  let realAnc: string;
  try {
    lex = path.resolve(scope.cwd, p);
    // The OS resolves `..` after the links before it; so the raw joined string goes to realpath, with no normalizing first.
    anc = path.isAbsolute(p) ? p : scope.cwd + path.sep + p;
    for (;;) {
      try {
        realAnc = fs.realpathSync.native(anc);
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") return outside();
        // `file/` fails with ENOTDIR on some platforms; an existing non-folder with a trailing separator gets the same "not a folder" answer everywhere.
        if (!tail.length && (scope.platform === "win32" ? /[\\/]$/ : /\/$/).test(anc) && anc.length > 1) {
          const bare = realOf(anc.replace(scope.platform === "win32" ? /[\\/]+$/ : /\/+$/, ""));
          if (bare && !fs.lstatSync(bare).isDirectory()) {
            realAnc = bare;
            break;
          }
        }
      }
      const parent = path.dirname(anc);
      if (parent === anc) return outside();
      tail.unshift(path.basename(anc));
      anc = parent;
    }
  } catch {
    return outside();
  }
  const target = tail.length ? path.join(realAnc, ...tail) : realAnc;
  const place = placeOf(target, scope);
  if (!place) return outside();
  if (!readablePlace(place, scope)) return outside();
  if (withheldPlace(target, place, scope, lexicalSegs(lex, scope), lex)) return { outcome: "withheld", real: target, window };
  if (tail.length) {
    if (!ancestorReadable(realAnc, scope)) return outside();
    // A withheld folder is never the hint: the hint is the nearest folder above it that is not withheld, so the answer is the same whether the withheld folder exists or not.
    let hint = realAnc;
    for (;;) {
      const hp = placeOf(hint, scope);
      if (!hp) return outside();
      if (!withheldPlace(hint, hp, scope)) break;
      const up = path.dirname(hint);
      if (up === hint) return outside();
      hint = up;
    }
    if (!ancestorReadable(hint, scope)) return outside();
    return { outcome: "not-found", real: target, ancestor: hint, window };
  }
  let st: fs.BigIntStats;
  try {
    st = fs.lstatSync(target, { bigint: true });
  } catch {
    return { outcome: "not-found", real: target, ancestor: realAnc, window };
  }
  if (st.isDirectory()) return { outcome: "dir", real: target, st, window };
  if (!st.isFile()) return { outcome: "withheld", real: target, window, why: "not a regular file" };
  if (st.nlink > 1n) return { outcome: "withheld", real: target, window, why: "more than one hard link" };
  return { outcome: "ok", real: target, st, window };
}

// ------------------------------------------------------------------ reading

const msOf = (ns: bigint): number => Number(ns) / 1e6;

const ofStat = (st: fs.BigIntStats): Pick<ReadRecord, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs"> => ({ dev: String(st.dev), ino: String(st.ino), size: Number(st.size), mtimeMs: msOf(st.mtimeNs), ctimeMs: msOf(st.ctimeNs) });

/** True when two bigint stats name the same file in the same state (device, full-width inode, size, times). */
export function sameFileState(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

const KEY_TOKEN = /\b(?:gh[pousr]_|github_pat_|npm_|glpat-|sk-|xox[abprs]-)[A-Za-z0-9_-]{6,}|\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b|\bAIza[A-Za-z0-9_-]{6,}/g;
const KEY_PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;
const KEY_NAME = /password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|(?:^|[_-])auth(?:$|[_-])/i;
const KEY_ASSIGN = /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]+)(\\?["']?\s*[:=]\s*)(\\?"[^"\\\n]*\\?"|\\?'[^'\\\n]*\\?'|[^\s'",;]+)/g;

/**
 * File text as the judge sees it: only real key shapes are hidden (known token prefixes, PEM private-key blocks, the literal value of a secret-named key). Code,
 * identifiers and hashes pass. Newlines are kept, so the line numbers of a window stay true. (Trace and command masking is `redactCommand`, which also hides long runs.)
 */
export function maskKeys(text: string): string {
  const R = "[redacted]";
  return text
    .replace(KEY_PEM, (m) => R + m.replace(/[^\n]/g, "").replace(/\r/g, ""))
    .replace(KEY_TOKEN, R)
    .replace(KEY_ASSIGN, (m: string, name: string, sep: string, value: string) => {
      if (!KEY_NAME.test(name)) return m;
      const quoted = /^\\?["']/.test(value);
      if (quoted) return value.replace(/^\\?["']|\\?["']$/g, "").length > 0 ? `${name}${sep}${R}` : m;
      return value.length >= 12 && /\d/.test(value) && !/[()$]/.test(value) ? `${name}${sep}${R}` : m;
    });
}

function readFileBlock(res: Resolution & { real: string; st: fs.BigIntStats }, asked: string, scope: JudgeReadScope, budget: { left: number }): { outcome: ReadOutcome; body: string } {
  const win32 = scope.platform === "win32";
  const flags = fs.constants.O_RDONLY | (win32 ? 0 : (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  readHooks.afterStat?.(res.real);
  let fd: number | undefined;
  try {
    fd = fs.openSync(res.real, flags);
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n || !sameFileState(st, res.st)) return { outcome: "changed", body: "changed while it was read: not shown" };
    if (realOf(res.real) !== res.real) return { outcome: "changed", body: "changed while it was read: not shown" };
    const size = Number(st.size);
    const buf = Buffer.alloc(Math.min(size, MAX_SCAN_BYTES));
    const n = buf.length ? fs.readSync(fd, buf, 0, buf.length, 0) : 0;
    const data = buf.subarray(0, n);
    if (data.subarray(0, 8192).includes(0)) return { outcome: "binary", body: "binary file, not shown" };
    const partial = size > MAX_SCAN_BYTES;
    const text = maskKeys(data.toString("utf8"));
    const lines = text.split("\n");
    if (text.endsWith("\n")) lines.pop();
    const jsonl = /\.jsonl$/i.test(res.real);
    const from = res.window?.from ?? 1;
    const wanted = res.window ? Math.max(1, res.window.to - from + 1) : MAX_FILE_LINES;
    const count = Math.min(MAX_FILE_LINES, wanted, jsonl ? MAX_JSONL_LINES : MAX_FILE_LINES);
    if (from > lines.length) return { outcome: "ok", body: `(no lines from ${from}: the file has ${lines.length} lines${partial ? " in its first 1 MiB" : ""})` };
    // The text is masked as a whole before any window or cut, so a cut never leaves half a secret; the last line of a file the scan stopped inside carries `[cut]`.
    const scanCut = partial && !text.endsWith("\n");
    const slice = lines.slice(from - 1, from - 1 + count).map((l, i) => {
      const lastOfScan = scanCut && from - 1 + i === lines.length - 1;
      if (!jsonl && !lastOfScan) return l;
      let masked = l;
      if (jsonl && masked.length > MAX_JSONL_LINE_CHARS) masked = `${masked.slice(0, MAX_JSONL_LINE_CHARS)} [cut]`;
      return lastOfScan && !masked.endsWith(" [cut]") ? `${masked} [cut]` : masked;
    });
    let body = slice.join("\n");
    const more = from - 1 + slice.length < lines.length || partial;
    if (budget.left <= 0) return { outcome: "budget", body: "not read: read budget used up" };
    const cap = Math.min(MAX_FILE_BYTES, budget.left);
    // The cut falls on a line boundary; `last` is the last line shown whole. When not even the first line fits, that line is shown cut and the hint
    // continues at the next line (the rest of the long line is not offered again).
    // The walk stops at the first line that does not fit.
    const shownLines: string[] = [];
    let used = 0;
    let k = 0;
    let first = "";
    for (; k < slice.length; k++) {
      const masked = slice[k];
      if (k === 0) first = masked;
      if (used + (k ? 1 : 0) + masked.length > cap) break;
      used += (k ? 1 : 0) + masked.length;
      shownLines.push(masked);
    }
    const cut = k < slice.length;
    body = k ? shownLines.join("\n") : `${first.slice(0, cap)} [cut]`;
    budget.left -= cut ? cap : body.length; // a cut file used its whole share
    const last = from + Math.max(k, 1) - 1;
    const note = cut ? `\n[cut at ${cap} characters]` : "";
    const base = (res.literal ? asked : WINDOW.exec(asked)?.[1] ?? asked).replace(/[\\/]+$/, "");
    const next = more || cut ? `\n[more of this file: ask ${base}#L${last + 1}-${last + MAX_FILE_LINES}]` : "";
    return { outcome: "ok", body: `lines ${from}-${last}\n${body}${note}${next}` };
  } catch {
    return { outcome: "changed", body: "changed while it was read: not shown" };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // a failed close changes nothing
      }
    }
  }
}

/** Shows control characters (newline, CR, tab, other C0, DEL, NEL, line and paragraph separators, bidi controls) as escapes so one name or path part is always one line. */
function escapeControl(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f\u0085\p{Zl}\p{Zp}\u{202a}-\u{202e}\u{2066}-\u{2069}\u200e\u200f\u061c]/gu, (c) => {
    if (c === "\n") return "\\n";
    if (c === "\r") return "\\r";
    if (c === "\t") return "\\t";
    const n = c.charCodeAt(0);
    return n > 0xff ? `\\u${n.toString(16).padStart(4, "0")}` : `\\x${n.toString(16).padStart(2, "0")}`;
  });
}

function listFolder(res: Resolution & { real: string }, scope: JudgeReadScope, budget: { left: number }): { outcome: ReadOutcome; body: string } {
  if (budget.left <= 0) return { outcome: "budget", body: "not read: read budget used up" };
  readHooks.afterStat?.(res.real);
  let names: string[] = [];
  let dir: fs.Dir | undefined;
  try {
    dir = fs.opendirSync(res.real);
    for (let e = dir.readSync(); e && names.length < MAX_LISTING_SCAN; e = dir.readSync()) names.push(e.name);
  } catch {
    return { outcome: "changed", body: "changed while it was read: not shown" };
  } finally {
    try {
      dir?.closeSync();
    } catch {
      // a failed close changes nothing
    }
  }
  if (realOf(res.real) !== res.real) return { outcome: "changed", body: "changed while it was read: not shown" };
  names.sort();
  const shown: string[] = [];
  for (const n of names) {
    if (shown.length >= MAX_LISTING) break;
    const r = resolveReadable(path.join(res.real, n), scope);
    if (r.outcome === "ok") shown.push(escapeControl(n));
    else if (r.outcome === "dir") shown.push(`${escapeControl(n)}/`);
  }
  const listed = shown.slice(0, MAX_LISTING);
  const hidden = names.length - listed.length;
  let body = `${listed.map((l) => redactCommand(l)).join("\n")}${listed.length ? "\n" : ""}(${listed.length} entries shown${hidden > 0 ? `, ${hidden} not shown` : ""})`;
  if (body.length > budget.left) {
    const mark = "\n[cut]";
    if (budget.left <= mark.length) return { outcome: "budget", body: "not read: read budget used up" };
    body = body.slice(0, budget.left - mark.length) + mark;
  }
  budget.left -= body.length;
  return { outcome: "dir", body };
}

/** The path of a block header: relative to the cwd when inside it, else absolute; what the judge can ask again. */
function askable(real: string, scope: JudgeReadScope): string {
  const root = realOf(scope.cwd) ?? path.resolve(scope.cwd);
  return inside(scope.platform, real, root) ? path.relative(root, real) || "." : real;
}

const HEADER_NOTE: Record<ReadOutcome, string> = { ok: "file", dir: "folder", "not-found": "not found", withheld: "withheld: not shown", outside: "outside the places you may read", changed: "changed while it was read: not shown", binary: "binary", budget: "not read: read budget used up" };

/** Reads the asked paths of one round (at most `MAX_PATHS_PER_ROUND` are expected; the parser checks). `budget.left` is shared over the rounds of a verdict. */
export function readPaths(asked: string[], scope: JudgeReadScope, budget: { left: number }): { blocks: ReadBlock[]; records: ReadRecord[] } {
  const blocks: ReadBlock[] = [];
  const records: ReadRecord[] = [];
  for (const a of asked) {
    let res: Resolution;
    try {
      res = resolveReadable(a, scope);
    } catch {
      res = { outcome: "outside" };
    }
    const rec: ReadRecord = { asked: a, outcome: res.outcome };
    let body = "";
    let fileText = false; // file text is masked by `maskKeys` already
    if (res.outcome === "not-found") {
      rec.real = res.real;
      rec.ancestor = res.ancestor;
      body = res.ancestor ? `(not found; nearest existing folder: ${escapeControl(res.ancestor)})` : "(not found)";
    } else if (res.outcome === "withheld") {
      rec.real = res.real;
      body = "(withheld: this path is never shown)";
    } else if (res.outcome === "outside") {
      body = "(outside the places you may read)";
    } else if (res.outcome === "dir") {
      rec.real = res.real;
      if (res.st) rec.mtimeMs = msOf(res.st.mtimeNs);
      const r = listFolder(res as Resolution & { real: string }, scope, budget);
      rec.outcome = r.outcome;
      body = r.body;
    } else if ((scope.platform === "win32" ? /[\\/]$/ : /\/$/).test(a.replace(/#L\d+-\d+$/, ""))) {
      rec.real = res.real;
      rec.outcome = "withheld";
      body = "(not a folder)";
    } else {
      rec.real = res.real;
      Object.assign(rec, ofStat(res.st as fs.BigIntStats));
      if (budget.left <= 0) {
        rec.outcome = "budget";
        body = "not read: read budget used up";
      } else {
        const r = readFileBlock(res as Resolution & { real: string; st: fs.BigIntStats }, a, scope, budget);
        rec.outcome = r.outcome;
        body = r.body;
        fileText = true;
      }
    }
    records.push(rec);
    blocks.push({ header: `${redactCommand(escapeControl(a))} -> ${rec.real ? redactCommand(escapeControl(askable(rec.real, scope))) : "-"} (${HEADER_NOTE[rec.outcome]}${res.literal ? "; read by its literal name, no line window" : ""})`, body: fileText ? body : body.split("\n").map(redactCommand).join("\n") });
  }
  return { blocks, records };
}

// ------------------------------------------------------------------ cache and log

const classOf = (o: ReadOutcome): string => (o === "ok" || o === "binary" || o === "budget" ? "ok" : o);

/** True when every record still gives the same outcome, real path and file identity (or folder time); any doubt is false. */
export function readsUnchanged(records: ReadRecord[], scope: JudgeReadScope): boolean {
  try {
    for (const r of records) {
      if (r.outcome === "changed") return false;
      const now = resolveReadable(r.asked, scope);
      if (now.outcome !== classOf(r.outcome)) return false;
      if ((now.real ?? undefined) !== r.real) return false;
      if (now.outcome === "ok" && (!now.st || String(now.st.dev) !== r.dev || String(now.st.ino) !== r.ino || Number(now.st.size) !== r.size || msOf(now.st.mtimeNs) !== r.mtimeMs || msOf(now.st.ctimeNs) !== r.ctimeMs)) return false;
      if (now.outcome === "dir" && (!now.st || msOf(now.st.mtimeNs) !== r.mtimeMs)) return false;
      if (now.outcome === "not-found" && now.ancestor !== r.ancestor) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** The gate-log form of the records: root label plus relative tail, then `:outcome` unless the path was shown; secrets masked, 200 characters each. */
export function readLogPaths(records: ReadRecord[], scope: JudgeReadScope): string[] {
  return records.map((r) => {
    const place = r.real ? placeOf(r.real, scope) : null;
    const base = place ? [place.label, ...place.rel].join("/") : "<outside>";
    const tag = r.outcome === "ok" ? "" : r.outcome === "dir" ? "/" : `:${r.outcome}`;
    return redactCommand(`${base}${tag}`).slice(0, LOG_PATH_CHARS);
  });
}
