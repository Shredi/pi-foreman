// Owner script approval, the UI-free part: propose validation, the dialog text, the proposal state and the silent-fix rule.
// The owner approves the script's BYTES (plain sha256). The approved bytes live in the state object (session memory only);
// the runner (scriptrun.ts) executes them from a private run file, never from the path in the scratch dir. A change of the
// file after approval is measured against the approved bytes, never against the last fix, so fixes cannot creep.
import * as path from "node:path";
import { readRegularFile, sha256 } from "./checkpoint.ts";
import type { FileRefusal } from "./checkpoint.ts";
import { scratchRoot } from "./editmode.ts";
import { resolveToolPath } from "./payload.ts";
import { workspaceOf } from "./python.ts";
import { freshScriptLogPath } from "./scriptrun.ts";
import type { ScriptRunKind } from "./scriptrun.ts";
import { realDeep, under } from "./triage.ts";

export const SCRIPT_TOOL = "foreman_script";
export const SCRIPT_MAX_BYTES = 64 * 1024;
export const SCRIPT_DESCRIPTION_MAX = 600;
export const SCRIPT_RISK_MAX = 300;
export const SCRIPT_UNDO_MAX = 300;
export const SCRIPT_DRY_LITERALS = ["--dry-run", "DRY_RUN"] as const;
export const SCRIPT_EXPIRY_MS = 60 * 60 * 1000;
export const SCRIPT_MAX_ATTEMPTS = 3;
export const SCRIPT_FIX_LINES_DEFAULT = 5;
export const SCRIPT_FIX_ADDED_BYTES = 400;
export const SCRIPT_FIX_NOTICE_LINES = 12;
/** The marker line (the whole line) that declares the script undoes its change when run with the argument `undo`. */
export const SCRIPT_UNDO_MARKER = "# foreman-undo: supported";
const SCRIPT_UNDO_MARKER_RE = /^# foreman-undo: supported\r?$/m;
/** Dialog choices. Approve first is the owner's decision of 2026-11-11 (the owner answers these dialogs on a phone); a stray Enter in the terminal therefore approves. */
export const SCRIPT_CHOICES = ["approve", "revise", "reject"] as const;

/** The script kinds a `dry` or `run` action starts; `undo` has its own plan. */
export type ScriptRunAction = Exclude<ScriptRunKind, "undo">;

export type ScriptStatus = "pending" | "approved" | "dry_ok" | "consumed" | "rejected" | "revise" | "expired";
/** `script_child` is the adapter's (a subagent child never proposes); `script_text` is a summary text that is empty or over its limit. */
export type ScriptRefusalCode = "undo_no_proposal" | "undo_no_marker" | "undo_not_run" | "undo_done" | "undo_attempts" | "undo_expired" | "script_child" | "script_path" | "script_no_dry_run" | "script_pending" | "script_changed" | "script_dry_required" | "script_consumed" | "script_expired" | "no_posix_shell" | "script_text";

export interface ScriptFix {
  /** Short hash of the approved bytes and of the bytes that run now. */
  from: string;
  to: string;
  added: number;
  removed: number;
  addedBytes: number;
  /** Owner notice: first line with the script name and both short hashes, then the changed lines. */
  notice: string;
}

export interface ScriptRefusal {
  error: string;
  code: ScriptRefusalCode;
  /** A silent fix that was applied before the refusal (a real run after a fix needs a new dry run): notice and trace still go out. */
  fix?: ScriptFix;
}

export interface ScriptOpts {
  cwd: string;
  home: string;
  platform: string;
  scratchDir: string;
}

export interface ScriptFile {
  /** Real absolute path. */
  path: string;
  /** Workspace-relative, forward slashes. */
  rel: string;
  name: string;
  bytes: Buffer;
  hash: string;
  lines: number;
  /** The bytes carry the undo marker line. */
  undo: boolean;
}

export interface ScriptTexts {
  description: string;
  risk: string;
  undo: string;
}

