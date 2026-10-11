// Dedupe state for "subagent needs attention" notices (pi-subagents sends them as `subagent_control_notice`
// custom messages). A notice is shown once per (runId, state) and never after the run's end event
// (RUN_END_EVENTS). Pi's extension hooks cannot drop a queued custom message before it starts a turn
// (docs/safety.md), so nothing in the adapter consults this yet; it is the state a drop hook would use.

export class AttentionNotices {
  private readonly seen = new Set<string>();
  private readonly ended = new Set<string>();

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
