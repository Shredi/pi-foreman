// Explorer brief for builders (frugal-roles D7, item 5): when an explorer run of this session has
// ended, the next builder launch gets its report (bounded) and result path prepended to the task,
// so the builder does not redo the exploration. Foreman side, in memory. Each report is handed
// over once. Composes with ladder.ts: the rung-up handoff is prepended after this (handoff first).
import type { RunEnd } from "./launchwait.ts";

export const BRIEF_MAX = 8_000;

export interface Brief {
  runId: string;
  summary: string;
  resultPath: string | null;
}

export function briefBlock(b: Brief): string {
  const s = b.summary.length > BRIEF_MAX ? `${b.summary.slice(0, BRIEF_MAX)}\n[... cut at ${BRIEF_MAX} characters${b.resultPath ? "; the full report is under the result path" : ""}]` : b.summary;
  return [`[pi-foreman explorer brief] Findings of the explorer run ${b.runId}; use them instead of exploring again.`, s, ...(b.resultPath ? [`Full result: ${b.resultPath}`] : []), "[end of brief]", ""].join("\n");
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export class ExplorerBrief {
  private latest: Brief | null = null;

  /** A run end: an explorer run that completed with a report becomes the latest brief. */
  onRunEnd(end: RunEnd | null, roles?: readonly string[]): void {
    const role = end?.role ?? (roles && roles.length === 1 ? roles[0] : null);
    if (end && role === "explorer" && end.status === "completed" && end.summary.trim()) this.latest = { runId: end.runId, summary: end.summary.trim(), resultPath: end.resultPath };
  }

  /**
   * Prepend the brief to the task of every fresh builder step of a `subagent` input (single, tasks,
   * chain); a resume carries no brief. Returns the trace records.
   */
  apply(input: Record<string, unknown>): Record<string, unknown>[] {
    const b = this.latest;
    if (!b || typeof input.action === "string") return [];
    const out: Record<string, unknown>[] = [];
    const block = briefBlock(b);
    const visit = (e: unknown): void => {
      if (!isObj(e)) return;
      if (e.agent === "builder" && typeof e.task === "string") {
        e.task = block + e.task;
        out.push({ event: "explorer_brief", role: "builder", chars: block.length, cut: b.summary.length > BRIEF_MAX });
      }
      for (const k of ["tasks", "chain", "parallel"]) if (Array.isArray(e[k])) e[k].forEach(visit);
    };
    visit(input);
    if (out.length > 0) this.latest = null;
    return out;
  }
}