export interface ScriptProposal extends ScriptTexts {
  path: string;
  rel: string;
  name: string;
  status: ScriptStatus;
  /** The bytes read at propose (the dialog shows their hash) and their line count. */
  bytes: Buffer;
  hash: string;
  lines: number;
  /** The bytes the owner approved; the fix rule measures against these. */
  approvedBytes: Buffer | null;
  approvedHash: string | null;
  approvedAt: number | null;
  /** The bytes that run: the approved ones, or an allowed fix of them. */
  runBytes: Buffer | null;
  runHash: string | null;
  /** Real runs started. */
  attempts: number;
  /** Logs of every run started, in order, and how many of each kind (the log counter is per kind). */
  logs: string[];
  logCounts: Record<ScriptRunKind, number>;
  /**
   * The undo marker, detected once at propose in the proposed text; never read again from disk. Undo is allowed only when this
   * is true AND the bytes that really ran (`ranBytes`) carry the marker too: a silent fix that removes the marker ends undo,
   * one that adds it does not give it. Undo runs `ranBytes` with the argument `undo`.
   */
  undoSupported: boolean;
  /** The bytes, hash and time (epoch ms) of the latest real run that started the script; null before one. */
  ranBytes: Buffer | null;
  ranHash: string | null;
  ranAt: number | null;
  /** Undo runs started, and whether one ended with exit 0 (it counts once). */
  undoAttempts: number;
  undoDone: boolean;
  /** The owner's note of a revise decision. */
  note: string | null;
}

/** One proposal per session; the adapter keeps this object in memory only. */
export interface ScriptState {
  proposal: ScriptProposal | null;
}

export const newScriptState = (): ScriptState => ({ proposal: null });

export const shortHash = (hash: string): string => hash.slice(0, 12);

const fold = (platform: string) => (platform === "win32" || platform === "darwin" ? (s: string) => s.toLowerCase() : (s: string) => s);
const refuse = (code: ScriptRefusalCode, why: string): ScriptRefusal => ({ code, error: `pi-foreman: ${SCRIPT_TOOL} refused (${code}): ${why}` });
const chars = (s: string): number => Array.from(s).length;

/**
 * Dialog text as one line: escape sequences removed, every control character a space, runs of whitespace one space.
 * Never cuts (a text over its limit refuses instead), so the owner sees all of it.
 */
