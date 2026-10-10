// Friction lines of subagent reports: the `Friction:` tail every role sends upward. The run-end
// handler turns each into a `friction` trace event (allowlisted fields only, path-free, <= 120 chars).
import { runEndOf } from "./launchwait.ts";

export interface Friction {
  role: string;
  runId: string;
  kind: string;
  note: string;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

const MAX_NOTE = 120;
const MAX_CONTINUATION = 2;
const FRICTION_LINE = /^\s*(?:\d+[.)]\s+)?(?:[-*]\s+)?\*{0,2}Friction\*{0,2}\s*:\s*\*{0,2}\s*(.*)$/i;
const NEW_ITEM = /^\s*(?:\d+[.)]\s|(?:[-*]\s+)?\*{0,2}[A-Za-z][A-Za-z -]{0,24}\*{0,2}\s*:)/;

/**
 * Keyword guess for the kind; the first matching row wins, default `prompt`. Prefix match at a word
 * start, case-insensitive. Kept small on purpose: retro reads the kind as a hint, not a verdict.
 */
const KINDS: Array<[string, RegExp]> = [
  ["permission", /\b(permission|denied|ask|approve|allow)/i],
  ["skill", /\bskill/i],
  ["routing", /\b(model|rung|route|routing|escalat)/i],
  ["rule", /\b(rule|AGENTS|guard|policy)/i],
  ["agent", /\b(role|agent|subagent|brief|spec)/i],
  ["harness-bug", /\b(harness|bug|crash|error in tool|timeout)/i],
];

export const kindOfNote = (note: string): string => KINDS.find(([, re]) => re.test(note))?.[0] ?? "prompt";

const PATHLIKE = /^(?:~[\\/]|[A-Za-z]:[\\/])|[\\/]/;

/** Path-like tokens (a separator with two or more segments, `~/x`, `C:\x`) reduced to their basename. */
export function scrubPaths(text: string): string {
  return text.replace(/\S+/g, (tok) => {
    const m = /^([("'`[]*)(.*?)([)"'`\],.;:]*)$/.exec(tok);
    if (!m) return tok;
    const core = m[2];
    if (!PATHLIKE.test(core)) return tok;
    const segs = core.split(/[\\/]/).filter(Boolean);
    if (segs.length < 2 && !/^~[\\/]/.test(core)) return tok;
    return m[1] + (segs[segs.length - 1] ?? core) + m[3];
  });
}

const isNone = (s: string): boolean => s.replace(/[^A-Za-z0-9]+/g, "").toLowerCase() === "none" || s.replace(/[\s*_`.\-:;]/g, "") === "";

/** The note of the first `Friction:` line of a report text; null when absent, empty or "none". */
export function frictionNoteOf(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = FRICTION_LINE.exec(lines[i]);
    if (!m) continue;
    const parts = [m[1].trim()];
    for (let j = i + 1; j < lines.length && j <= i + MAX_CONTINUATION; j++) {
      const l = lines[j].trim();
      if (!l || NEW_ITEM.test(l)) break;
      parts.push(l);
    }
    const joined = parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (isNone(joined)) return null;
    const note = scrubPaths(joined);
    return note.length > MAX_NOTE ? note.slice(0, MAX_NOTE) : note;
  }
  return null;
}

/** One entry per result of a run-end event whose report carries a non-empty `Friction:` line. */
export function frictionOfRunEnd(data: unknown): Friction[] {
  const end = runEndOf(data);
  if (!end || !isObj(data)) return [];
  const results = Array.isArray(data.results) && data.results.length > 0 ? data.results.filter(isObj) : [data];
  const out: Friction[] = [];
  for (const r of results) {
    const role = typeof r.agent === "string" ? r.agent : end.role ?? "";
    for (const field of [r.output, r.summary]) {
      const note = typeof field === "string" ? frictionNoteOf(field) : null;
      if (!note) continue;
      out.push({ role, runId: end.runId, kind: kindOfNote(note), note });
      break;
    }
  }
  return out;
}
