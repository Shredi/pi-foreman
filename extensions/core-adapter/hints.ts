// Ledger hints (item 11): one indented, dated line under a ledger item per foreman_ledger action,
// child launch and reviewer verdict: `  > YYYY-MM-DD <text>`, at most HINT_MAX per item (oldest
// dropped). The vendored core ledger.py ignores such lines (no box, no id), so status, mark, defer,
// add and note keep counting items as before. Pure text logic here; index.ts reads and writes the
// file and keeps the session's recent hints for the compaction digest (retrodigest.ts).
import * as fs from "node:fs";
import * as path from "node:path";

export const HINT_MAX = 3;
/** Maximum characters of `> YYYY-MM-DD <text>` (the indent is not counted). */
export const HINT_LEN = 120;

const ITEM_LINE = /^(\s*)[-*] \[.\]\s+(?:deferred:.*? — )?(\d+|V)\.(?:\s|$)/;
const HINT_LINE = /^\s*> \d{4}-\d{2}-\d{2} /;

/** `> <date> <text>` on one line, bounded to HINT_LEN characters. */
export function hintText(date: string, text: string): string {
  const one = `> ${date} ${text.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim()}`;
  return one.length > HINT_LEN ? `${one.slice(0, HINT_LEN - 1)}…` : one;
}

/** Item ids present in the ledger (fenced blocks skipped), in file order. */
export function ledgerIds(file: string): string[] {
  const ids: string[] = [];
  let fenced = false;
  for (const line of file.split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    const m = fenced ? null : ITEM_LINE.exec(line);
    if (m) ids.push(m[2]);
  }
  return ids;
}

/**
 * Item ids a launch task cites: `item 3`, `items 1, 2 and V`, `#4`, or a line that starts with
 * `N.` / `V.` (a quoted ledger line). Upper-cased, de-duplicated, in order of appearance.
 */
export function citedItems(task: string): string[] {
  const out: string[] = [];
  const add = (id: string): void => {
    const v = id.toUpperCase();
    if (!out.includes(v)) out.push(v);
  };
  for (const m of task.matchAll(/\bitems?\s+((?:\d+|V)\b(?:\s*(?:,|and|&)\s*(?:\d+|V)\b)*)/gi)) for (const id of m[1].split(/\s*(?:,|and|&)\s*/i)) add(id);
  for (const m of task.matchAll(/#(\d+)\b/g)) add(m[1]);
  for (const m of task.matchAll(/^\s*(?:[-*] \[.\]\s+)?(\d+|V)\.\s/gm)) add(m[1]);
  return out;
}

/** The cited ids that exist in the ledger; none -> V (when the ledger has one). */
export function hintTargets(cited: readonly string[], file: string): string[] {
  const ids = ledgerIds(file);
  const hit = cited.filter((c) => ids.includes(c));
  if (hit.length) return hit;
  return ids.includes("V") ? ["V"] : [];
}

/**
 * Append `hint` (from hintText) under each item of `ids`, keeping at most `max` hint lines per
 * item (the oldest dropped). Unknown ids are skipped. The file's line endings are kept.
 */
export function addHints(file: string, ids: readonly string[], hint: string, max = HINT_MAX): { file: string; added: string[] } {
  const eol = file.includes("\r\n") ? "\r\n" : "\n";
  const lines = file.split(/\r?\n/);
  const added: string[] = [];
  for (const id of ids) {
    let fenced = false;
    let at = -1;
    let indent = "";
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trimStart().startsWith("```")) {
        fenced = !fenced;
        continue;
      }
      const m = fenced ? null : ITEM_LINE.exec(lines[i]);
      if (m && m[2] === id) {
        at = i;
        indent = m[1];
        break;
      }
    }
    if (at < 0) continue;
    let end = at + 1;
    while (end < lines.length && HINT_LINE.test(lines[end])) end++;
    const kept = lines.slice(at + 1, end);
    kept.push(`${indent}  ${hint}`);
    lines.splice(at + 1, end - at - 1, ...kept.slice(Math.max(0, kept.length - max)));
    added.push(id);
  }
  return { file: lines.join(eol), added };
}

/**
 * The hint of one foreman_ledger call: its items ("1,2" or "V"; an add's new number from the
 * script output) and text. Null for status (nothing changed).
 */
