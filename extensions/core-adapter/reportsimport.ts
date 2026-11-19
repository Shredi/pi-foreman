// Reports of a parent-opened session reach the parent repository (docs/sessions.md, docs/retro.md): the report tool also appends each row to
// `reports.jsonl` in the session's handoff dir, and the parent imports that file (`foreman reports import`, or its watcher at a result, update or
// closed notice of a remote session). Everything read from outside is untrusted data: every row is checked again here and rebuilt from fields,
// never copied; nothing reads meaning from report text.
import * as fs from "node:fs";
import * as path from "node:path";
import { CAPS, EFFECTS, KINDS, cleanText, importRows, keyOf, type Store } from "./reports.ts";
import { withFileLock } from "./statefile.ts";
import { redactCommand } from "./trace.ts";

/** The file a parent-opened session keeps in its handoff dir. */
export const HANDOFF_REPORTS = "reports.jsonl";
/** An import file above this size is ignored: 20 rows per session and 5 per run stay far below it. */
export const IMPORT_MAX_BYTES = 512 * 1024;
/** A line above this length is skipped as invalid (the largest row is about 1 KB). */
export const IMPORT_MAX_LINE = 4096;
const FUTURE_MS = 86_400_000;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** Counts of one import; the trace event carries these and no text. */
export interface ImportCounts {
  /** Non-empty lines read. */
  lines: number;
  /** Rows appended to the store. */
  added: number;
  /** Valid rows whose id the store (or its archive) already holds. */
  known: number;
  malformed: number;
  notReport: number;
  otherRepo: number;
  invalid: number;
  /** The file was above `IMPORT_MAX_BYTES`: nothing was read. */
  oversized: boolean;
}

const emptyCounts = (): ImportCounts => ({ lines: 0, added: 0, known: 0, malformed: 0, notReport: 0, otherRepo: 0, invalid: 0, oversized: false });

/** A short field (role, branch, session, …): control characters turned into spaces, secrets masked, cut to 200; null when empty or not text. */
const field = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = redactCommand(v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")).trim().slice(0, 200);
  return t || null;
};

/** Text with a cap: null when it is not text or longer than `cap` (a row this long was not written by the tool). */
function capped(v: unknown, cap: number): string | null {
  if (typeof v !== "string" || v.length > cap) return null;
  return cleanText(v, cap) || null;
}

/** One row rebuilt from the fields the fold uses, or the reason it is skipped. `count`, `firstSeen`, `lastSeen` and `source` never survive. */
export function checkRow(raw: Json, repo: string | null, now: number): { row: Json } | { skip: "notReport" | "otherRepo" | "invalid" } {
  if (raw.row !== "report") return { skip: "notReport" };
  const rowRepo = typeof raw.repo === "string" && raw.repo ? raw.repo : null;
  if (repo === null || rowRepo === null || rowRepo !== repo) return { skip: "otherRepo" };
  const id = typeof raw.id === "string" && /^[0-9a-f]{10}$/.test(raw.id) ? raw.id : null;
  const kind = (KINDS as readonly unknown[]).includes(raw.kind) ? (raw.kind as string) : null;
  const effect = (EFFECTS as readonly unknown[]).includes(raw.effect) ? (raw.effect as string) : null;
  const subject = capped(raw.subject, CAPS.subject);
  const what = capped(raw.what, CAPS.what);
  const session = field(raw.session);
  const ts = typeof raw.ts === "string" ? Date.parse(raw.ts) : NaN;
  const suggest = raw.suggest === undefined || raw.suggest === null ? null : capped(raw.suggest, CAPS.suggest);
  const bad = raw.suggest !== undefined && raw.suggest !== null && (typeof raw.suggest !== "string" || raw.suggest.length > CAPS.suggest);
  if (!id || !kind || !effect || !subject || !what || !session || Number.isNaN(ts) || ts > now + FUTURE_MS || bad) return { skip: "invalid" };
  return {
    row: {
      row: "report", id, key: keyOf(kind, subject), kind, subject, what, effect, suggest, repo,
      workspace: field(raw.workspace), branch: field(raw.branch), role: field(raw.role), session, runId: field(raw.runId), version: field(raw.version), ts: new Date(ts).toISOString(),
    },
  };
}

/** Imports the rows of `text` (the lines of a `reports.jsonl`, LF or CRLF) into `store`. Only rows of `repo` count; the rest is skipped and counted. Never throws except when the store lock stays held. */
export function importText(store: Store, repo: string | null, text: string, now = Date.now()): ImportCounts {
  const c = emptyCounts();
  if (Buffer.byteLength(text, "utf8") > IMPORT_MAX_BYTES) return { ...c, oversized: true };
  const rows: Json[] = [];
  const seen = new Set<string>();
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    c.lines++;
    if (line.length > IMPORT_MAX_LINE) {
      c.invalid++;
      continue;
    }
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      c.malformed++;
      continue;
    }
    if (!isObj(v)) {
      c.malformed++;
      continue;
    }
    const r = checkRow(v, repo, now);
    if ("skip" in r) c[r.skip]++;
    else if (!seen.has(r.row.id as string)) {
      seen.add(r.row.id as string);
      rows.push(r.row);
    }
  }
  c.added = importRows(store, rows);
  c.known = rows.length - c.added;
  return c;
}

/** `importText` of a file; a missing, unreadable or oversized file is an empty import (`oversized` is set), never an error. */
export function importFile(store: Store, repo: string | null, file: string, now = Date.now()): ImportCounts {
  try {
    if (fs.statSync(file).size > IMPORT_MAX_BYTES) return { ...emptyCounts(), oversized: true };
    return importText(store, repo, fs.readFileSync(file, "utf8"), now);
  } catch (err) {
    if (/^locked/.test((err as Error).message)) throw err;
    return emptyCounts();
  }
}

/** The one trace event of an import: counts only. */
export const importEvent = (c: ImportCounts, from: string): Record<string, unknown> => ({ event: "reports_import", from, ...c });

/** Appends a stored row to `reports.jsonl` in `dir` (the handoff dir of a parent-opened session) under its own lock. Throws on failure; the caller treats that as best effort. */
export function appendHandoff(dir: string, row: Json): void {
  const file = path.join(dir, HANDOFF_REPORTS);
  withFileLock(`${file}.lock`, () => fs.appendFileSync(file, `${JSON.stringify(row)}\n`));
}
