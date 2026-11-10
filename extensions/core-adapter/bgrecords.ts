// Background-task records for hc clients: the same OSC 7501 escape pi-subagents writes for its async runs (its
// program-status reporter), so `hc get <terminal> --json` lists one record per task (app, state, title, msg) and a
// session that only waits for a background task shows as busy. No `hc` call: the escape travels down the session's
// pty, locally, on a remote machine and on win32 alike. Pure and injectable; the wiring is `installBgRecords`.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Env = Record<string, string | undefined>;
export type BgState = "working" | "done" | "error";

const ROOT = "background-tasks";
const APP = "pi-foreman";
const MAX_RECORDS = 64;
const MAX_TITLE_BYTES = 192;
const MAX_MSG_BYTES = 2048;
const ID_CHARS = 12;
const STATUS_RETRY_MS = 2000;

// The add-on's EventBus channels and schemas (core/extension-api.ts of pi-background-tasks); strings only, the package is never imported.
export const BG_REQUEST_CHANNEL = "pi-background-tasks:request:v1";
export const BG_RESPONSE_CHANNEL = "pi-background-tasks:response:v1";
export const BG_TERMINAL_CHANNEL = "pi-background-tasks:terminal:v1";
const BG_REQUEST_SCHEMA = "pi-background-tasks.extension-request.v1";
const BG_RESPONSE_SCHEMA = "pi-background-tasks.extension-response.v1";
const BG_TERMINAL_SCHEMA = "pi-background-tasks.extension-terminal.v1";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function encode(text: string, maxBytes: number): string {
  // eslint-disable-next-line no-control-regex
  let bytes = Buffer.from(text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim(), "utf-8");
  if (bytes.length > maxBytes) {
    let end = maxBytes;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    bytes = bytes.subarray(0, end);
  }
  return bytes.toString("base64");
}

/** The record key: `background-tasks/<id, 12 characters of A-Za-z0-9_+->`. */
export function recordKey(id: string): string {
  const seg = id.replace(/[^A-Za-z0-9_+-]/g, "-").slice(0, ID_CHARS);
  return `${ROOT}/${seg || "task"}`;
}

/** The escape for one record; `clear` drops it. */
export function oscReport(fields: { state: BgState | "clear"; id: string; title?: string; msg?: string }): string {
  const pairs = [`state=${fields.state}`, `id=${recordKey(fields.id)}`];
  if (fields.state !== "clear") pairs.push(`app=${APP}`);
  if (fields.title !== undefined) pairs.push(`title=${encode(fields.title, MAX_TITLE_BYTES)}`);
  if (fields.msg !== undefined) pairs.push(`msg=${encode(fields.msg, MAX_MSG_BYTES)}`);
  return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}

/** `Started background task <name> (<id>)` (older form: `Started <name> (<id>)`) first line of a bg_run result; null for anything else. */
export function parseStarted(text: string): { name: string; id: string } | null {
  const m = /^Started (?:background task )?(.+) \(([^()\s]+)\)\s*(?:\n|$)/.exec(text);
  return m ? { name: m[1], id: m[2] } : null;
}

export interface BgRecordsDeps {
  write: (data: string) => void;
  env: Env;
  platform: string;
  /** The session's mode (read at each call: it is known from session_start on). */
  mode: () => string | undefined;
  isTTY: boolean;
  trace?: (rec: Record<string, unknown>) => void;
}

export interface BgRecords {
  readonly active: boolean;
  post(id: string, state: BgState, title: string, msg: string): void;
  clear(id: string): void;
  clearAll(): void;
  resend(): void;
  /** A `pi-background-tasks:terminal:v1` frame: flips the task's record to done, error or done "Killed"; malformed frames are ignored. */
  onTerminal(frame: unknown): void;
  /** A task seen running (start or status): working, unless its terminal frame already came. */
  onRunning(id: string, title: string): void;
}

const taskTitle = (t: Record<string, unknown>): string => (typeof t.name === "string" && t.name ? t.name : typeof t.command === "string" ? t.command.slice(0, 40) : "task");

