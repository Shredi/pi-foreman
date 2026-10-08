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

export const LEDGER_TOOL = "foreman_ledger";
export type LedgerHelper = "tool" | "bash" | "off";
export const LEDGER_ACTIONS = ["status", "mark", "add", "note", "defer"] as const;
export type LedgerAction = (typeof LEDGER_ACTIONS)[number];
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

/** A shell command that runs `ledger` as a command word anywhere (trace only, not a permission). */
export function mentionsLedger(cmd: unknown): boolean {
  return typeof cmd === "string" && /(?:^|[\s;&|(])ledger(?:\s|$)/.test(cmd);
}

/**
 * A tool result that is a permission refusal: pi-permission-system's tagged block reason, or the
 * adapter overlay's deny/ask-denied texts (permoverlay.ts). Blocked calls never reach tool_result,
 * so index.ts reads this from tool_execution_end.
 */
export function isPermissionDeny(isError: boolean, text: string): boolean {
  if (!isError) return false;
  return text.includes("[pi-permission-system]") || /^pi-foreman: (?:denied by the permission policy|this command needs approval|this path needs approval|denied by the write protection|this changes protected configuration)/.test(text);
}

export interface GateView {
  last: string | null;
  revised: boolean;
}

export type LedgerPlan = { error: string } | { calls: string[][]; items: string; attested: boolean };

function itemId(v: unknown): string | null {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return String(v);
  if (typeof v === "string" && /^(?:[1-9]\d*|[vV])$/.test(v.trim())) return v.trim().toUpperCase();
  return null;
}

/**
 * Plan one `foreman_ledger` call as ledger.py argument lists (status is appended by the caller).
 * Foreman: every action; `mark V` only while the latest review verdict is PASS with no revision
 * since, then with `--verifier` and the attested note. Child (reviewer roles): only mark V.
 */
export function planLedgerCall(params: Record<string, unknown>, opts: { child: boolean; gate: GateView }): LedgerPlan {
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
    case "add":
      if (!text) return { error: `${LEDGER_TOOL}: add needs text.` };
      return { calls: [["add", text]], items: "", attested: false };
    case "note":
    case "defer": {
      const id = one();
      if (!id || !text) return { error: `${LEDGER_TOOL}: ${action} needs exactly one item and text.` };
      if (action === "defer" && id === "V") return { error: `${LEDGER_TOOL}: V cannot be deferred; ${V_REFUSAL}.` };
      return { calls: [[action, id, text]], items: id, attested: false };
    }
    case "mark": {
      if (items.length === 0) return { error: `${LEDGER_TOOL}: mark needs items.` };
      const v = items.includes("V");
      if (v && !(opts.gate.last === "pass" && !opts.gate.revised)) return { error: `${LEDGER_TOOL}: refused: ${V_REFUSAL}. Launch a reviewer; after its PASS mark V again.` };
      const nums = items.filter((x) => x !== "V");
      const calls = nums.map((n) => ["mark", n, ...(text ? [text] : [])]);
      if (v) calls.push(["mark", "V", V_ATTESTED_NOTE, "--verifier"]);
      return { calls, items: [...nums, ...(v ? ["V"] : [])].join(","), attested: v };
    }
  }
  return { error: `${LEDGER_TOOL}: unknown action.` };
}

// ------------------------------------------------------------------ prompt variants
//
// A prompt line may start with a tag `<!--key=value1|value2-->`. At load the line is kept (tag
// removed) when the session's value of `key` is one of the listed values, else dropped with its
// line break. Untagged lines are kept as they are, so a file without tags is returned unchanged.

const TAG = /^<!--([A-Za-z][A-Za-z0-9]*)=([A-Za-z0-9|_-]+)-->/;

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
