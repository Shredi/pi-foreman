// A child that receives the same guard refusal twice (same tool, same reason text after whitespace
// normalising) is stopped: the run reports "run failed: repeated guarded-token probe" and a
// `child_probe_stop` trace event {role, tool, reason} records it. In memory, per session.
export const REPEAT_STOP_TEXT = "run failed: repeated guarded-token probe";

export class RepeatRefusals {
  private readonly seen = new Set<string>();

  /** True when this (tool, reason) refusal was seen before; the first one only records it. */
  note(tool: string, reason: string): boolean {
    const key = `${tool}\u0000${reason.replace(/\s+/g, " ").trim()}`;
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    return false;
  }
}

/** The block reason that ends the child run. */
export function repeatStopReason(reason: string): string {
  return `pi-foreman: ${REPEAT_STOP_TEXT}. The same refusal came twice (${reason.replace(/\s+/g, " ").trim().slice(0, 160)}); the run is stopped. Report what you were trying to do and stop.`;
}