export function cleanText(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b[@-_]?/g, "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Clean the three summary texts and check their limits (measured after cleaning). */
export function validateTexts(input: { description?: unknown; risk?: unknown; undo?: unknown }): { texts: ScriptTexts } | ScriptRefusal {
  const one = (v: unknown): string => (typeof v === "string" ? cleanText(v) : "");
  const texts = { description: one(input.description), risk: one(input.risk), undo: one(input.undo) };
  const limits: Array<[keyof ScriptTexts, number]> = [["description", SCRIPT_DESCRIPTION_MAX], ["risk", SCRIPT_RISK_MAX], ["undo", SCRIPT_UNDO_MAX]];
  for (const [key, max] of limits) {
    if (!texts[key]) return refuse("script_text", `${key} must be a non-empty text.`);
    const n = chars(texts[key]);
    if (n > max) return refuse("script_text", `${key} has ${n} characters, at most ${max} (the dialog shows it whole, nothing is cut); shorten it.`);
  }
  return { texts };
}

const FILE_REFUSAL: Record<FileRefusal, string> = {
  missing: "the file does not exist or cannot be read",
  not_regular: "not a regular file",
  hard_link: "the file has more than one hard link",
  too_large: "the file is larger than 64 KiB",
  changed: "the file changed while it was read",
  unreadable: "the file cannot be read",
};

const pathRule = (scratchDir: string): string => `The script is a regular file below ${scratchDir} (no symlink or hard link, at most 64 KiB, UTF-8).`;

/** Validate a script path and read the file: every propose check, also applied on each reread before a run. */
export function readScript(raw: unknown, o: ScriptOpts): { script: ScriptFile } | ScriptRefusal {
  const bad = (why: string): ScriptRefusal => refuse("script_path", `${why}. ${pathRule(o.scratchDir)}`);
  const f = fold(o.platform);
  const abs = resolveToolPath(raw, o.cwd, o.home);
  if (!abs) return bad("path must be a non-empty string");
  const lexRoot = path.resolve(workspaceOf(o.cwd).root);
  const realRoot = realDeep(lexRoot);
  const root = [realRoot, lexRoot].find((r) => under(r, abs, o.platform));
  if (!root) return bad("the path is outside the workspace");
  // as readPlan: the same path below the real root; a symlink component makes its real path differ
  const depth = path.relative(f(root), f(abs)).split(path.sep).filter(Boolean).length;
  const candidate = path.join(realRoot, ...(depth ? path.resolve(abs).split(path.sep).slice(-depth) : []));
  const real = realDeep(candidate);
  if (f(real) !== f(candidate)) return bad("the path passes through a symlink");
  const scratch = scratchRoot(realRoot, o.scratchDir, o.platform);
  if (!scratch) return bad(`the scratch dir ${o.scratchDir} is disabled`);
  if (!under(scratch, real, o.platform) || f(real) === f(scratch)) return bad(`the script must be below ${o.scratchDir}`);
  const file = readRegularFile(real, SCRIPT_MAX_BYTES);
  if ("refusal" in file) return bad(FILE_REFUSAL[file.refusal]);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    return bad("the file is not valid UTF-8");
  }
  if (!SCRIPT_DRY_LITERALS.some((lit) => text.includes(lit))) {
    return refuse("script_no_dry_run", `the script has neither \`--dry-run\` nor \`DRY_RUN\`. The harness runs it first with the argument --dry-run and DRY_RUN=1; the script must honour one of them and change nothing on that run.`);
  }
  const rel = path.relative(realRoot, real).split(path.sep).join("/");
  return { script: { path: real, rel, name: path.basename(real), bytes: file.bytes, hash: sha256(file.bytes), lines: splitLines(text).length, undo: SCRIPT_UNDO_MARKER_RE.test(text) } };
}

/** A new proposal (status pending). It replaces the earlier proposal and its approval, also when this one is refused. */
export function proposeScript(state: ScriptState, input: { path?: unknown; description?: unknown; risk?: unknown; undo?: unknown }, o: ScriptOpts): { proposal: ScriptProposal } | ScriptRefusal {
  state.proposal = null;
  const texts = validateTexts(input);
  if ("error" in texts) return texts;
  const read = readScript(input.path, o);
  if ("error" in read) return read;
  const s = read.script;
  state.proposal = { ...texts.texts, path: s.path, rel: s.rel, name: s.name, status: "pending", bytes: s.bytes, hash: s.hash, lines: s.lines, approvedBytes: null, approvedHash: null, approvedAt: null, runBytes: null, runHash: null, attempts: 0, logs: [], logCounts: { dry: 0, run: 0, undo: 0 }, undoSupported: s.undo, ranBytes: null, ranHash: null, ranAt: null, undoAttempts: 0, undoDone: false, note: null };
  return { proposal: state.proposal };
}

/** The notice of the dialog: the foreman's three texts, each on its own labelled line, then the harness's own lines. */
export function scriptNoticeLines(p: ScriptProposal): string[] {
  return [`Description: ${p.description}`, `Risk: ${p.risk}`, `Undo: ${p.undo}`, `Path: ${cleanText(p.rel)}`, `Lines: ${p.lines}`, `sha256: ${shortHash(p.hash)}`];
}

/** The harness's own line for the owner, the seventh and last line of the dialog notice, after the six summary lines: can the tool undo this script? */
export function scriptUndoLine(p: ScriptProposal): string {
  return `Undo through the tool: ${p.undoSupported ? `yes (the script has the line ${SCRIPT_UNDO_MARKER}; the tool can run it with the argument undo after a real run)` : "no (the script has no undo marker line)"}`;
}

