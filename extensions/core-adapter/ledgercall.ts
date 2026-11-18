// Ledger helper (ceremony.ledgerHelper: tool | bash | off). Pure logic; index.ts registers the
// `foreman_ledger` tool, runs the core ledger script and wires the classifier into the budget.
//
// isLedgerOnlyCommand: an exact grammar for a shell command that only runs `ledger`:
//   [cd <path> &&] stmt ((&& | ;) stmt)* [;]
//   stmt := ledger <status|mark|add|note|defer> <word>*
//         | for <v> in <int|V>...; do ledger mark $<v>; done
// Rejected anywhere: | > < ` $( ( ) newline, a lone &, any $ other than the loop variable, a
// backslash outside the cd path, unquoted characters outside a safe set. Words are either fully
// single-quoted, fully double-quoted (no $ ` \ inside) or unquoted.

import { GATE_DENY_PREFIXES } from "./gatedialog.ts";
import { isLiveLedgerName } from "./marker.ts";

export const LEDGER_TOOL = "foreman_ledger";
export type LedgerHelper = "tool" | "bash" | "off";
export const LEDGER_ACTIONS = ["status", "mark", "add", "note", "defer", "upsert"] as const;
export type LedgerAction = (typeof LEDGER_ACTIONS)[number];
/** The tool's action enum: the shell grammar's list plus `init` (the tool creates a ledger; `ledger init` is no shell command). */
export const LEDGER_TOOL_ACTIONS = [...LEDGER_ACTIONS, "init"] as const;
export const LEDGER_TOPIC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const LEDGER_INIT_MAX_TEXTS = 32;
export const V_REFUSAL = "V closes after a reviewer PASS with no revision since";
export const V_ATTESTED_NOTE = "closed by the foreman after a reviewer PASS with no revision since (harness-attested)";

/** `ceremony.ledgerHelper`; anything else is the default "tool". */
export function ledgerHelperMode(v: unknown): LedgerHelper {
  return v === "bash" || v === "off" ? v : "tool";
}

type Tok = { op: "&&" | ";" } | { word: string; quoted: boolean };

const SAFE_UNQUOTED = /^[A-Za-z0-9._,:/@%+=~\\$-]+$/;

function tokenize(cmd: string): Tok[] | null {
  if (/[|<>`\n\r()]/.test(cmd) || cmd.includes("$(")) return null;
  const out: Tok[] = [];
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "&") {
      if (cmd[i + 1] !== "&") return null;
      out.push({ op: "&&" });
      i += 2;
      continue;
    }
    if (c === ";") {
      out.push({ op: ";" });
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = cmd.indexOf(c, i + 1);
      if (end < 0) return null;
      const body = cmd.slice(i + 1, end);
      if (c === '"' && /[$`\\]/.test(body)) return null;
      const next = cmd[end + 1];
      if (next !== undefined && !/[ \t;&]/.test(next)) return null; // no mixed words
      out.push({ word: body, quoted: true });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < cmd.length && !/[ \t;&'"]/.test(cmd[j])) j++;
    if (j < cmd.length && (cmd[j] === "'" || cmd[j] === '"')) return null; // no mixed words
    const w = cmd.slice(i, j);
    if (!SAFE_UNQUOTED.test(w)) return null;
    out.push({ word: w, quoted: false });
    i = j;
  }
  return out;
}

const isWord = (t: Tok | undefined): t is { word: string; quoted: boolean } => !!t && "word" in t;
const isOp = (t: Tok | undefined, op?: "&&" | ";"): boolean => !!t && "op" in t && (op === undefined || t.op === op);
const bare = (t: Tok | undefined, w: string): boolean => isWord(t) && !t.quoted && t.word === w;
const plainArg = (t: { word: string; quoted: boolean }): boolean => t.quoted || (!t.word.includes("$") && !t.word.includes("\\"));

