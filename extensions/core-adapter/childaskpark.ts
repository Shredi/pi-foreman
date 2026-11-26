// Plan asks-wait-for-owner D3: what a parent session remembers about asks of runs that ended while the child waited on the owner (memory only,
// gone with the session). A run that ends with an open ask keeps its dir and dialog; the owner's answer is parked for exactly that call and used once
// when the resumed run asks again. A resume maps its new run id to the launch of the first run, which keeps the ask dir.
import * as path from "node:path";

const MAX_RUNS = 200;

/** Park key: the launch (its ask dir), tool, cwd and the child's hash of the whole tool input. */
export const parkKey = (dir: string, tool: string, cwd: string, hash: string): string => JSON.stringify([path.basename(dir), tool, cwd, hash]);

export class ChildAskPark {
  private readonly parked = new Map<string, boolean>();
  /** Ask dirs whose run ended while an ask was open. */
  private readonly ended = new Set<string>();
  /** Run id -> launch id, for every single launch and resume this session saw. */
  private readonly launchOf = new Map<string, string>();
  /** Launch tool call id -> launch id, from the launch hook to the tool result (the keep-alive tier reads which pending launch waits on an ask). */
  private readonly callLaunch = new Map<string, string>();
  /** Resume tool call id -> launch id, from the launch hook to the tool result. */
  private readonly resumeCalls = new Map<string, string>();
  /** Live resumed runs: run id -> launch id; run ends seen before the tool result. */
  private readonly resumed = new Map<string, string>();
  private resumedEnded: string[] = [];

  park(key: string, allow: boolean): void {
    this.parked.set(key, allow);
  }

  /** Every parked answer of the launch dir `dir` is dropped: the first ask of a resumed run ends the parked ask's life, whether or not it matched. */
  dropDir(dir: string): void {
    const base = path.basename(dir);
    for (const k of [...this.parked.keys()]) if ((JSON.parse(k) as unknown[])[0] === base) this.parked.delete(k);
  }

  /** The parked answer of `key`, removed (single use), or undefined. */
  take(key: string): boolean | undefined {
    const v = this.parked.get(key);
    this.parked.delete(key);
    return v;
  }

  markEnded(dir: string): void {
    this.ended.add(dir);
  }

  isEnded(dir: string): boolean {
    return this.ended.has(dir);
  }

  /** A resume: the launch runs again, its asks are live asks. */
  clearEnded(dir: string): void {
    this.ended.delete(dir);
  }

  noteRun(runId: string, launchId: string): void {
    this.launchOf.delete(runId);
    this.launchOf.set(runId, launchId);
    for (const old of this.launchOf.keys()) {
      if (this.launchOf.size <= MAX_RUNS) break;
      this.launchOf.delete(old);
    }
  }

  launchFor(runId: string): string | undefined {
    return this.launchOf.get(runId);
  }

  noteCall(callId: string, launchId: string): void {
    this.callLaunch.set(callId, launchId);
  }

  launchOfCall(callId: string): string | undefined {
    return this.callLaunch.get(callId);
  }

  dropCall(callId: string): void {
    this.callLaunch.delete(callId);
  }

  resumeCall(callId: string, launchId: string): void {
    this.resumeCalls.set(callId, launchId);
  }

  /** A resume's tool result: maps the new run to its launch; returns the launch id to finish now when that run already ended, else null. */
  resumeLaunched(callId: string, runId: string | null): string | null {
    const launch = this.resumeCalls.get(callId);
    this.resumeCalls.delete(callId);
    if (!launch || !runId) return launch ?? null;
    this.noteRun(runId, launch);
    if (this.resumedEnded.includes(runId)) return launch;
    this.resumed.set(runId, launch);
    return null;
  }

  /** A run end: the launch of a live resumed run (to finish), else null (the end is remembered for a late tool result). */
  resumedRunEnd(runId: string): string | null {
    const launch = this.resumed.get(runId);
    if (launch) {
      this.resumed.delete(runId);
      return launch;
    }
    this.resumedEnded.push(runId);
    if (this.resumedEnded.length > MAX_RUNS) this.resumedEnded.shift();
    return null;
  }
}
