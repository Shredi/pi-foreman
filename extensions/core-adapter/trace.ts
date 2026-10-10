// Opt-in trace (design §10): one JSONL file per session in the state dir or `trace.dir`.
// Only allowlisted keys with primitive values are written; everything else is dropped, so a
// prompt, a tool argument, a path or an output can never reach the file through a new caller.
import * as fs from "node:fs";
import * as path from "node:path";

export const TRACE_FIELDS = ["ts", "event", "role", "toolFamily", "guard", "decision", "latencyMs", "model", "tokensIn", "tokensOut", "cost", "exit", "tier", "precondition", "errorKind", "cause", "cacheRead", "cacheWrite", "requested", "wakeKinds", "pollBash", "from", "to", "files", "lines", "newFiles", "missing", "kind", "mode", "reason", "by", "phase", "count", "action", "runId", "outcome", "ms", "codemode", "after", "allowed", "items", "attested", "agent", "signals", "policy", "foreman", "turns", "rung", "cmd", "chars", "cut", "climb_available", "trimmed_lines", "skipped", "bytes", "segments", "class", "item", "hits", "policy_override", "note", "rungs", "findingId", "gate", "file", "line", "primary", "models"] as const;
export type TraceField = (typeof TRACE_FIELDS)[number];
export type TraceRecord = Partial<Record<TraceField, string | number | boolean | null>>;

const ALLOWED = new Set<string>(TRACE_FIELDS);
const MAX_STRING = 120;

/** Keep allowlisted keys whose value is a primitive; cap string length. */
export function sanitizeTrace(rec: Record<string, unknown>): TraceRecord {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (!ALLOWED.has(k)) continue;
    if (k === "note" && rec.event !== "friction") continue; // free text: only the scrubbed friction note
    if (k === "file" && rec.event !== "finding") continue; // a path: only a finding's file, as its base name
    if (k === "file" && typeof v === "string") {
      out[k] = (v.split(/[\\/]/).pop() ?? "").slice(0, MAX_STRING);
      continue;
    }
    if (v === null || typeof v === "boolean") out[k] = v as null | boolean;
    else if (typeof v === "number") {
      if (Number.isFinite(v)) out[k] = v;
    } else if (typeof v === "string") out[k] = v.length > MAX_STRING ? v.slice(0, MAX_STRING) : v;
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
