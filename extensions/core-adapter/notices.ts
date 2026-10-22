// Dedupe state for "subagent needs attention" notices (pi-subagents sends them as `subagent_control_notice`
// custom messages). `endedRuns` (runs whose end event arrived, RUN_END_EVENTS in supervisor.ts) feeds the visible
// path (hideStaleNotice, index.ts message_end) and the model-context filter (dropEndedRunNotices, index.ts context).
// `admit` (shown once per runId and state, never after the run ended) has no production caller; notices.test.ts calls it.

export class AttentionNotices {
  private readonly seen = new Set<string>();
  private readonly ended = new Set<string>();

  /** Run ids whose end event arrived. */
  get endedRuns(): ReadonlySet<string> {
    return this.ended;
  }

  /** The run's end event arrived: later notices for it are stale. */
  onRunEnd(runId: string): void {
    this.ended.add(runId);
  }

  /** True when the notice should be shown; records it as shown. */
  admit(runId: string, state: string): boolean {
    if (this.ended.has(runId)) return false;
    const key = `${runId}:${state}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Model-context filter: of several `subagent_control_notice` messages for one open tool call
 * ("bash open for 240s", same run + toolCallId + reason) only the first stays. Notices without a
 * toolCallId, and every other message, pass untouched. Null when nothing was dropped.
 */
export function dedupeToolCallNotices<M>(messages: readonly M[]): { messages: M[]; dropped: number } | null {
  const seen = new Set<string>();
  const out: M[] = [];
  for (const m of messages) {
    const ev = isObj(m) && m.role === "custom" && m.customType === "subagent_control_notice" && isObj(m.details) && isObj(m.details.event) ? m.details.event : null;
    if (ev && typeof ev.runId === "string" && typeof ev.toolCallId === "string" && ev.toolCallId) {
      const key = `${ev.runId}:${ev.reason ?? ""}:${ev.toolCallId}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(m);
  }
  return out.length === messages.length ? null : { messages: out, dropped: messages.length - out.length };
}

/**
 * Model-context filter (R12 item 9): drops `subagent_control_notice` messages whose run already ended
 * (`endedRunIds`). Run after dedupeToolCallNotices. Null when nothing was dropped.
 */
export function dropEndedRunNotices<M>(messages: readonly M[], endedRunIds: ReadonlySet<string>): { messages: M[]; dropped: number } | null {
  if (endedRunIds.size === 0) return null;
  const out = messages.filter((m) => {
    const ev = isObj(m) && m.role === "custom" && m.customType === "subagent_control_notice" && isObj(m.details) && isObj(m.details.event) ? m.details.event : null;
    return !(ev && typeof ev.runId === "string" && endedRunIds.has(ev.runId));
  });
  return out.length === messages.length ? null : { messages: out, dropped: messages.length - out.length };
}

/**
 * Input filter (R26 item 2): the run ids of `messages` when every one is a `subagent_control_notice` for a run in `endedRunIds`
 * (a wake that carries only stale notices starts no useful turn). Null for no message, any other message, or a live run's notice.
 */
export function staleNoticeRunIds<M>(messages: readonly M[], endedRunIds: ReadonlySet<string>): string[] | null {
  if (messages.length === 0) return null;
  const runIds: string[] = [];
  for (const m of messages) {
    const ev = isObj(m) && m.role === "custom" && m.customType === "subagent_control_notice" && isObj(m.details) && isObj(m.details.event) ? m.details.event : null;
    if (!ev || typeof ev.runId !== "string" || !endedRunIds.has(ev.runId)) return null;
    runIds.push(ev.runId);
  }
  return runIds;
}

/**
 * Visible path (R12 item 9): a finalized `subagent_control_notice` whose run already ended is returned with `display: false`; anything else is null (leave it).
 */
export function hideStaleNotice<M>(att: AttentionNotices, m: M): M | null {
  const ev = isObj(m) && m.role === "custom" && m.customType === "subagent_control_notice" && isObj(m.details) && isObj(m.details.event) ? m.details.event : null;
  if (!ev || typeof ev.runId !== "string") return null;
  return att.endedRuns.has(ev.runId) ? ({ ...(m as object), display: false } as M) : null;
}
