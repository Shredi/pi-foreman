// Structured review verdicts (docs/review.md, "review_verdict"). A reviewer child hands its verdict, the result per ledger item and its
// findings over as data: the child adapter's `review_verdict` tool writes `verdict.json` into a record folder the parent made for the launch
// (its path travels in the launch binding, `verdictDir`; floors.ts protects the tree, like state/child-asks). The parent reads the record once
// per run end and every gate takes its fields; no gate reads the report text. This module is both sides: the schema check the tool and the
// parent share, the record files, and the folder names.
import * as fs from "node:fs";
import * as path from "node:path";

export const VERDICT_TOOL = "review_verdict";
export const VERDICT_FILE = "verdict.json";

export const VERDICT_VALUES = ["pass", "fail", "incomplete"] as const;
export type VerdictValue = (typeof VERDICT_VALUES)[number];
export const ITEM_RESULTS = ["pass", "fail", "open"] as const;
export type ItemResult = (typeof ITEM_RESULTS)[number];
export const FINDING_KINDS = ["defect", "now", "later"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];
/** The classes of scripts/foreman_findings.py CLASSES. */
export const FINDING_CLASSES = ["auth", "shell-injection", "path-traversal", "secret-log", "off-by-one", "resource-leak", "race", "swallowed-error", "insecure-default"] as const;

export const MAX_ITEMS = 64;
export const MAX_FINDINGS = 50;
const NOTE_MAX = 200;
const TEXT_MAX = 300;
const FILE_MAX = 200;
const REASON_MAX = 300;

/** The reason a reviewer child writes itself when `review_verdict` is not in its tool list (settings not regenerated, A6). Harness text, no model text. */
export const NO_TOOL_REASON = "review_verdict is not in this reviewer's tool list; run /foreman setup";

/** A ledger item of a launch: a number, or "V" (the final check). */
export type ItemId = number | "V";

export interface VerdictItem {
  id: ItemId;
  result: ItemResult;
  note?: string;
}

export interface VerdictFinding {
  kind: FindingKind;
  text: string;
  file?: string;
  line?: number;
  class?: string;
}

export interface VerdictRecord {
  v: 1;
  launchId: string;
  verdict: VerdictValue;
  items: VerdictItem[];
  findings: VerdictFinding[];
  reason?: string;
  at: string;
}

/** The fields of a verdict call (the tool parameters) after the check. */
export interface VerdictCall {
  verdict: VerdictValue;
  items: VerdictItem[];
  findings: VerdictFinding[];
  reason?: string;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const oneLine = (s: string): boolean => !/[\r\n]/.test(s);
const idText = (id: ItemId): string => String(id);
const list = (xs: readonly string[]): string => xs.join(", ");

/** One item id of a launch `items` field or a verdict item: a positive integer, a numeral string, or "V". */
export function itemIdOf(v: unknown): ItemId | null {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (/^[vV]$/.test(t)) return "V";
    if (/^[1-9]\d*$/.test(t)) return Number(t);
  }
  return null;
}

/**
 * The check of a verdict call, in the order of docs/review.md: the schema, the caps, the item ids against `allowed` (the launch's items), then the
 * pass/fail rules. The error names the valid choices, so the reviewer corrects the call in the same turn. `allowed` is the whole list of ids the
 * launch accepts (a `[high-stakes]` launch: none).
 */
