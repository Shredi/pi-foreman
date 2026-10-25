// Opt-in trace (design §10): one JSONL file per session in the state dir or `trace.dir`.
// Only allowlisted keys with primitive values are written; everything else is dropped, so a
// prompt, a tool argument, a path or an output can never reach the file through a new caller.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const TRACE_FIELDS = ["ts", "event", "role", "toolFamily", "guard", "decision", "latencyMs", "model", "tokensIn", "tokensOut", "cost", "exit", "tier", "precondition", "errorKind", "cause", "cacheRead", "cacheWrite", "requested", "wakeKinds", "pollBash", "from", "to", "files", "lines", "newFiles", "missing", "kind", "mode", "reason", "by", "phase", "count", "action", "runId", "outcome", "ms", "codemode", "after", "allowed", "items", "attested", "agent", "signals", "policy", "foreman", "turns", "rung", "cmd", "chars", "cut", "climb_available", "trimmed_lines", "skipped", "bytes", "segments", "class", "family", "rule", "item", "hits", "policy_override", "note", "findingId", "gate", "file", "line", "primary", "models", "ready", "removed", "handover", "occasion", "thinking", "model_overridden", "marker", "pack", "op", "limit", "command", "tool", "message", "width", "reasons", "level"] as const;
export type TraceField = (typeof TRACE_FIELDS)[number];
export type TraceRecord = Partial<Record<TraceField, string | number | boolean | null>>;

// `surface` (R18 `dialog` records: permission|child|checkpoint|ask_user|drift) is allowed beside the pinned TRACE_FIELDS list.
// `code` and `attempts` (`hint_write_failed`: the rename error code and the attempts made) likewise.
// The warm-policy fields (budget, presence, self-warm source, compaction trigger) are allowed the same way: the pinned list stays as it is.
// R39 `launch_sizing` keys likewise (base rung, declared and measured sizes, risk tags, files outside the workspace).
// R52 `point` (the runtime compaction point in `compaction_point` and `compaction` records).
// R62 `remote_pull` keys `machine`, `label`, `entries` and `error` (`skipped` and `ms` are pinned fields already).
const ALLOWED = new Set<string>([...TRACE_FIELDS, "machine", "label", "entries", "error", "surface", "code", "attempts", "source", "spent", "cold", "share", "idleSeconds", "trigger", "tokens", "min", "base", "declaredLines", "modules", "declaredModules", "risk", "outside", "point"]);
const MAX_STRING = 120;
const MAX_COMMAND = 200; // a denied command (lane 3h)
/** `command` is kept only on a deny trace: a refused launch, a read/recheck budget deny, an overlay deny. */
const DENY_EVENTS = new Set(["read_budget", "recheck_budget", "child_read_budget", "overlay", "launch_refused"]);
const MAX_MESSAGE = 200; // a tool_error message (lane 7f)
const UNSCRUBBED = new Set(["model", "models", "primary", "from", "to"]);
const isDeny = (rec: Record<string, unknown>): boolean => (DENY_EVENTS.has(String(rec.event)) && (rec.event === "launch_refused" || rec.action === "deny" || rec.decision === "deny")) || (rec.event === "guard" && rec.guard === "self_ruling" && rec.decision === "blocked") || (rec.event === "overlay" && typeof rec.decision === "string" && rec.decision.startsWith("ask-")) || rec.event === "auto_review_allow"; // the overlay's ask dialogs and the auto reviewer's allows (R16) keep their command (`/foreman dialogs`)
const MAX_REASON = 320; // a deny reason keeps its rule pattern, which sits after the lead-in

/**
 * A denied command with secret-shaped tokens removed (before the 200-char cut):
 * auth headers, `token=` / `key=` / `password=` / `secret=` values, URL userinfo, `AKIA…` / `ghp_` / `sk-` style keys,
 * and base64 / hex runs of 24+ characters; the home directory becomes `~`.
 */