/** The select title: it names the script and its short hash itself, so a notice that replaced the summary cannot hide them. */
export function scriptSelectTitle(p: ScriptProposal): string {
  return `Run the owner script ${cleanText(p.name)} (sha256 ${shortHash(p.hash)})?`;
}

export type ScriptDecision = { kind: "approve" } | { kind: "revise"; note: string } | { kind: "reject" };

/**
 * Record the owner's decision. Approve reads the path again: other bytes than the ones the dialog showed the hash of
 * leave the proposal pending (script_pending), and nothing runs.
 */
export function decideScript(state: ScriptState, decision: ScriptDecision, o: ScriptOpts, now: number): { proposal: ScriptProposal } | ScriptRefusal {
  const p = state.proposal;
  if (!p || p.status !== "pending") return refuse("script_pending", "no proposal is waiting for a decision; call propose first.");
  if (decision.kind === "reject") p.status = "rejected";
  else if (decision.kind === "revise") {
    p.status = "revise";
    p.note = cleanText(decision.note);
  } else {
    const read = readScript(p.path, o);
    if ("error" in read || read.script.hash !== p.hash) return refuse("script_pending", `${p.rel} changed while the dialog was open; the proposal stays pending and nothing ran. Propose it again.`);
    p.status = "approved";
    p.approvedBytes = p.runBytes = p.bytes;
    p.approvedHash = p.runHash = p.hash;
    p.approvedAt = now;
  }
  return { proposal: p };
}

/** Lines with their endings as written, so a CRLF change is a changed line. */
function splitLines(text: string): string[] {
  return text === "" ? [] : text.split(/(?<=\n)/);
}

interface LineEdit {
  sign: "+" | "-";
  line: string;
}

/** Minimal line diff (Myers, the same edit count as an LCS diff), or null when it needs more than `maxEdits` edits. */
function diffLines(a: string[], b: string[], maxEdits: number): LineEdit[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(Math.max(0, Math.floor(maxEdits)), n + m);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x < n || y < m) continue;
      const edits: LineEdit[] = [];
      for (let e = d; e > 0; e--) {
        const prev = trace[e];
        const kk = x - y;
        const down = kk === -e || (kk !== e && prev[off + kk - 1] < prev[off + kk + 1]);
        const px = prev[off + (down ? kk + 1 : kk - 1)];
        const py = px - (down ? kk + 1 : kk - 1);
        edits.push(down ? { sign: "+", line: b[py] } : { sign: "-", line: a[px] });
        x = px;
        y = py;
      }
      return edits.reverse();
    }
  }
  return null;
}

export type FixVerdict =
  | { kind: "same" }
  | { kind: "fix"; added: number; removed: number; addedBytes: number; edits: Array<{ sign: "+" | "-"; line: string }> }
  | { kind: "refused"; why: string };

/**
 * The silent-fix rule: `now` against the bytes the owner approved. Allowed when the minimal line diff has at most `limit`
 * changed lines (added plus removed; 0 turns silent fixes off) and the added lines total at most 400 bytes.
 */
export function fixRule(approved: Buffer, now: Buffer, limit: number = SCRIPT_FIX_LINES_DEFAULT): FixVerdict {
  if (approved.equals(now)) return { kind: "same" };
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (max === 0) return { kind: "refused", why: "silent fixes are off (safety.scripts.silentFixLines is 0)" };
  const edits = diffLines(splitLines(approved.toString("utf8")), splitLines(now.toString("utf8")), max);
  if (!edits) return { kind: "refused", why: `more than ${max} changed lines against the approved script` };
  const addedLines = edits.filter((e) => e.sign === "+");
  const addedBytes = addedLines.reduce((sum, e) => sum + Buffer.byteLength(e.line, "utf8"), 0);
  if (addedBytes > SCRIPT_FIX_ADDED_BYTES) return { kind: "refused", why: `${addedBytes} bytes in the added lines against the approved script, at most ${SCRIPT_FIX_ADDED_BYTES}` };
  return { kind: "fix", added: addedLines.length, removed: edits.length - addedLines.length, addedBytes, edits };
}