/** True when the shell command does nothing but run `ledger` (grammar above). */
export function isLedgerOnlyCommand(cmd: unknown): boolean {
  if (typeof cmd !== "string") return false;
  const toks = tokenize(cmd);
  if (!toks || toks.length === 0) return false;
  let i = 0;
  if (bare(toks[0], "cd")) {
    const p = toks[1];
    if (!isWord(p) || (!p.quoted && p.word.includes("$")) || !isOp(toks[2], "&&")) return false;
    i = 3;
  }
  let stmts = 0;
  while (i < toks.length) {
    if (bare(toks[i], "ledger")) {
      const sub = toks[i + 1];
      if (!isWord(sub) || sub.quoted || !(LEDGER_ACTIONS as readonly string[]).includes(sub.word)) return false;
      i += 2;
      while (isWord(toks[i])) {
        if (!plainArg(toks[i] as { word: string; quoted: boolean })) return false;
        i++;
      }
    } else if (bare(toks[i], "for")) {
      const v = toks[i + 1];
      if (!isWord(v) || v.quoted || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.word) || !bare(toks[i + 2], "in")) return false;
      i += 3;
      let n = 0;
      while (isWord(toks[i]) && !(toks[i] as { quoted: boolean }).quoted && /^(?:\d+|[vV])$/.test((toks[i] as { word: string }).word)) {
        i++;
        n++;
      }
      const tail = toks.slice(i, i + 7);
      if (n === 0 || tail.length < 7 || !isOp(tail[0], ";") || !bare(tail[1], "do") || !bare(tail[2], "ledger") || !bare(tail[3], "mark") || !bare(tail[4], `$${v.word}`) || !isOp(tail[5], ";") || !bare(tail[6], "done")) return false;
      i += 7;
    } else return false;
    stmts++;
    if (i >= toks.length) break;
    if (!isOp(toks[i])) return false;
    i++;
  }
  return stmts > 0;
}

/**
 * True when the shell command runs the ledger helper (`ledger`, a path ending in `/ledger`, or `python[3] <path>/ledger.py`, with or without `-f`
 * or a `cd … &&` prefix, alone or in a chain) with `--verifier` or a `mark` that names item V (any case, alone or among others, a loop variable
 * included when a V is listed). Loose on purpose: it only refuses, for the child of a high-stakes review, which marks nothing.
 */
