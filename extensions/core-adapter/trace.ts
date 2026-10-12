// Opt-in trace (design §10): one JSONL file per session in the state dir or `trace.dir`.
// Only allowlisted keys with primitive values are written; everything else is dropped, so a
// prompt, a tool argument, a path or an output can never reach the file through a new caller.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const TRACE_FIELDS = ["ts", "event", "role", "toolFamily", "guard", "decision", "latencyMs", "model", "tokensIn", "tokensOut", "cost", "exit", "tier", "precondition", "errorKind", "cause", "cacheRead", "cacheWrite", "requested", "wakeKinds", "pollBash", "from", "to", "files", "lines", "newFiles", "missing", "kind", "mode", "reason", "by", "phase", "count", "action", "runId", "outcome", "ms", "codemode", "after", "allowed", "items", "attested", "agent", "signals", "policy", "foreman", "turns", "rung", "cmd", "chars", "cut", "climb_available", "trimmed_lines", "skipped", "bytes", "segments", "class", "item", "hits", "policy_override", "note", "findingId", "gate", "file", "line", "primary", "models", "ready", "removed", "handover", "occasion", "thinking", "model_overridden", "marker", "pack", "op", "limit", "command"] as const;
export type TraceField = (typeof TRACE_FIELDS)[number];
export type TraceRecord = Partial<Record<TraceField, string | number | boolean | null>>;

const ALLOWED = new Set<string>(TRACE_FIELDS);
const MAX_STRING = 120;
const MAX_COMMAND = 200; // a denied command (lane 3h)
/** `command` is kept only on a deny trace: a refused launch, a read/recheck budget deny, an overlay deny. */
const DENY_EVENTS = new Set(["read_budget", "recheck_budget", "child_read_budget", "overlay", "launch_refused"]);
const isDeny = (rec: Record<string, unknown>): boolean => DENY_EVENTS.has(String(rec.event)) && (rec.event === "launch_refused" || rec.action === "deny" || rec.decision === "deny");

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

/** Keep allowlisted keys whose value is a primitive; cap string length. */
export function sanitizeTrace(rec: Record<string, unknown>): TraceRecord {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (!ALLOWED.has(k)) continue;
    if (k === "command" && !isDeny(rec)) continue; // never a command outside a deny
    if (k === "note" && rec.event !== "friction") continue; // free text: only the scrubbed friction note
    if (k === "file" && rec.event !== "finding") continue; // a path: only a finding's file, as its base name
    if (k === "file" && typeof v === "string") {
      out[k] = (v.split(/[\\/]/).pop() ?? "").slice(0, MAX_STRING);
      continue;
    }
    if (v === null || typeof v === "boolean") out[k] = v as null | boolean;
    else if (typeof v === "number") {
      if (Number.isFinite(v)) out[k] = v;
    } else if (typeof v === "string" && k === "command") out[k] = redactCommand(v).slice(0, MAX_COMMAND);
    else if (typeof v === "string") out[k] = v.length > (k === "command" ? MAX_COMMAND : MAX_STRING) ? v.slice(0, k === "command" ? MAX_COMMAND : MAX_STRING) : v;
  }
  return out as TraceRecord;
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
