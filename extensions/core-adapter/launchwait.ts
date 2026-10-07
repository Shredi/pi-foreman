// Launch-wait (knob 3, ceremony.launchWait) and completion-notice dedupe (knob 5a, ceremony.dedupeNotify).
//
// Launch-wait: a foreman's single-child `subagent` launch (or resume) normally returns at once,
// and the foreman then spends one whole turn on `bg_wait`. With `launchWait: "block"` the
// adapter's tool_result handler holds that launch's result until the run ends (pi.events
// RUN_END_EVENTS), a supervisor request of that run arrives (pi-subagents 0.75.0 emits
// "pi-intercom:detach-request" {requestId, runId} when it surfaces a request that expects a
// reply), the turn is aborted (Esc, session end: ctx.signal / session_shutdown) or
// `wait.maxSeconds` passes, whichever comes first; the outcome is appended to the result.
//
// Pi 1.0.4 runs the tool calls of one assistant message in parallel (pi-agent-core
// executeToolCallsParallel: every tool_call hook first, then execute + tool_result per call
// under Promise.all), unless a tool of the batch is `executionMode: "sequential"` (our own
// foreman_checkpoint is). Sequentially, holding an early launch would delay the later launches;
// so a launch is held only when no later launch of the same message is still unstarted (its
// tool_call not seen yet). In parallel mode that holds every launch, concurrently.
//
// Dedupe: pi-subagents delivers every completion as a `subagent-notify` custom message (content
// only, no details; notify.js formatSingleCompletion), which repeats a result the foreman already
// got. The `context` handler swaps such a notice for a stub when every run it reports was
// delivered by an earlier launch-wait "ended" result (a bg_wait result carries only an archive
// path, so a notice after it stays intact). The run id is the last segment of the notice's
// "Retention-managed async directory:" line (asyncDir = <async root>/<run id>). Pure function of the history: the same history gives
// the same request, so the provider cache prefix stays stable from the first call that sees it.

import { NOTIFY_TYPE } from "./rounds.ts";

export type LaunchWaitMode = "block" | "detach";
export type WaitOutcome = "done" | "supervisor" | "timeout" | "abort";
export const SUPERVISOR_SURFACED_EVENT = "pi-intercom:detach-request";
const CAP = 64;
const SUMMARY_MAX = 20_000;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** ceremony.launchWait: "detach" only when set so, else "block" (the default). */
export function launchWaitMode(v: unknown): LaunchWaitMode {
  return v === "detach" ? "detach" : "block";
}

/** ceremony.dedupeNotify: on unless set to false. */
export function dedupeOn(v: unknown): boolean {
  return v !== false;
}

export interface RunEnd {
  runId: string;
  status: string;
  role: string | null;
  summary: string;
  resultPath: string | null;
}

/** The parts of a run-end event (pi-subagents result-watcher payload) launch-wait reports. */
export function runEndOf(data: unknown): RunEnd | null {
  if (!isObj(data) || !str(data.runId)) return null;
  const results = Array.isArray(data.results) ? data.results.filter(isObj) : [];
  const stopped = data.stopped === true || data.state === "stopped";
  const paused = !stopped && data.success !== true && (data.state === "paused" || data.interrupted === true);
  const status = stopped ? "stopped" : paused ? "paused" : data.success === true ? "completed" : "failed";
  const role = str(data.agent) ?? str(results[0]?.agent) ?? null;
  const summary = str(data.summary) ?? results.map((r) => str(r.summary) ?? "").filter(Boolean).join("\n\n");
  return { runId: data.runId as string, status, role, summary, resultPath: str(data.asyncDir) ?? null };
}

interface Waiter {
  resolve(r: { outcome: WaitOutcome; end?: RunEnd }): void;
}

/** Run ends and supervisor requests by run id, and the launches waiting on them. */
export class LaunchWaits {
  private readonly ended = new Map<string, RunEnd>();
  private readonly asked = new Set<string>();
  private readonly waiters = new Map<string, Set<Waiter>>();