export function redactCommand(cmd: string): string {
  const R = "[redacted]";
  // a run of few distinct characters ("xxxx…") is padding, not a key
  const keyish = (t: string): string => (new Set(t).size >= 6 ? R : t);
  let out = cmd
    .replace(/(authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*[^\s'"]+/gi, `$1${R}`)
    .replace(/\bbearer\s+[A-Za-z0-9._~+\/=-]+/gi, `Bearer ${R}`)
    .replace(/\b((?:[A-Za-z0-9_-]*(?:token|key|password|passwd|secret|pwd))\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s'"&;]+)/gi, `$1${R}`)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s\/@'"]+@/gi, `$1${R}@`)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g, R)
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-|xox[abprs]-)[A-Za-z0-9_-]{6,}/g, R)
    .replace(/\b[0-9a-fA-F]{24,}\b/g, keyish);
  const home = os.homedir();
  if (home && home.length > 1) out = out.split(home).join("~");
  return out.replace(/[A-Za-z0-9+]{24,}={0,2}/g, keyish);
}

/** Verbs whose operands are file names (read or exec); the pattern verbs keep their first operand. */
const OPERAND_VERBS = new Set(["cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "sed", "awk", "node", "python", "python3", "bash", "sh", "zsh", "source"]);
const PATTERN_VERBS = new Set(["grep", "egrep", "fgrep", "rg", "sed", "awk"]);

/**
 * A text with path-like tokens replaced by `[path]`: absolute paths, `~/…`, `./…`, any token with a `/` or a backslash
 * (relative paths, URLs), bare file names with an extension (`b.txt`), dot-leading names (`.env`, `.eslintrc.json`) and
 * every operand of a read/exec verb (`cat Makefile id_rsa`; for grep/sed/awk/rg the first operand is the pattern or
 * script and stays). An extensionless word outside an operand position stays. Run after `redactCommand`.
 */
export function scrubPaths(text: string): string {
  const file = /^(?:[A-Za-z0-9_@+-][\w@+.-]*\.[A-Za-z][A-Za-z0-9]{1,9}|\.[A-Za-z_][\w@+.-]*)$/;
  // null: not after a verb; else whether the verb's first operand (a pattern or script) is still to be kept
  let operand: null | { keepFirst: boolean } = null;
  let last = 0;
  return text.replace(/[^\s'"`()<>\[\]{},;]+/g, (tok: string, at: number) => {
    if (/[;<>\n]/.test(text.slice(last, at))) operand = null; // a shell separator or redirect ends the operands
    last = at + tok.length;
    if (/^[|&]+$/.test(tok)) {
      operand = null;
      return tok;
    }
    const core = /^(.*?)([.:!?]*)$/.exec(tok) ?? [tok, tok, ""];
    const t = core[1];
    const op = operand as null | { keepFirst: boolean };
    let isOperand = false;
    if (op && t && !t.startsWith("-")) {
      if (op.keepFirst) op.keepFirst = false;
      else isOperand = true;
    }
    if (core[2]) operand = null; // `cat: x:` is an error text, not a command; a sentence end closes the operands
    else if (op === null && OPERAND_VERBS.has(t)) {
      operand = { keepFirst: PATTERN_VERBS.has(t) };
      return tok;
    }
    const pathLike = isOperand || /[\/\\]/.test(t) || t === "~" || file.test(t.replace(/(:\d+)+$/, ""));
    if (pathLike) return `[path]${core[2]}`;
    // `key=file.ext`: the value is a file name, the key stays
    const eq = t.indexOf("=");
    return eq > 0 && file.test(t.slice(eq + 1).replace(/(:\d+)+$/, "")) ? `${t.slice(0, eq + 1)}[path]${core[2]}` : tok;
  });
}

/**
 * A deny reason with its rule patterns kept (`rule '<repo>/config/foreman.defaults.json'`): the pattern is a rule id, not content.
 * Home paths in a pattern become `~`, any other absolute pattern `[path]`; the rest of the text is scrubbed like any trace string.
 */
export function scrubReason(text: string): string {
  const kept: string[] = [];
  const masked = text.replace(/\b(rules? ')([^'\n]{1,200})(')/g, (_m, a: string, pat: string, z: string) => {
    const p = redactCommand(pat);
    kept.push(/^(?:[A-Za-z]:)?[\\/]/.test(p) ? "[path]" : p);
    return `${a}\u0000${kept.length - 1}\u0000${z}`;
  });
  return scrubPaths(redactCommand(masked)).replace(/\u0000(\d+)\u0000/g, (_m, i: string) => kept[Number(i)]);
}

/** Deny trace fields (lane 3h): the reason, the command (a bash command, else the tool name; 200 chars at the writer) and the role. */
export function denyFields(reason: unknown, toolName: string, input: unknown, role: string, repoRoots: string[] = []): { reason: string; command: string; role: string } {
  const c = input && typeof input === "object" ? (input as { command?: unknown }).command : undefined;
  // the matched rule keeps its place in the repository: the package root and the project root read `<repo>` (scrubReason keeps `<repo>/…`)
  let text = typeof reason === "string" ? reason : "";
  for (const root of [...repoRoots].filter((r) => r.length > 1).sort((a, b) => b.length - a.length)) text = text.split(root.split(path.sep).join("/")).join("<repo>").split(root).join("<repo>");
  return { reason: text, command: typeof c === "string" && c ? c : toolName, role };
}

/** Keep allowlisted keys whose value is a primitive; cap string length. */
export function sanitizeTrace(rec: Record<string, unknown>): TraceRecord {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (!ALLOWED.has(k)) continue;
    if (k === "command" && !isDeny(rec) && rec.event !== "ask_flag") continue; // never a command outside a deny (and the owner's flagged ask, R31c)
    if (k === "message" && (rec.event !== "tool_error" || typeof v !== "string")) continue; // free text: only a tool_error's redacted message
    if (k === "error") {
      if (typeof v === "string") out[k] = scrubPaths(redactCommand(v)).slice(0, MAX_STRING);
      continue;
    }
    if (k === "message") {
      out[k] = scrubPaths(redactCommand(String(v))).slice(0, MAX_MESSAGE);
      continue;
    }
    if (k === "note" && rec.event !== "friction" && rec.event !== "ask_flag" && rec.event !== "launch_sizing") continue; // free text: only the scrubbed friction / ask_flag note (and launch_sizing's fixed flag words)
    if (k === "file" && rec.event !== "finding") continue; // a path: only a finding's file, as its base name
    if (k === "file" && typeof v === "string") {
      out[k] = (v.split(/[\\/]/).pop() ?? "").slice(0, MAX_STRING);
      continue;
    }
    if (v === null || typeof v === "boolean") out[k] = v as null | boolean;
    else if (typeof v === "number") {
      if (Number.isFinite(v)) out[k] = v;
    } else if (typeof v === "string") {
      // every string field: secrets redacted, then every path, URL and file name replaced by `[path]` (a URL whole); model ids (`model`, `models`, a panel's `primary`, a climb's `from`/`to`) are config, not content
      // R31c (owner ruling): a flagged ask keeps its COMPLETE command, only secret-looking values masked by redactCommand (no path scrub, no length cap)
      if (k === "command" && rec.event === "ask_flag") {
        out[k] = redactCommand(v);
        continue;
      }
      const s = UNSCRUBBED.has(k) ? v : k === "reason" && isDeny(rec) ? scrubReason(v) : scrubPaths(redactCommand(v));
      out[k] = s.slice(0, k === "command" ? MAX_COMMAND : k === "reason" && isDeny(rec) ? MAX_REASON : MAX_STRING);
    }
  }
  return out as TraceRecord;
}

/** The `tool_error` record of a tool result with `isError`: tool name and the redacted, path-scrubbed first 200 characters of its text. */
export function toolErrorRecord(tool: string, content: { type?: string; text?: string }[] | undefined): Record<string, unknown> {
  const text = (content ?? []).map((c) => (c && c.type === "text" ? c.text ?? "" : "")).join("\n").trim();
  return { event: "tool_error", tool, message: scrubPaths(redactCommand(text)).slice(0, MAX_MESSAGE) };
}

export interface TraceWriter {
  readonly file: string;
  emit(rec: Record<string, unknown>): void;
}

export interface TraceOptions {
  enabled: unknown;
  dir: unknown;
  stateDir: string;
  sessionId: string;
  /** Fields every record carries unless it sets them itself (a child's role and runId). */
  base?: Record<string, unknown>;
  now?: () => Date;
}

/** The trace file of id `id`: `trace.dir` when set, else the state dir. */
export function traceFile(dir: unknown, stateDir: string, id: string): string {
  const d = typeof dir === "string" && dir.trim() ? path.resolve(dir) : stateDir;
  return path.join(d, `trace-${id.replace(/[^A-Za-z0-9_-]/g, "") || "session"}.jsonl`);
}

/** A writer when `trace.enabled === true`, else null. Write errors are swallowed (tracing never blocks work). */
export function openTrace(opts: TraceOptions): TraceWriter | null {
  if (opts.enabled !== true) return null;
  const file = traceFile(opts.dir, opts.stateDir, opts.sessionId);
  const dir = path.dirname(file);
  const base = opts.base ? sanitizeTrace(opts.base) : {};
  const now = opts.now ?? (() => new Date());
  let ready = false;
  return {
    file,
    emit(rec) {
      try {
        if (!ready) {
          fs.mkdirSync(dir, { recursive: true });
          ready = true;
        }
        const clean = sanitizeTrace(rec);
        delete clean.ts;
        const line = { ts: now().toISOString(), ...base, ...clean };
        fs.appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
      } catch {
        // tracing is best effort
      }
    },
  };
}