export function marksVerifierCommand(cmd: unknown): boolean {
  if (typeof cmd !== "string") return false;
  const words = (seg: string): string[] => seg.split(/\s+/).map((w) => w.replace(/^["']+|["']+$/g, "")).filter(Boolean);
  const hasV = words(cmd.replace(/[;&|()`]/g, " ")).some((w) => w.split(",").some((p) => /^v$/i.test(p)));
  for (const seg of cmd.split(/&&|\|\||[;&|\n\r()`]/)) {
    const w = words(seg);
    const at = w.findIndex((x) => /^ledger(?:\.py)?$/i.test(x.split(/[\\/]/).pop() ?? ""));
    if (at < 0) continue;
    const args = w.slice(at + 1);
    if (args.includes("--verifier")) return true;
    if (args.includes("mark") && hasV) return true;
  }
  return false;
}

/** A shell command that runs `ledger` as a command word anywhere (trace only, not a permission). */
export function mentionsLedger(cmd: unknown): boolean {
  return typeof cmd === "string" && /(?:^|[\s;&|(])ledger(?:\s|$)/.test(cmd);
}

const WIN_RENAME_DENIED = /\[WinError (?:5|32)\]|PermissionError/;

/**
 * Rerun a ledger.py invocation that failed with a Windows access-denied rename
 * (a reader or scanner holding the ledger open without share-delete); the failed save leaves the file unchanged.
 * Any other result returns at once. Up to 10 runs, 10 ms backoff doubling, capped at 200 ms.
 */
export async function retryLedgerRun<R extends { code?: number | null; stdout?: string; stderr?: string; error?: unknown; timedOut?: boolean }>(run: () => Promise<R>, sleep: (ms: number) => Promise<void>): Promise<R> {
  let delay = 10;
  let r = await run();
  for (let n = 1; n < 10; n++) {
    if (r.error || r.timedOut || r.code === 0 || !WIN_RENAME_DENIED.test(`${r.stdout ?? ""}\n${r.stderr ?? ""}`)) return r;
    await sleep(delay);
    delay = Math.min(delay * 2, 200);
    r = await run();
  }
  return r;
}

/**
 * A tool result that is a permission refusal: the gate's
 * deny texts. Blocked calls never reach tool_result,
 * so index.ts reads this from tool_execution_end.
 */
export function isPermissionDeny(isError: boolean, text: string): boolean {
  if (!isError) return false;
  return GATE_DENY_PREFIXES.some((p) => text.startsWith(p)) || /^pi-foreman: (?:denied by the permission policy|this command needs approval|this path needs approval|denied by the write protection|this changes protected configuration)/.test(text);
}

export interface GateView {
  last: string | null;
  revised: boolean;
  passRun?: string;
}

/** The most entries one `add` (texts) or `upsert` (entries) call takes. */
export const LEDGER_BATCH_MAX = 32;

export type LedgerPlan = { error: string } | { calls: string[][]; items: string; attested: boolean; upsert?: { item: string | null; text: string }; upserts?: { item: string | null; text: string }[] };

const oneLine = (v: unknown): string | null => (typeof v === "string" && v.trim() && !/[\r\n]/.test(v.trim()) ? v.trim() : null);

/** The `texts` of an add call: 1 to LEDGER_BATCH_MAX one-line strings. */
function addTexts(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > LEDGER_BATCH_MAX) return null;
  const out = v.map(oneLine);
  return out.every((t): t is string => t !== null) ? out : null;
}

/** The `entries` of an upsert call: 1 to LEDGER_BATCH_MAX `{item?, text}` objects, one-line text, each named item once. */
function upsertEntries(v: unknown): { item: string | null; text: string }[] | string {
  const bad = `${LEDGER_TOOL}: entries is a list of 1 to ${LEDGER_BATCH_MAX} {item?, text} objects with one-line text.`;
  if (!Array.isArray(v) || v.length === 0 || v.length > LEDGER_BATCH_MAX) return bad;
  const out: { item: string | null; text: string }[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return bad;
    const { item, text, ...rest } = e as Record<string, unknown>;
    const t = oneLine(text);
    if (t === null || Object.keys(rest).length > 0) return bad;
    if (item === undefined || item === null) out.push({ item: null, text: t });
    else {
      const id = itemId(item);
      if (!id) return `${LEDGER_TOOL}: item is an item number or "V".`;
      if (out.some((o) => o.item === id)) return `${LEDGER_TOOL}: item ${id} is named twice in entries.`;
      out.push({ item: id, text: t });
    }
  }
  return out;
}

function itemId(v: unknown): string | null {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return String(v);
  if (typeof v === "string" && /^(?:[1-9]\d*|[vV])$/.test(v.trim())) return v.trim().toUpperCase();
  return null;
}

/**
 * Plan one `foreman_ledger` call as ledger.py argument lists (status is appended by the caller).
 * Foreman: every action; `mark V` only while the latest review verdict is PASS with no revision
 * since, then with `--verifier` and the attested note; `planPass` (a session with no builder and no project edit, every plan's latest
 * review a PASS on its current version; index.ts planOnlyPass) lets V close too. Child (reviewer roles): only mark V.
 */
export function planLedgerCall(params: Record<string, unknown>, opts: { child: boolean; gate: GateView; planPass?: boolean }): LedgerPlan {
  const action = params.action;
  if (typeof action !== "string" || !(LEDGER_ACTIONS as readonly string[]).includes(action)) return { error: `${LEDGER_TOOL}: action must be one of ${LEDGER_ACTIONS.join(", ")}.` };
  const raw = params.items === undefined ? [] : Array.isArray(params.items) ? params.items : [params.items];
  const items: string[] = [];
  for (const r of raw) {
    const id = itemId(r);
    if (!id) return { error: `${LEDGER_TOOL}: items are item numbers or "V".` };
    if (!items.includes(id)) items.push(id);
  }
  const text = typeof params.text === "string" && params.text.trim() ? params.text.trim() : null;
  if (text && /[\r\n]/.test(text)) return { error: `${LEDGER_TOOL}: text must be one line.` };
  if (opts.child) {
    if (action !== "mark" || items.length !== 1 || items[0] !== "V") return { error: `${LEDGER_TOOL}: a reviewer may only close V: {action: "mark", items: ["V"]}.` };
    return { calls: [["mark", "V", ...(text ? [text] : []), "--verifier"]], items: "V", attested: false };
  }
  const one = (): string | null => (items.length === 1 ? items[0] : null);
  switch (action as LedgerAction) {
    case "status":
      return { calls: [], items: "", attested: false };
    case "add": {
      if (params.texts !== undefined) {
        if (params.text !== undefined) return { error: `${LEDGER_TOOL}: give text or texts, not both.` };
        const texts = addTexts(params.texts);
        if (!texts) return { error: `${LEDGER_TOOL}: texts is a list of 1 to ${LEDGER_BATCH_MAX} one-line strings.` };
        return { calls: texts.map((t) => ["add", t]), items: "", attested: false };
      }
      if (!text) return { error: `${LEDGER_TOOL}: add needs text.` };
      return { calls: [["add", text]], items: "", attested: false };
    }
    case "upsert": {
      if (params.entries !== undefined) {
        if (params.text !== undefined || (params.item !== undefined && params.item !== null)) return { error: `${LEDGER_TOOL}: give item and text, or entries, not both.` };
        const entries = upsertEntries(params.entries);
        if (typeof entries === "string") return { error: entries };
        return { calls: [], items: entries.flatMap((e) => (e.item ? [e.item] : [])).join(","), attested: false, upserts: entries };
      }
      if (!text) return { error: `${LEDGER_TOOL}: upsert needs text.` };
      if (params.item === undefined || params.item === null) return { calls: [], items: "", attested: false, upsert: { item: null, text } };
      const id = itemId(params.item);
      if (!id) return { error: `${LEDGER_TOOL}: item is an item number or "V".` };
      return { calls: [], items: id, attested: false, upsert: { item: id, text } };
    }
    case "note":
    case "defer": {
      const single = params.item === undefined || params.item === null ? null : itemId(params.item);
      const id = single ? (items.length === 0 || (items.length === 1 && items[0] === single) ? single : null) : params.item === undefined || params.item === null ? one() : null;
      if (!id || !text) return { error: `${LEDGER_TOOL}: ${action} needs exactly one item (\`item\` or \`items: [n]\`) and text.` };
      if (action === "defer" && id === "V") return { error: `${LEDGER_TOOL}: V cannot be deferred; ${V_REFUSAL}.` };
      return { calls: [[action, id, text]], items: id, attested: false };
    }
    case "mark": {
      if (items.length === 0) return { error: `${LEDGER_TOOL}: mark needs items.` };
      const v = items.includes("V");
      if (v && !(opts.gate.last === "pass" && !opts.gate.revised) && !opts.planPass) return { error: `${LEDGER_TOOL}: refused: ${V_REFUSAL} (${opts.gate.passRun ? `last counted PASS: run ${opts.gate.passRun}` : "no counted PASS this round"}). Launch a reviewer; after its PASS mark V again. In a session with no builder and no project edit, a [plan-review] PASS on the current version of every plan also closes V.` };
      const nums = items.filter((x) => x !== "V");
      const calls = nums.map((n) => ["mark", n, ...(text ? [text] : [])]);
      if (v) calls.push(["mark", "V", V_ATTESTED_NOTE, "--verifier"]);
      return { calls, items: [...nums, ...(v ? ["V"] : [])].join(","), attested: v };
    }
  }
  return { error: `${LEDGER_TOOL}: unknown action.` };
}

/** `init` params: a topic whose `LEDGER-<topic>.md` is a live ledger name, and up to 32 one-line texts. */
export function planLedgerInit(params: Record<string, unknown>): { topic: string; texts: string[] } | { error: string } {
  const topic = params.topic;
  if (typeof topic !== "string" || !LEDGER_TOPIC_RE.test(topic) || !isLiveLedgerName(`LEDGER-${topic}.md`)) return { error: `${LEDGER_TOOL}: init needs a topic of letters, digits, . _ - (at most 64, starting with a letter or digit, not ending in -archive or _archive).` };
  const raw = params.texts === undefined ? [] : params.texts;
  if (!Array.isArray(raw) || raw.length > LEDGER_INIT_MAX_TEXTS) return { error: `${LEDGER_TOOL}: texts is a list of at most ${LEDGER_INIT_MAX_TEXTS} one-line strings.` };
  const texts: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string" || !t.trim() || /[\r\n\x0b\x0c\x1c\x1d\x1e\x85\p{Zl}\p{Zp}]/u.test(t)) return { error: `${LEDGER_TOOL}: each text is a non-empty single line.` };
    texts.push(t.trim());
  }
  return { topic, texts };
}

/** A new ledger file: header, the recorded tier, one open item per text, then item V. */
export function ledgerInitContent(topic: string, tier: string | null, texts: string[]): string {
  return [`# LEDGER ${topic}`, ...(tier ? [`Tier: ${tier}`] : []), "", ...texts.map((t, i) => `- [ ] ${i + 1}. ${t}`), "- [ ] V. fresh-eyes verification passed", ""].join("\n");
}

// ------------------------------------------------------------------ upsert (line rewrite)
//
// Same line format and fence handling as core/scripts/ledger.py (ITEM_RE, _fence_mask); the file's
// line endings are kept because lines are split with their EOL.

const ITEM_LINE = /^(\s*[-*] \[.\]\s+(?:deferred:.*? — )?(\d+|V)\.)(?:\s+|$)(.*)$/;

function itemLines(file: string): { lines: string[]; hits: { i: number; m: RegExpExecArray }[] } {
  const lines = file.split(/(?<=\n)/);
  const hits: { i: number; m: RegExpExecArray }[] = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const m = ITEM_LINE.exec(line.replace(/\r?\n$/, ""));
    if (m) hits.push({ i, m });
  });
  return { lines, hits };
}