export function checkVerdictCall(params: unknown, allowed: readonly ItemId[]): { error: string } | { call: VerdictCall } {
  if (!isObj(params)) return { error: `${VERDICT_TOOL}: the call needs a verdict: ${list(VERDICT_VALUES)}.` };
  const verdict = params.verdict;
  if (typeof verdict !== "string" || !(VERDICT_VALUES as readonly string[]).includes(verdict)) return { error: `${VERDICT_TOOL}: verdict must be one of ${list(VERDICT_VALUES)}.` };
  const rawItems = params.items === undefined ? [] : params.items;
  if (!Array.isArray(rawItems)) return { error: `${VERDICT_TOOL}: items is a list of {id, result, note?}.` };
  if (rawItems.length > MAX_ITEMS) return { error: `${VERDICT_TOOL}: at most ${MAX_ITEMS} items per call.` };
  const items: VerdictItem[] = [];
  const seen = new Set<string>();
  const valid = allowed.length > 0 ? `the items of this launch are ${list(allowed.map(idText))}` : "this launch takes no items";
  for (const raw of rawItems) {
    if (!isObj(raw)) return { error: `${VERDICT_TOOL}: each item is {id, result, note?}.` };
    const id = itemIdOf(raw.id);
    if (id === null) return { error: `${VERDICT_TOOL}: an item id is an item number or "V"; ${valid}.` };
    if (!allowed.includes(id)) return { error: `${VERDICT_TOOL}: item ${id} is not one of this launch's items: ${valid}. Leave it out or correct the id.` };
    if (seen.has(idText(id))) return { error: `${VERDICT_TOOL}: item ${id} is given twice; give each item once.` };
    seen.add(idText(id));
    if (typeof raw.result !== "string" || !(ITEM_RESULTS as readonly string[]).includes(raw.result)) return { error: `${VERDICT_TOOL}: the result of item ${id} must be one of ${list(ITEM_RESULTS)}.` };
    const item: VerdictItem = { id, result: raw.result as ItemResult };
    if (raw.note !== undefined) {
      if (typeof raw.note !== "string" || !oneLine(raw.note) || raw.note.length > NOTE_MAX) return { error: `${VERDICT_TOOL}: the note of item ${id} is one line, at most ${NOTE_MAX} characters.` };
      if (raw.note.trim()) item.note = raw.note.trim();
    }
    items.push(item);
  }
  const rawFindings = params.findings === undefined ? [] : params.findings;
  if (!Array.isArray(rawFindings)) return { error: `${VERDICT_TOOL}: findings is a list of {kind, text, file?, line?, class?}.` };
  if (rawFindings.length > MAX_FINDINGS) return { error: `${VERDICT_TOOL}: at most ${MAX_FINDINGS} findings per call.` };
  const findings: VerdictFinding[] = [];
  for (const raw of rawFindings) {
    if (!isObj(raw)) return { error: `${VERDICT_TOOL}: each finding is {kind, text, file?, line?, class?}.` };
    if (typeof raw.kind !== "string" || !(FINDING_KINDS as readonly string[]).includes(raw.kind)) return { error: `${VERDICT_TOOL}: the kind of a finding must be one of ${list(FINDING_KINDS)}.` };
    if (typeof raw.text !== "string" || !raw.text.trim() || !oneLine(raw.text) || raw.text.length > TEXT_MAX) return { error: `${VERDICT_TOOL}: the text of a finding is one line, at most ${TEXT_MAX} characters.` };
    const f: VerdictFinding = { kind: raw.kind as FindingKind, text: raw.text.trim() };
    if (raw.file !== undefined) {
      if (typeof raw.file !== "string" || !raw.file.trim() || !oneLine(raw.file) || raw.file.length > FILE_MAX) return { error: `${VERDICT_TOOL}: the file of a finding is a repo-relative path of one line, at most ${FILE_MAX} characters.` };
      f.file = raw.file.trim();
    }
    if (raw.line !== undefined) {
      if (typeof raw.line !== "number" || !Number.isInteger(raw.line) || raw.line < 1) return { error: `${VERDICT_TOOL}: the line of a finding is an integer of 1 or more.` };
      f.line = raw.line;
    }
    if (raw.class !== undefined) {
      if (typeof raw.class !== "string" || !(FINDING_CLASSES as readonly string[]).includes(raw.class)) return { error: `${VERDICT_TOOL}: the class of a finding must be one of ${list(FINDING_CLASSES)}.` };
      f.class = raw.class;
    }
    findings.push(f);
  }
  const defects = findings.some((f) => f.kind === "defect");
  const failed = items.some((i) => i.result === "fail");
  if (verdict === "pass" && (failed || defects)) return { error: `${VERDICT_TOOL}: a pass cannot carry a failed item or a defect finding. Give verdict fail, or correct the items and findings.` };
  if (verdict === "fail" && !failed && !defects) return { error: `${VERDICT_TOOL}: a fail needs at least one item with result fail or one finding of kind defect. Name what fails, or give pass.` };
  let reason: string | undefined;
  if (params.reason !== undefined) {
    if (typeof params.reason !== "string" || !oneLine(params.reason) || params.reason.length > REASON_MAX) return { error: `${VERDICT_TOOL}: reason is one line, at most ${REASON_MAX} characters.` };
    if (params.reason.trim()) reason = params.reason.trim();
  }
  if (verdict === "incomplete" && !reason) return { error: `${VERDICT_TOOL}: an incomplete verdict needs a reason (why the checks could not run).` };
  return { call: { verdict: verdict as VerdictValue, items, findings, ...(reason ? { reason } : {}) } };
}