/** The owner notice of a silent fix: the script name with the old and new short hash first, then the changed lines (cleaned, at most 12). */
export function fixNotice(name: string, from: string, to: string, edits: Array<{ sign: "+" | "-"; line: string }>): string {
  const added = edits.filter((e) => e.sign === "+").length;
  const head = `Script ${cleanText(name)} changed after approval: ${shortHash(from)} -> ${shortHash(to)} (+${added} -${edits.length - added} lines); it reruns after a new dry run.`;
  const shown = edits.slice(0, SCRIPT_FIX_NOTICE_LINES).map((e) => `${e.sign} ${cleanText(e.line)}`);
  const more = edits.length - shown.length;
  return [head, ...shown, ...(more > 0 ? [`(${more} more changed lines)`] : [])].join("\n");
}

function expire(p: ScriptProposal, now: number): void {
  if ((p.status === "approved" || p.status === "dry_ok") && p.approvedAt !== null && now - p.approvedAt >= SCRIPT_EXPIRY_MS) p.status = "expired";
}

export interface ScriptRunPlan {
  kind: ScriptRunAction;
  /** The bytes to hand to the runner, and their hash (pass it back to recordRun). */
  bytes: Buffer;
  hash: string;
  logPath: string;
  /** Set when a silent fix was applied on this call: send the notice and the trace record. */
  fix?: ScriptFix;
}

/**
 * What a `dry` or `run` action may run now, or why not. Reads the path again (every propose check), applies the fix rule,
 * and for a real run requires a passed dry run of the same bytes. A real run counts as an attempt from here on.
 */
export function beginRun(state: ScriptState, kind: ScriptRunAction, o: ScriptOpts, now: number, fixLimit: number = SCRIPT_FIX_LINES_DEFAULT): ScriptRunPlan | ScriptRefusal {
  const p = state.proposal;
  if (!p) return refuse("script_pending", "there is no proposal; call propose first.");
  expire(p, now);
  if (p.status === "pending") return refuse("script_pending", `${p.rel} is not approved yet; the owner decides in the dialog of propose.`);
  if (p.status === "rejected") return refuse("script_pending", `the owner rejected ${p.rel}; nothing runs.`);
  if (p.status === "revise") return refuse("script_pending", `the owner asked for a revision of ${p.rel}; change it and propose it again.`);
  if (p.status === "consumed") return refuse("script_consumed", `the approval of ${p.rel} is used up (one real run with exit 0, or ${SCRIPT_MAX_ATTEMPTS} real attempts); propose it again.`);
  if (p.status === "expired") return refuse("script_expired", `the approval of ${p.rel} is older than 60 minutes; propose it again.`);
  if (!p.approvedBytes || !p.approvedHash || !p.runBytes || !p.runHash) return refuse("script_pending", `${p.rel} is not approved yet.`);
  const read = readScript(p.path, o);
  if ("error" in read) return read;
  let fix: ScriptFix | undefined;
  if (read.script.hash !== p.runHash) {
    const verdict = fixRule(p.approvedBytes, read.script.bytes, fixLimit);
    if (verdict.kind === "refused") return refuse("script_changed", `${p.rel} changed after approval: ${verdict.why}. Restore the approved text (sha256 ${shortHash(p.approvedHash)}) or propose the script again.`);
    const edits = verdict.kind === "fix" ? verdict.edits : [];
    const added = edits.filter((e) => e.sign === "+");
    fix = { from: shortHash(p.approvedHash), to: shortHash(read.script.hash), added: added.length, removed: edits.length - added.length, addedBytes: verdict.kind === "fix" ? verdict.addedBytes : 0, notice: fixNotice(p.name, p.approvedHash, read.script.hash, edits) };
    p.runBytes = read.script.bytes;
    p.runHash = read.script.hash;
    p.status = "approved";
  }
  if (kind === "run" && p.status !== "dry_ok") return { ...refuse("script_dry_required", `a real run of ${p.rel} needs a dry run of the same text with exit 0 first; call dry.`), ...(fix ? { fix } : {}) };
  const scratch = scratchRoot(realDeep(path.resolve(workspaceOf(o.cwd).root)), o.scratchDir, o.platform);
  if (!scratch) return refuse("script_path", `the scratch dir ${o.scratchDir} is disabled.`);
  const logPath = freshScriptLogPath(scratch, p.name, p.runHash, kind, ++p.logCounts[kind]);
  p.logs.push(logPath);
  if (kind === "run") p.attempts++;
  return { kind, bytes: p.runBytes, hash: p.runHash, logPath, ...(fix ? { fix } : {}) };
}