/** The number of a non-V item whose text is exactly `text`, else null. */
export function findItemByText(file: string, text: string): string | null {
  const h = itemLines(file).hits.find(({ m }) => m[2] !== "V" && m[3].trimEnd() === text);
  return h ? h.m[2] : null;
}

/** Replace the text after `N. ` of item `id` ("V" or digits), keeping the state marker. */
export function rewriteItemText(file: string, id: string, text: string): { error: string } | { file: string; changed: boolean } {
  const { lines, hits } = itemLines(file);
  const mine = hits.filter(({ m }) => m[2] === id);
  if (mine.length === 0) return { error: `${LEDGER_TOOL}: item ${id} not found in the ledger.` };
  if (mine.length > 1) return { error: `${LEDGER_TOOL}: item ${id} is ambiguous in the ledger.` };
  const { i, m } = mine[0];
  if (m[3].trimEnd() === text) return { file, changed: false };
  const eol = /\r?\n$/.exec(lines[i])?.[0] ?? "";
  lines[i] = `${m[1]} ${text}${eol}`;
  return { file: lines.join(""), changed: true };
}

// ------------------------------------------------------------------ prompt variants
//
// A prompt line may start with a tag `<!--key=value1|value2-->`. At load the line is kept (tag
// removed) when the session's value of `key` is one of the listed values, else dropped with its
// line break. Untagged lines are kept as they are, so a file without tags is returned unchanged.

const TAG = /^<!--([A-Za-z][A-Za-z0-9.]*)=([A-Za-z0-9|_-]+)-->/;

export function applyVariants(text: string, values: Readonly<Record<string, string>>): string {
  const lines = text.split(/(?<=\n)/);
  let out = "";
  for (const line of lines) {
    const m = TAG.exec(line);
    if (!m) {
      out += line;
      continue;
    }
    if (m[2].split("|").includes(values[m[1]] ?? "")) out += line.slice(m[0].length);
  }
  return out;
}