// ------------------------------------------------------------------ record files

const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "_";

export const recordsRoot = (agentDir: string): string => path.join(agentDir, "pi-foreman", "state", "review-records");
export const recordSessionDir = (agentDir: string, session: string): string => path.join(recordsRoot(agentDir), safe(session));
/** The record folder of one launch; derived, never stored in a session file. */
export const recordDir = (agentDir: string, session: string, launch: string): string => path.join(recordSessionDir(agentDir, session), safe(launch));

/** Make the record folder of a launch (0700). Throws the OS error. */
export function makeRecordDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Write the record atomically (temp file in the folder, then rename); the folder must exist. Returns whether a record was there before. */
export function writeRecord(dir: string, rec: VerdictRecord): { replaced: boolean } {
  const file = path.join(dir, VERDICT_FILE);
  const replaced = fs.existsSync(file);
  const tmp = path.join(dir, `.verdict-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(rec), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
    throw err;
  }
  return { replaced };
}

/** The record of a verdict call. */
export const recordOf = (launchId: string, call: VerdictCall, now: Date = new Date()): VerdictRecord => ({ v: 1, launchId, verdict: call.verdict, items: call.items, findings: call.findings, ...(call.reason ? { reason: call.reason } : {}), at: now.toISOString() });

/** The record a child writes when `review_verdict` is not among its active tools (A6): fixed harness text. */
export const noToolRecord = (launchId: string, now?: Date): VerdictRecord => recordOf(launchId, { verdict: "incomplete", items: [], findings: [], reason: NO_TOOL_REASON }, now);

export type ReadRecord = { record: VerdictRecord } | { invalid: string };

/**
 * A record file as untrusted input: JSON, `v` 1, the launch's own id, the field schema and caps of the tool, every item id one of `allowed`.
 * `raw` null = no file (no verdict, not invalid).
 */
export function parseRecord(raw: string | null, launchId: string, allowed: readonly ItemId[]): ReadRecord | null {
  if (raw === null) return null;
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return { invalid: "not_json" };
  }
  if (!isObj(j)) return { invalid: "not_object" };
  if (j.v !== 1) return { invalid: "version" };
  if (j.launchId !== launchId) return { invalid: "launch_mismatch" };
  if (typeof j.at !== "string") return { invalid: "no_time" };
  const c = checkVerdictCall({ verdict: j.verdict, items: j.items, findings: j.findings, reason: j.reason }, allowed);
  if ("error" in c) return { invalid: "schema" };
  return { record: { v: 1, launchId, verdict: c.call.verdict, items: c.call.items, findings: c.call.findings, ...(c.call.reason ? { reason: c.call.reason } : {}), at: j.at } };
}

/** The `verdict.json` of a record folder; null when there is none. */
export function readRecordFile(dir: string, launchId: string, allowed: readonly ItemId[]): ReadRecord | null {
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(path.join(dir, VERDICT_FILE), "utf8");
  } catch {
    return null;
  }
  return parseRecord(raw, launchId, allowed);
}

export const consumedName = (runId: string): string => `verdict.${safe(runId)}.json`;

/** After the read: `verdict.json` becomes `verdict.<runId>.json`, so a resumed run must call the tool again to count. Best effort. */
export function consumeRecord(dir: string, runId: string): void {
  try {
    fs.renameSync(path.join(dir, VERDICT_FILE), path.join(dir, consumedName(runId)));
  } catch {
    // none there, or not renamable
  }
}

/** The record the run end of `runId` consumed (after a reload, or for the completion notice after the run-end event). */
export function readConsumed(dir: string, runId: string, launchId: string, allowed: readonly ItemId[]): ReadRecord | null {
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(path.join(dir, consumedName(runId)), "utf8");
  } catch {
    return null;
  }
  return parseRecord(raw, launchId, allowed);
}

const SWEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** The newest modification time under a folder (itself, its entries, their entries). */
function lastWrite(dir: string, depth = 2): number {
  let t = 0;
  try {
    t = fs.statSync(dir).mtimeMs;
    if (depth === 0) return t;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) t = Math.max(t, e.isDirectory() ? lastWrite(path.join(dir, e.name), depth - 1) : fs.statSync(path.join(dir, e.name)).mtimeMs);
  } catch {
    // vanished
  }
  return t;
}

/** Session start: the record folders of sessions whose last write is older than 7 days go (the child-out sweep rule). `keep` is the own session's folder name source. */
export function sweepRecords(agentDir: string, now: number, keepSession?: string): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(recordsRoot(agentDir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return;
  }
  for (const name of names) {
    if (keepSession !== undefined && name === safe(keepSession)) continue;
    const dir = path.join(recordsRoot(agentDir), name);
    if (now - lastWrite(dir) > SWEEP_MS) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ the launch's items

/** The open ledger items of a ledger text: numbered ones and whether V is open. Fenced lines do not count. Same line shape as reviewmarks.ts. */
const LEDGER_LINE = /^\s*[-*] \[(.)\]\s+(?:deferred:.*? — )?(\d+|V)\.(?:\s+|$)/;
export function openLedgerItems(ledger: string | null): { nums: number[]; v: boolean } {
  const nums: number[] = [];
  let v = false;
  let fenced = false;
  for (const line of (ledger ?? "").split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    const m = fenced ? null : LEDGER_LINE.exec(line);
    if (!m || m[1] !== " ") continue;
    if (m[2] === "V") v = true;
    else if (!nums.includes(Number(m[2]))) nums.push(Number(m[2]));
  }
  return { nums, v };
}

/** The launch `items` field: a list of item numbers and "V" (a bare value counts as a list of one). */
export function parseItemsField(raw: unknown): { items: ItemId[] } | { error: string } {
  const list_ = Array.isArray(raw) ? raw : [raw];
  if (list_.length > MAX_ITEMS) return { error: `items names more than ${MAX_ITEMS} items` };
  const out: ItemId[] = [];
  for (const r of list_) {
    const id = itemIdOf(r);
    if (id === null) return { error: `items is a list of item numbers and "V"; ${JSON.stringify(r)} is neither` };
    if (!out.includes(id)) out.push(id);
  }
  return { items: out };
}

export interface LaunchItems {
  /** The ids the tool accepts for this launch. */
  items: ItemId[];
}

/**
 * The items of one review launch. `given`: the validated `items` field (undefined = absent). `failed`: the numeric ids of the last counted FAIL, used only
 * by the re-review default (`reReview`). Absent: every open item except V; with `reReview`, the failed ids that are still open, else every open item except V.
 * Given: each must be open (V only when the ledger's V is open), else `{unknown}` lists the open ids.
 */
export function launchItemsOf(ledger: string | null, given: readonly ItemId[] | undefined, o: { reReview?: boolean; failed?: readonly string[] } = {}): LaunchItems | { unknown: ItemId[]; open: string } {
  const open = openLedgerItems(ledger);
  const openText = [...open.nums.map(String), ...(open.v ? ["V"] : [])];
  const openList = openText.length > 0 ? list(openText) : "none";
  if (given !== undefined) {
    const unknown = given.filter((id) => (id === "V" ? !open.v : !open.nums.includes(id)));
    if (unknown.length > 0) return { unknown, open: openList };
    return { items: [...given] };
  }
  if (o.reReview) {
    const still = (o.failed ?? []).map(Number).filter((n) => open.nums.includes(n));
    if (still.length > 0) return { items: [...new Set(still)] };
  }
  return { items: [...open.nums] };
}