  onRunEnd(data: unknown): void {
    const end = runEndOf(data);
    if (!end) return;
    capPut(this.ended, end.runId, end);
    this.asked.delete(end.runId);
    this.settle(end.runId, { outcome: "done", end });
  }

  onSupervisorRequest(data: unknown): void {
    const runId = isObj(data) ? str(data.runId) : undefined;
    if (!runId) return;
    if (!this.settle(runId, { outcome: "supervisor" })) {
      this.asked.add(runId);
      if (this.asked.size > CAP) this.asked.delete(this.asked.values().next().value as string);
    }
  }

  /** Session end: every held launch returns as aborted. */
  abortAll(): void {
    for (const id of [...this.waiters.keys()]) this.settle(id, { outcome: "abort" });
  }

  get holding(): number {
    let n = 0;
    for (const set of this.waiters.values()) n += set.size;
    return n;
  }

  /** Wait for the first of: run end, supervisor request, abort, `maxMs`. */
  wait(runId: string, maxMs: number, signal?: AbortSignal): Promise<{ outcome: WaitOutcome; end?: RunEnd }> {
    const end = this.ended.get(runId);
    if (end) return Promise.resolve({ outcome: "done", end });
    if (this.asked.delete(runId)) return Promise.resolve({ outcome: "supervisor" });
    if (signal?.aborted) return Promise.resolve({ outcome: "abort" });
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => this.settleOne(runId, waiter, { outcome: "abort" });
      const waiter: Waiter = {
        resolve: (r) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(r);
        },
      };
      let set = this.waiters.get(runId);
      if (!set) this.waiters.set(runId, (set = new Set()));
      set.add(waiter);
      timer = setTimeout(() => this.settleOne(runId, waiter, { outcome: "timeout" }), Math.max(0, maxMs));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private settle(runId: string, r: { outcome: WaitOutcome; end?: RunEnd }): boolean {
    const set = this.waiters.get(runId);
    if (!set || set.size === 0) return false;
    this.waiters.delete(runId);
    for (const w of set) w.resolve(r);
    return true;
  }

  private settleOne(runId: string, w: Waiter, r: { outcome: WaitOutcome; end?: RunEnd }): void {
    const set = this.waiters.get(runId);
    if (!set?.delete(w)) return;
    if (set.size === 0) this.waiters.delete(runId);
    w.resolve(r);
  }
}

function capPut<K, V>(m: Map<K, V>, k: K, v: V): void {
  m.delete(k);
  m.set(k, v);
  if (m.size > CAP) m.delete(m.keys().next().value as K);
}

/**
 * Launch calls of one assistant message, in order, and which of them reached tool_call.
 * A launch is held only when every later launch of its message has started.
 */
export class LaunchBatch {
  private ids: string[] = [];
  private readonly started = new Set<string>();

  /** Assistant message_end: its `subagent` launch/resume calls. */
  onAssistant(content: unknown, isLaunch: (args: unknown) => boolean): void {
    this.ids = [];
    this.started.clear();
    if (!Array.isArray(content)) return;
    for (const c of content) {
      if (isObj(c) && c.type === "toolCall" && c.name === "subagent" && typeof c.id === "string" && isLaunch(c.arguments)) this.ids.push(c.id);
    }
  }

  onToolCall(id: string): void {
    this.started.add(id);
  }

  /** True when `id` is a launch of the current message and no later launch is still unstarted. */
  mayHold(id: string): boolean {
    const i = this.ids.indexOf(id);
    if (i < 0) return false;
    return this.ids.slice(i + 1).every((later) => this.started.has(later));
  }
}

const fmtSeconds = (ms: number): string => `${Math.max(0, Math.round(ms / 1000))}s`;
const DONE_RE = /^pi-foreman launch-wait: run (\S+) \(([^)]*)\) ended /m;

