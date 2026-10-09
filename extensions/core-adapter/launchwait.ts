// Launch-wait (knob 3, ceremony.launchWait) and completion-notice dedupe (knob 5a, ceremony.dedupeNotify).
//
// Launch-wait: a foreman's single-child `subagent` launch (or resume) normally returns at once,
// and the foreman then spends one whole turn on `bg_wait`. With `launchWait: "block"` the
// adapter's tool_result handler holds that launch's result until the run ends (pi.events
// RUN_END_EVENTS), a supervisor request of any run arrives (pi-subagents 0.75.0 emits
// "pi-intercom:detach-request" {requestId, runId} when it surfaces a request that expects a
// reply; it releases every held launch), the turn is aborted (Esc, session end: ctx.signal /
// session_shutdown) or the hold cap passes (holdCap: wait.maxSeconds, or the child role's
// timeoutMinutes plus 60 s when shorter), whichever comes first; the outcome is appended to the result.
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
export type WaitOutcome = "done" | "supervisor" | "released" | "timeout" | "abort";
export interface WaitResult {
  outcome: WaitOutcome;
  end?: RunEnd;
  /** "released": the run whose supervisor request ended this wait. */
  by?: string;
}
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
  resolve(r: WaitResult): void;
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

  /**
   * A supervisor request of any run releases every held launch: the request reaches the foreman
   * only after all tool calls of the message have returned (Pi holds the batch under Promise.all).
   */
  onSupervisorRequest(data: unknown): void {
    const runId = isObj(data) ? str(data.runId) : undefined;
    if (!runId) return;
    if (!this.settle(runId, { outcome: "supervisor" })) {
      this.asked.add(runId);
      if (this.asked.size > CAP) this.asked.delete(this.asked.values().next().value as string);
    }
    for (const id of [...this.waiters.keys()]) this.settle(id, { outcome: "released", by: runId });
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
  wait(runId: string, maxMs: number, signal?: AbortSignal): Promise<WaitResult> {
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

  private settle(runId: string, r: WaitResult): boolean {
    const set = this.waiters.get(runId);
    if (!set || set.size === 0) return false;
    this.waiters.delete(runId);
    for (const w of set) w.resolve(r);
    return true;
  }

  private settleOne(runId: string, w: Waiter, r: WaitResult): void {
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

/**
 * How long a launch is held, in seconds: wait.maxSeconds, or the child role's timeoutMinutes plus
 * 60 s when that is shorter (a lost run-end event must not stall the foreman for wait.maxSeconds).
 */
export function holdCap(maxSeconds: number, roleTimeoutMs: number | undefined): { seconds: number; by: string } {
  const role = roleTimeoutMs === undefined ? Infinity : Math.ceil(roleTimeoutMs / 1000) + 60;
  return role < maxSeconds ? { seconds: role, by: "the role's timeoutMinutes plus 60s" } : { seconds: maxSeconds, by: "wait.maxSeconds" };
}

/**
 * A launch is not held while a child's supervisor request is open (the foreman must answer it
 * first): the line appended to the plain launch result, or null when no request is open.
 */
export function openRequestLine(openRequests: number, runId: string): string | null {
  return openRequests > 0 ? `pi-foreman launch-wait: a child's question is open: answer it, then bg_wait ${runId}.` : null;
}

const fmtSeconds = (ms: number): string => `${Math.max(0, Math.round(ms / 1000))}s`;
// pi-foreman's own "done" marker: the start of the separate text block the adapter appends last.
const DONE_PREFIX = "pi-foreman launch-wait: run ";
const DONE_RE = /^pi-foreman launch-wait: run (\S+) \(([^)\n]*)\) ended /;

/** The text appended to a held launch result. `capBy` names the hold limit of a timeout (default wait.maxSeconds). */
export function launchWaitText(o: { outcome: WaitOutcome; runId: string; role: string; ms: number; maxSeconds: number; capBy?: string; by?: string; end?: RunEnd; asyncDir?: string | null }): string {
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
    case "released":
      return `pi-foreman launch-wait: run ${o.runId} (${o.role}) is still running; the wait ended because run ${o.by ?? "?"} asks you something (the supervisor request follows). Answer it with subagent_supervisor, then continue with bg_wait ${o.runId}.${where}`;
    case "timeout":
      return `pi-foreman launch-wait: run ${o.runId} (${o.role}) is still running after ${o.maxSeconds}s (${o.capBy ?? "wait.maxSeconds"}); this is not a failure. Continue with bg_wait ${o.runId}.${where}`;
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
 * names just an archive path, not the report, so a notice after it stays intact. Only pi-foreman's
 * own marker counts: the last text block of a non-error `subagent` result starts with it, and the
 * result's details name that run; text inside a block (a child's output in a status result) never does.
 */
export function deliveredRuns(m: unknown): string[] {
  if (!isObj(m) || m.role !== "toolResult" || m.toolName !== "subagent" || m.isError === true || !Array.isArray(m.content)) return [];
  const last = m.content[m.content.length - 1];
  if (!isObj(last) || last.type !== "text" || typeof last.text !== "string" || !last.text.startsWith(DONE_PREFIX)) return [];
  const hit = DONE_RE.exec(last.text);
  const d = isObj(m.details) ? m.details : {};
  return hit && (d.runId === hit[1] || d.asyncId === hit[1]) ? [hit[1]] : [];
}

// pi-subagents' async-started guidance (async-execution.js formatAsyncStartedMessage), interactive and
// non-interactive text. All of it contradicts a held launch, which returns the child's result itself.
const ASYNC_GUIDANCE = [
  /^The async run is detached/,
  /^You are in an interactive session\./,
  /^Use bg_wait only for/,
  /^If the current turn must receive results from work without a native notification/,
  /^Otherwise, continue any independent work/,
  /^This is a non-interactive run: Pi auto-drains/,
  /^Use subagent\(\{ action: "status"/,
  /Return control to the user now/,
];

/** A held launch's own result without pi-subagents' async-started guidance lines (detached, bg_wait, "Return control ..."); `trimmed` counts the removed lines. */
export function dropAsyncGuidance<C>(content: readonly C[]): { content: C[]; trimmed: number } {
  let trimmed = 0;
  const out = content.map((c) => {
    if (!isObj(c) || c.type !== "text" || typeof c.text !== "string") return c;
    const lines = c.text.split("\n");
    const kept = lines.filter((l) => !ASYNC_GUIDANCE.some((re) => re.test(l)));
    if (kept.length === lines.length) return c;
    trimmed += lines.length - kept.length;
    return { ...c, text: kept.join("\n").trimEnd() } as C;
  });
  return { content: out, trimmed };
}

/** One-line stub: the notice's first line (status and role), the run ids and its directory lines, verbatim. */
export function noticeStub(text: string, runs: { ids: string[]; lines: string[] }): string {
  const head = text.split(/\r?\n/, 1)[0] ?? "";
  return `${head} [pi-foreman: notice shortened, the result of run ${runs.ids.join(", ")} was already delivered above. ${runs.lines.join("; ")}]`;
}

/**
 * The context with every completion notice whose runs were all delivered earlier removed ("drop",
 * default) or replaced by its stub ("stub"), or null when nothing changes. `deduped` lists the run
 * ids of those notices.
 */
export function dedupeNotices<M>(messages: readonly M[], mode: "drop" | "stub" = "drop"): { messages: M[]; deduped: string[]; mode: "dropped" | "stub" } | null {
  const delivered = new Set<string>();
  const out: M[] = [];
  let changed = false;
  const deduped: string[] = [];
  for (const m of messages) {
    for (const id of deliveredRuns(m)) delivered.add(id);
    const text = isObj(m) && m.role === "custom" && m.customType === NOTIFY_TYPE ? textOf(m.content) : "";
    const runs = text ? noticeRuns(text) : null;
    if (!runs || !runs.ids.every((id) => delivered.has(id))) {
      out.push(m);
      continue;
    }
    changed = true;
    deduped.push(...runs.ids);
    if (mode === "stub") out.push({ ...(m as object), content: noticeStub(text, runs) } as M);
  }
  return changed ? { messages: out, deduped, mode: mode === "drop" ? "dropped" : "stub" } : null;
}