/**
 * Record how a run ended. Dry run of the current bytes: exit 0 gives `dry_ok`, anything else `approved`. Real run: exit 0
 * consumes the approval, and so does the third attempt. Returns the status.
 */
export function recordRun(state: ScriptState, kind: ScriptRunAction, hash: string, exit: number | null): ScriptStatus | null {
  const p = state.proposal;
  if (!p) return null;
  if (p.status !== "approved" && p.status !== "dry_ok") return p.status;
  if (hash !== p.runHash) return p.status;
  if (kind === "dry") p.status = exit === 0 ? "dry_ok" : "approved";
  else {
    if (exit === 0 || p.attempts >= SCRIPT_MAX_ATTEMPTS) p.status = "consumed";
  }
  return p.status;
}

/** Undo is possible: the marker was in the proposed text and, once a real run happened, is in the bytes that ran. */
function undoAble(p: ScriptProposal): boolean {
  return p.undoSupported && (!p.ranBytes || SCRIPT_UNDO_MARKER_RE.test(p.ranBytes.toString("utf8")));
}

/**
 * Record that a real run really started the script (whatever its exit): undo reverses these exact bytes, for an hour from `now`.
 * Call it before recordRun; a run that never spawned the script is not recorded.
 */
export function recordRealRun(state: ScriptState, hash: string, now: number): void {
  const p = state.proposal;
  if (!p || !p.runBytes || hash !== p.runHash) return;
  p.ranBytes = p.runBytes;
  p.ranHash = p.runHash;
  p.ranAt = now;
}

export interface UndoPlan {
  /** The bytes that really ran, their hash, the log and the attempt number (of 3). */
  bytes: Buffer;
  hash: string;
  logPath: string;
  attempt: number;
}

/**
 * What an `undo` action may run now, or why not. Never reads the file: it hands out the bytes of the latest real run of the
 * session's current proposal. No dialog; the owner approved the proposed text and was told whether the tool can undo.
 */
export function beginUndo(state: ScriptState, o: ScriptOpts, now: number): UndoPlan | ScriptRefusal {
  const p = state.proposal;
  if (!p) return refuse("undo_no_proposal", "there is no proposal in this session, so nothing can be undone through the tool. A new propose is the way.");
  if (!p.undoSupported) return refuse("undo_no_marker", `${p.rel} has no undo marker line (${SCRIPT_UNDO_MARKER}) in the proposed text, so the tool cannot undo it. Undo it by hand or propose a script that undoes it.`);
  if (!undoAble(p)) return refuse("undo_no_marker", `the text of ${p.rel} that ran does not declare the undo marker line (${SCRIPT_UNDO_MARKER}) any more (a fix after approval removed it), so the tool cannot undo it. Undo it by hand or propose a script that undoes it.`);
  if (!p.ranBytes || !p.ranHash || p.ranAt === null) return refuse("undo_not_run", `${p.rel} has no real run yet in this proposal; there is nothing to undo. (An earlier proposal that was replaced cannot be undone through the tool; a new propose is the way.)`);
  if (p.undoDone) return refuse("undo_done", `the undo of ${p.rel} already ran with exit 0; it counts once.`);
  if (p.undoAttempts >= SCRIPT_MAX_ATTEMPTS) return refuse("undo_attempts", `${SCRIPT_MAX_ATTEMPTS} undo attempts of ${p.rel} are used; a new propose is the way.`);
  if (now - p.ranAt >= SCRIPT_EXPIRY_MS) return refuse("undo_expired", `the real run of ${p.rel} is older than 60 minutes, so the tool no longer undoes it; a new propose is the way.`);
  const scratch = scratchRoot(realDeep(path.resolve(workspaceOf(o.cwd).root)), o.scratchDir, o.platform);
  if (!scratch) return refuse("script_path", `the scratch dir ${o.scratchDir} is disabled.`);
  const logPath = freshScriptLogPath(scratch, p.name, p.ranHash, "undo", ++p.logCounts.undo);
  p.logs.push(logPath);
  p.undoAttempts++;
  return { bytes: p.ranBytes, hash: p.ranHash, logPath, attempt: p.undoAttempts };
}