export function ledgerHint(action: string, items: string, output: string, text: unknown): { ids: string[]; text: string } | null {
  if (action === "status") return null;
  const ids = (items || (/^added (\d+):/m.exec(output)?.[1] ?? "")).split(",").filter(Boolean);
  const t = typeof text === "string" && text.trim() ? `: ${text.trim()}` : "";
  return { ids, text: `ledger ${action}${t}` };
}

/** Recent hints of a session, newest last, bounded (the compaction digest shows the last few). */
export class HintLog {
  private items: string[] = [];
  private readonly cap: number;
  constructor(cap = 32) {
    this.cap = cap;
  }
  push(id: string, hint: string): void {
    this.items.push(`${id}: ${hint.replace(/^> /, "")}`);
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
  }
  last(n: number): string[] {
    return this.items.slice(-n);
  }
}

/** Rename errors that Windows gives while another process holds the ledger open (a test poll, antivirus, an editor). */
const RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
/** Sleep before each retry, ms: 8 rename attempts, 127 ms in all. */
const BACKOFF_MS = [1, 2, 4, 8, 16, 32, 64];

/** A hint the ledger did not take: the error code of the failing step and the rename calls made (0 when the temp file could not be written). */
export interface HintFailure {
  code: string;
  attempts: number;
}

export interface HintWriteOpts {
  /** Date of the hint line (default: now). */
  now?: Date;
  /** The rename (default fs.renameSync); injected by tests. */
  rename?: (from: string, to: string) => void;
  /** Called once when the hint could not be written; the ledger is left as it was. */
  onFail?: (f: HintFailure) => void;
}

/** HintWriteOpts whose give-up is emitted as a `hint_write_failed {code, attempts}` trace record. */
export function hintFailTrace(emit: (rec: Record<string, unknown>) => void): HintWriteOpts {
  return { onFail: (f) => emit({ event: "hint_write_failed", code: f.code, attempts: f.attempts }) };
}

/**
 * fs.renameSync with a bounded, synchronous retry on the sharing errors (EPERM, EACCES, EBUSY). Any
 * other error, or the last retryable one, is returned with the attempts made.
 */
export function renameRetry(from: string, to: string, rename: (a: string, b: string) => void = fs.renameSync): { attempts: number; error?: NodeJS.ErrnoException } {
  for (let attempts = 1; ; attempts++) {
    try {
      rename(from, to);
      return { attempts };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (!RETRY_CODES.has(e.code ?? "") || attempts > BACKOFF_MS.length) return { attempts, error: e };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BACKOFF_MS[attempts - 1]);
    }
  }
}

/**
 * Write a hint under the cited items of the ledger file (V when none is cited or found). Best
 * effort: an unreadable or vanished ledger is skipped. Returns the item ids that got the hint. A
 * write that fails after the retries is reported through `opts.onFail`, never swallowed.
 */
export function writeHint(ledgerPath: string | null, cited: readonly string[], text: string, log?: HintLog, opts: HintWriteOpts = {}): string[] {
  if (!ledgerPath) return [];
  let file: string;
  try {
    file = fs.readFileSync(ledgerPath, "utf8");
  } catch {
    return [];
  }
  const hint = hintText((opts.now ?? new Date()).toISOString().slice(0, 10), text);
  const r = addHints(file, hintTargets(cited, file), hint);
  if (!r.added.length) return [];
  const tmp = path.join(path.dirname(ledgerPath), `.ledger-hint-${process.pid}-${Date.now()}.tmp`);
  const fail = (err: unknown, attempts: number): string[] => {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
    opts.onFail?.({ code: (err as NodeJS.ErrnoException).code ?? "UNKNOWN", attempts });
    return [];
  };
  try {
    fs.writeFileSync(tmp, r.file, "utf8");
  } catch (err) {
    return fail(err, 0);
  }
  try {
    fs.chmodSync(tmp, fs.statSync(ledgerPath).mode & 0o7777);
  } catch {
    // keep the default mode
  }
  const res = renameRetry(tmp, ledgerPath, opts.rename);
  if (res.error) return fail(res.error, res.attempts);
  for (const id of r.added) log?.push(id, hint);
  return r.added;
}