/** The text appended to a held launch result. */
export function launchWaitText(o: { outcome: WaitOutcome; runId: string; role: string; ms: number; maxSeconds: number; end?: RunEnd; asyncDir?: string | null }): string {
  const path = o.end?.resultPath ?? o.asyncDir ?? null;
  const where = path ? ` Result path: ${path}.` : "";
  switch (o.outcome) {
    case "done": {
      const s = o.end?.summary ?? "";
      const body = s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX)}\n[... cut at ${SUMMARY_MAX} characters; the full output is under the result path]` : s || "(no output)";
      return `pi-foreman launch-wait: run ${o.runId} (${o.role}) ended ${o.end?.status ?? "completed"} after ${fmtSeconds(o.ms)}.${where} No bg_wait is needed for it. Child output:\n${body}`;
    }
    case "supervisor":
      return `pi-foreman launch-wait: run ${o.runId} (${o.role}) is still running and the child asks you something (the supervisor request follows). Answer it with subagent_supervisor, then bg_wait ${o.runId}.${where}`;
    case "timeout":
      return `pi-foreman launch-wait: run ${o.runId} (${o.role}) is still running after ${o.maxSeconds}s (wait.maxSeconds); this is not a failure. Continue with bg_wait ${o.runId}.${where}`;
    case "abort":
      return `pi-foreman launch-wait: the wait was cancelled; run ${o.runId} (${o.role}) keeps running detached and its completion notice will follow.${where}`;
  }
}

// ------------------------------------------------------------------ dedupe

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (isObj(c) && c.type === "text" && typeof c.text === "string" ? c.text : "")).join("\n");
}

const DIR_LINE = /^Retention-managed async directory: (.+)$/gm;

/** Run ids a completion notice reports, with the verbatim directory lines; null when it names none. */
export function noticeRuns(text: string): { ids: string[]; lines: string[] } | null {
  const lines: string[] = [];
  const ids: string[] = [];
  for (const m of text.matchAll(DIR_LINE)) {
    const dir = m[1].trim();
    const id = dir.split(/[\\/]/).filter(Boolean).pop();
    if (!id) continue;
    lines.push(m[0]);
    ids.push(id);
  }
  return ids.length ? { ids, lines } : null;
}

/**
 * Run ids whose result this message delivered: a launch-wait "ended" result only. A bg_wait result
 * names just an archive path, not the report, so a notice after it stays intact.
 */
export function deliveredRuns(m: unknown): string[] {
  if (!isObj(m) || m.role !== "toolResult" || m.toolName !== "subagent") return [];
  const hit = DONE_RE.exec(textOf(m.content));
  return hit ? [hit[1]] : [];
}

/** A held launch's own result without pi-subagents' "Return control to the user now ..." line (it contradicts the hold). */
export function dropReturnControl<C>(content: readonly C[]): C[] {
  return content.map((c) => (isObj(c) && c.type === "text" && typeof c.text === "string" ? ({ ...c, text: c.text.split("\n").filter((l) => !l.includes("Return control to the user now")).join("\n") } as C) : c));
}

/** One-line stub: the notice's first line (status and role), the run ids and its directory lines, verbatim. */
export function noticeStub(text: string, runs: { ids: string[]; lines: string[] }): string {
  const head = text.split(/\r?\n/, 1)[0] ?? "";
  return `${head} [pi-foreman: notice shortened, the result of run ${runs.ids.join(", ")} was already delivered above. ${runs.lines.join("; ")}]`;
}

/**
 * The context with every completion notice whose runs were all delivered earlier replaced by its
 * stub, or null when nothing changes. `deduped` lists the run ids of the stubbed notices.
 */
export function dedupeNotices<M>(messages: readonly M[]): { messages: M[]; deduped: string[] } | null {
  const delivered = new Set<string>();
  let out: M[] | null = null;
  const deduped: string[] = [];
  messages.forEach((m, i) => {
    for (const id of deliveredRuns(m)) delivered.add(id);
    if (!isObj(m) || m.role !== "custom" || m.customType !== NOTIFY_TYPE) return;
    const text = textOf(m.content);
    const runs = noticeRuns(text);
    if (!runs || !runs.ids.every((id) => delivered.has(id))) return;
    out ??= [...messages];
    out[i] = { ...m, content: noticeStub(text, runs) } as M;
    deduped.push(...runs.ids);
  });
  return out ? { messages: out, deduped } : null;
}