/** Record how an undo run ended: exit 0 counts once. */
export function recordUndo(state: ScriptState, hash: string, exit: number | null): void {
  const p = state.proposal;
  if (p && p.ranHash === hash && exit === 0) p.undoDone = true;
}

export interface ScriptUndoReport {
  /** The proposed text carries the undo marker, and so does the text that ran. */
  supported: boolean;
  /** Undo can run now. */
  available: boolean;
  /** ISO time the undo window ends (one hour after the real run), null before a real run. */
  availableUntil: string | null;
  used: boolean;
  attempts: number;
  attemptsLeft: number;
}

export interface ScriptStatusReport {
  status: ScriptStatus;
  /** The approval is used up (status consumed): nothing more runs without a new propose. */
  approvalUsed: boolean;
  path: string;
  /** Hash of the proposed text (not of what ran), then of the approved bytes and of the ones that run next (differs after a silent fix); `ranHash` is the hash of the bytes that really ran. */
  hash: string;
  approvedHash: string | null;
  runHash: string | null;
  /** The hash that really ran and the ISO time of that real run; null before one. */
  ranHash: string | null;
  ranAt: string | null;
  attempts: number;
  /** Real attempts left; 0 once the approval is used up. */
  attemptsLeft: number;
  /** Epoch ms the approval ends, null before approval and after it is used up. */
  expiresAt: number | null;
  undo: ScriptUndoReport;
  logs: string[];
  note: string | null;
}

/** The current proposal for the `status` action, or null when there is none. */
export function scriptStatus(state: ScriptState, now: number): ScriptStatusReport | null {
  const p = state.proposal;
  if (!p) return null;
  expire(p, now);
  const used = p.status === "consumed";
  const until = p.ranAt === null ? null : p.ranAt + SCRIPT_EXPIRY_MS;
  const undo: ScriptUndoReport = {
    supported: undoAble(p),
    available: undoAble(p) && until !== null && !p.undoDone && p.undoAttempts < SCRIPT_MAX_ATTEMPTS && now < until,
    availableUntil: until === null ? null : new Date(until).toISOString(),
    used: p.undoDone,
    attempts: p.undoAttempts,
    attemptsLeft: p.undoDone ? 0 : Math.max(0, SCRIPT_MAX_ATTEMPTS - p.undoAttempts),
  };
  return { status: p.status, approvalUsed: used, path: p.rel, hash: p.hash, approvedHash: p.approvedHash, runHash: p.runHash, ranHash: p.ranHash, ranAt: p.ranAt === null ? null : new Date(p.ranAt).toISOString(), attempts: p.attempts, attemptsLeft: used ? 0 : Math.max(0, SCRIPT_MAX_ATTEMPTS - p.attempts), expiresAt: used || p.approvedAt === null ? null : p.approvedAt + SCRIPT_EXPIRY_MS, undo, logs: [...p.logs], note: p.note };
}