export function createBgRecords(d: BgRecordsDeps): BgRecords {
  const sent = new Map<string, string>();
  const finished = new Set<string>();
  const states = new Map<string, BgState>();
  const isActive = (): boolean => !!(d.env.HERDR_PANE_ID?.trim() || d.env.HC_TERMINAL_ID?.trim()) && d.mode() === "tui" && d.isTTY && d.env.TERM !== "dumb" && d.env.PI_PROGRAM_STATUS !== "0";
  const self: BgRecords = {
    get active() {
      return isActive();
    },
    post(id, state, title, msg) {
      if (!isActive()) return;
      const key = recordKey(id);
      const report = oscReport({ state, id, title, msg });
      if (sent.get(key) === report) return;
      if (!sent.has(key) && sent.size >= MAX_RECORDS) {
        // the cap: drop the oldest finished record, else the oldest
        const victim = [...sent.keys()].find((k) => states.get(k) !== "working") ?? sent.keys().next().value;
        if (victim !== undefined) {
          sent.delete(victim);
          states.delete(victim);
          d.write(`\x1b]7501;state=clear:id=${victim}\x1b\\`);
        }
      }
      sent.set(key, report);
      states.set(key, state);
      d.write(report);
      d.trace?.({ event: "bgrecord", decision: state });
    },
    clear(id) {
      const key = recordKey(id);
      if (!sent.delete(key)) return;
      states.delete(key);
      if (!isActive()) return;
      d.write(oscReport({ state: "clear", id }));
      d.trace?.({ event: "bgrecord", decision: "clear" });
    },
    clearAll() {
      const keys = [...sent.keys()];
      sent.clear();
      states.clear();
      finished.clear();
      if (!isActive()) return;
      for (const key of keys) d.write(`\x1b]7501;state=clear:id=${key}\x1b\\`);
      if (keys.length) d.trace?.({ event: "bgrecord", decision: "clear" });
    },
    resend() {
      if (!isActive()) return;
      for (const report of sent.values()) d.write(report);
    },
    onTerminal(frame) {
      if (!isObj(frame) || frame.schema_version !== BG_TERMINAL_SCHEMA || !isObj(frame.task)) return;
      const t = frame.task;
      if (typeof t.id !== "string" || !t.id) return;
      const status = t.status;
      if (status !== "completed" && status !== "failed" && status !== "killed") return;
      finished.add(t.id);
      if (status === "failed") self.post(t.id, "error", taskTitle(t), "Failed");
      else self.post(t.id, "done", taskTitle(t), status === "killed" ? "Killed" : "Finished");
    },
    onRunning(id, title) {
      if (finished.has(id)) return;
      self.post(id, "working", title, "Running");
    },
  };
  return self;
}

const requestId = (): string => `pi-foreman-bgrecords-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Wire the records into `pi`: the add-on's terminal frames and bg_run results, a `status` request at session_start, retried on the first agent_start and after a short timer until it is answered (tasks that
 * survived a reload), every record cleared on session_shutdown. `recorder` serves foreman_bg (wait.ts), which has its own hooks.
 */
export function installBgRecords(pi: Pick<ExtensionAPI, "on" | "events">, opts: { env?: Env; platform?: string; write?: (data: string) => void; isTTY?: boolean; trace?: (rec: Record<string, unknown>) => void; setTimeout?: (fn: () => void, ms: number) => unknown; clearTimeout?: (h: unknown) => void } = {}): { recorder: BgRecords } {
  let mode: string | undefined;
  const platform = opts.platform ?? process.platform;
  const recorder = createBgRecords({
    write: opts.write ?? ((data) => void process.stdout.write(data)),
    env: opts.env ?? process.env,
    platform,
    mode: () => mode,
    isTTY: opts.isTTY ?? process.stdout.isTTY === true,
    trace: opts.trace,
  });
  const bus = pi.events;
  let offs: (() => void)[] = [];
  let onCont: (() => void) | null = null;
  let retry: (() => void) | null = null;
  let timer: unknown;
  const setT = opts.setTimeout ?? ((fn: () => void, ms: number): unknown => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  });
  const clearT = opts.clearTimeout ?? ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>));
  const unsubscribe = (): void => {
    retry = null;
    if (timer !== undefined) clearT(timer);
    timer = undefined;
    for (const off of offs.splice(0)) off();
    if (onCont) process.off("SIGCONT", onCont);
    onCont = null;
  };
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    unsubscribe();
    mode = ctx.mode;
    if (!recorder.active) return;
    if (platform !== "win32") {
      onCont = () => recorder.resend();
      process.on("SIGCONT", onCont);
    }
    if (!bus) return;
    const reqIds = new Set<string>();
    let answered = false;
    offs.push(bus.on(BG_TERMINAL_CHANNEL, (frame) => recorder.onTerminal(frame)));
    offs.push(
      bus.on(BG_RESPONSE_CHANNEL, (frame) => {
        // an ok:false answer (the add-on's own session_start has not run yet) is not final: a later retry asks again
        if (answered || !isObj(frame) || frame.schema_version !== BG_RESPONSE_SCHEMA || typeof frame.request_id !== "string" || !reqIds.has(frame.request_id) || frame.ok !== true || !isObj(frame.result) || !Array.isArray(frame.result.tasks)) return;
        answered = true;
        for (const t of frame.result.tasks) if (isObj(t) && typeof t.id === "string" && t.status === "running") recorder.onRunning(t.id, taskTitle(t));
      }),
    );
    // no add-on: nobody listens, nothing answers
    const ask = (): void => {
      if (answered) return;
      const reqId = requestId();
      reqIds.add(reqId);
      bus.emit(BG_REQUEST_CHANNEL, { schema_version: BG_REQUEST_SCHEMA, request_id: reqId, operation: "status", payload: {} });
    };
    ask();
    // package load order can put this session_start before the add-on's: retry once on the first agent_start, a last time after a short timer
    let agentRetried = false;
    retry = () => {
      if (agentRetried) return;
      agentRetried = true;
      ask();
    };
    timer = setT(() => {
      timer = undefined;
      ask();
    }, STATUS_RETRY_MS);
  });
  pi.on("agent_start", async () => {
    retry?.();
  });
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bg_run" || event.isError || !recorder.active) return;
    const text = (event.content ?? []).map((c) => (c && c.type === "text" ? (c as { text?: string }).text ?? "" : "")).join("\n");
    const started = parseStarted(text);
    if (started) recorder.onRunning(started.id, started.name);
  });
  pi.on("session_shutdown", async () => {
    unsubscribe();
    recorder.clearAll();
  });
  return { recorder };
}
