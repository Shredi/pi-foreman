// Host pressure gate (R5 P1b): the reader of <agentDir>/pi-foreman/state/pressure.json, the sampler timer and the
// launch-gate decisions. The Python sampler (scripts/foreman_pressure.py) writes the file; the launch path only reads it.
//
//   ok        nothing changes.
//   high      fan-out width 1 (one launch of an assistant message runs, the rest wait for it) and no strong climb.
//   critical  a child launch is refused; a `pressure` wait wakes the foreman with the launch arguments when the level drops.
//
// Explorers are never gated: an explorer-only launch runs at any level and does not take the first-launch slot at high.
// The sampler's load reason needs both the 5-minute and the 1-minute load per core over the limit.
//
// A missing, unreadable or stale file (older than 3x resources.sampleSeconds) is "ok": a dead sampler never blocks work.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { get } from "./config.ts";
import { subagentAgents } from "./payload.ts";
import { groupEntryObjects } from "./usage.ts";
import type { DialogSpec } from "./ownerdialog.ts";

export type PressureLevel = "ok" | "high" | "critical";
export interface PressureState {
  level: PressureLevel;
  reasons: string[];
  at: string;
  host: Record<string, unknown>;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

export const DEFAULT_SAMPLE_SECONDS = 30;
/** A critical-pressure wait gives up and wakes the foreman after this long. */
export const CRITICAL_WAIT_SECONDS = 600;
export const PRESSURE_FIXTURE_ENV = "PI_FOREMAN_PRESSURE_FIXTURE";
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export const pressurePath = (agentDir: string): string => path.join(agentDir, "pi-foreman", "state", "pressure.json");

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** resources.sampleSeconds: an integer of at least 5, else 30. */
export function sampleSecondsOf(config: unknown): number {
  const v = get(config, "resources.sampleSeconds");
  return typeof v === "number" && Number.isInteger(v) && v >= 5 ? v : DEFAULT_SAMPLE_SECONDS;
}

/** The resources limits handed to the sampler (`--limits`): the numeric keys only. */
export function limitsOf(config: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of ["maxLoadPerCore", "minFreeMemMB", "minFreeDiskGB"]) {
    const v = get(config, `resources.${k}`);
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Mirrors scripts/foreman_pressure.py read_state: ok/missing when unreadable, ok/stale when older than 3x sampleSeconds. */
export function readPressure(file: string, sampleSeconds: number, now: number = Date.now()): PressureState {
  const missing: PressureState = { level: "ok", reasons: ["missing"], at: iso(now), host: {} };
  let rec: Json;
  let at: number;
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!isObj(j) || typeof j.at !== "string" || !AT.test(j.at) || !["ok", "high", "critical"].includes(j.level as string)) return missing;
    at = Date.parse(j.at);
    if (!Number.isFinite(at)) return missing;
    rec = j;
  } catch {
    return missing;
  }
  const state: PressureState = {
    level: rec.level as PressureLevel,
    reasons: Array.isArray(rec.reasons) ? rec.reasons.filter((r): r is string => typeof r === "string") : [],
    at: rec.at as string,
    host: isObj(rec.host) ? rec.host : {},
  };
  if (now - at > 3 * sampleSeconds * 1000) return { ...state, level: "ok", reasons: ["stale"] };
  return state;
}

export interface SamplerDeps {
  file: string;
  workspace: string;
  config: () => unknown;
  /** Runs `foreman_pressure.py <args>`; a failure is a rejection or `ok: false`. */
  run: (args: string[], signal?: AbortSignal) => Promise<{ ok: boolean; text: string }>;
  trace: (rec: Record<string, unknown>) => void;
  /** Host sample file for the sampler's `--fixture` (tests; never set in production). */
  fixture?: string;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

/** Writes the pressure file every resources.sampleSeconds. Never throws and never overlaps; the first failure is traced once. */
export class PressureSampler {
  private handle: unknown = null;
  private busy = false;
  private failed = false;
  private stopped = false;
  private inflight: { done: Promise<void>; abort: AbortController } | null = null;
  private readonly d: SamplerDeps;

  constructor(d: SamplerDeps) {
    this.d = d;
  }

  start(): void {
    if (this.handle !== null) return;
    void this.tick();
    const every = (this.d.setInterval ?? ((fn, ms) => {
      const h = setInterval(fn, ms);
      h.unref?.();
      return h;
    }));
    this.handle = every(() => void this.tick(), sampleSecondsOf(this.d.config()) * 1000);
  }

  /** Stops the timer, aborts the in-flight sample and resolves once its child has exited: nothing writes after this. */
  stop(): Promise<void> {
    this.stopped = true;
    if (this.handle !== null) {
      (this.d.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>)))(this.handle);
      this.handle = null;
    }
    this.inflight?.abort.abort();
    return this.inflight?.done ?? Promise.resolve();
  }

  tick(): Promise<void> {
    if (this.busy || this.stopped) return Promise.resolve();
    this.busy = true;
    const abort = new AbortController();
    const done = this.sample(abort.signal).finally(() => {
      this.busy = false;
      this.inflight = null;
    });
    this.inflight = { done, abort };
    return done;
  }

  private async sample(signal: AbortSignal): Promise<void> {
    try {
      const cfg = this.d.config();
      const args = ["sample", "--workspace", this.d.workspace, "--state", this.d.file, "--limits", JSON.stringify(limitsOf(cfg))];
      if (this.d.fixture) args.push("--fixture", this.d.fixture);
      const r = await this.d.run(args, signal);
      if (!r.ok && !signal.aborted) this.fail("sampler_failed");
    } catch {
      if (!signal.aborted) this.fail("sampler_error");
    }
  }

  private fail(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    try {
      this.d.trace({ event: "pressure_sampler", reason });
    } catch {
      // tracing is best effort
    }
  }
}

/** The text of a refused launch under critical pressure. */
export const criticalReason = (reasons: string[]): string => `pressure critical (${reasons.join(", ") || "unknown"}): launch deferred; you will be woken when it drops`;

/** The launch field with which the foreman asks the owner to let one deferred launch start at critical load. */
export const OVERRIDE_FIELD = "pressureOverride";

/**
 * Reads and removes `pressureOverride` from a `subagent` call: the top level, else `options`/`args` of the top level (an emptied `args` box
 * goes, as in liftSizing), and every tasks/chain/parallel entry with its boxes. `text` is the top-level text (a non-string or empty value is
 * absent); `nested` is true when it was found only inside an entry.
 */
export function takePressureOverride(input: Json): { text?: string; nested: boolean } {
  let top: string | undefined;
  let inner: string | undefined;
  const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
  const take = (o: Json, into: "top" | "inner"): void => {
    const set = (v: string | undefined): void => {
      if (v === undefined) return;
      if (into === "top") top ??= v;
      else inner ??= v;
    };
    set(text(o[OVERRIDE_FIELD]));
    delete o[OVERRIDE_FIELD];
    for (const key of ["options", "args"] as const) {
      const box = o[key];
      if (!isObj(box) || box[OVERRIDE_FIELD] === undefined) continue;
      set(text(box[OVERRIDE_FIELD]));
      delete box[OVERRIDE_FIELD];
      if (key === "args" && Object.keys(box).length === 0) delete o[key];
    }
  };
  if (!isObj(input)) return { nested: false };
  take(input, "top");
  for (const e of groupEntryObjects(input)) take(e, "inner");
  return top !== undefined ? { text: top, nested: false } : inner !== undefined ? { text: inner, nested: true } : { nested: false };
}

export type OverrideCode = "no_ui" | "cause" | "shape" | "declined_recently";
export type OverrideShape = "single" | "group" | "resume";

/** What a launch call is: a new single launch (`agent` and `task` at the top, nothing else), a resume or other action, or a group. */
export function overrideShape(call: Json): OverrideShape {
  const a = call.action;
  if (a !== undefined && a !== null && !(typeof a === "string" && a.trim() === "")) return "resume";
  const none = ["tasks", "chain", "parallel", "workflow"].every((k) => call[k] === undefined);
  return none && typeof call.agent === "string" && call.agent !== "" && typeof call.task === "string" ? "single" : "group";
}

/**
 * Whether the owner can be asked to approve this deferred launch: "ok" or the first code that fails (cause, shape, no_ui, declined_recently).
 * Only a critical level that is the load alone can be overridden; `nested`: the field was found only inside an entry.
 */
export function overrideAvailability(a: { reasons: string[]; call: Json; nested: boolean; ui: boolean; declinedRecently: boolean }): "ok" | OverrideCode {
  if (a.reasons.length !== 1 || a.reasons[0] !== "load") return "cause";
  if (a.nested || overrideShape(a.call) !== "single") return "shape";
  if (!a.ui) return "no_ui";
  if (a.declinedRecently) return "declined_recently";
  return "ok";
}

/** Why a requested approval is not possible, one clause for the refusal. */
export const OVERRIDE_UNAVAILABLE: Record<OverrideCode, string> = {
  no_ui: "no owner can answer at this pane, so no approval is possible; wait",
  cause: "the cause is memory or disk; an approval cannot help there; wait",
  shape: "only a new launch of one agent can be approved: launch the urgent one alone with pressureOverride, or wait (a resume cannot be approved)",
  declined_recently: "the owner declined or dismissed an approval; do not ask again until the owner writes",
};

/** The refusal of a launch whose approval was requested but is not possible. */
export const overrideUnavailableReason = (reasons: string[], code: OverrideCode): string => `${criticalReason(reasons)} (${OVERRIDE_FIELD}: ${OVERRIDE_UNAVAILABLE[code]})`;

/** The refusal of a launch whose approval the owner declined or dismissed. */
export const overrideDeclinedReason = (reasons: string[]): string => `${criticalReason(reasons)} (the owner did not approve this launch; do not ask again unless the owner says so)`;

/** The one sentence the refusal of a deferred launch without the field adds, by the availability code (declined_recently counts as ok). */
export function overrideHint(code: "ok" | OverrideCode, shape: OverrideShape): string {
  if (code === "no_ui") return "No owner can approve it at this pane; wait.";
  if (code === "cause") return "The cause is memory or disk; an owner approval cannot help; wait.";
  if (code === "shape") {
    return shape === "resume"
      ? "A resume cannot get an owner approval; wait."
      : `If one of these launches cannot wait, launch it alone with ${OVERRIDE_FIELD}: \"<why>\"; the owner approves or declines it in a dialog.`;
  }
  return `If this launch cannot wait, relaunch it with the top-level key ${OVERRIDE_FIELD}: \"<why it cannot wait>\"; the owner approves or declines it in a dialog. Do not retry it unchanged.`;
}

/** Trace hash of a task: the first 16 hex of its sha256 (the trace never carries the text). */
export const taskHash = (task: unknown): string => createHash("sha256").update(typeof task === "string" ? task : "").digest("hex").slice(0, 16);

/** One line of free text: whitespace collapsed, cut to `max` characters with an ellipsis. */
export function cutLine(text: string, max: number, firstLineOnly = false): string {
  const src = firstLineOnly ? (text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "") : text;
  const one = src.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The owner dialog of an override request: agent, task head, reason and the load with its limit. */
export function overrideSpec(a: { agent: string; task: string; reason: string; host: Record<string, unknown>; maxLoadPerCore: unknown }): DialogSpec {
  const load = `1 min ${num(a.host.load1PerCore, 2)}/core, 5 min ${num(a.host.loadPerCore, 2)}/core, limit ${num(a.maxLoadPerCore, 2)}/core`;
  return {
    ask: "Start this launch despite high load?",
    summary: "The host is overloaded, so launches wait. Yes starts this one launch now; No keeps it waiting.",
    facts: [["Agent", cutLine(a.agent, 80)], ["Task", cutLine(a.task, 300, true)], ["Reason", cutLine(a.reason, 300)], ["Load", load]],
    answers: "Yes: this one launch starts now   No: it waits until the load drops",
  };
}

/** The text of a launch queued behind another under high pressure. */
export const queuedReason = (reasons: string[]): string =>
  `pressure high (${reasons.join(", ") || "unknown"}): child launches run one at a time; this launch is queued behind the one that runs; you will be woken when it can start (relaunch it then)`;

/** A call's launch arguments as JSON, for a wake message. */
export const argsJson = (args: unknown): string => JSON.stringify(args);

/** A launch whose every agent is the explorer (single `agent`, `tasks` or `chain`): never gated by pressure. */
export function explorerOnly(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const agents = subagentAgents(input as Json);
  return agents.length > 0 && agents.every((a) => a === "explorer");
}

/**
 * Width 1 for one `tasks` call: keeps the first entry in `input` and returns a copy of the call with the rest, or null
 * when the call has no parallel `tasks` to narrow.
 */
export function narrowTasks(input: Json): Json | null {
  const tasks = input.tasks;
  if (!Array.isArray(tasks) || tasks.length < 2) return null;
  const rest = { ...input, tasks: tasks.slice(1) };
  input.tasks = tasks.slice(0, 1);
  return rest;
}

/** The wake text of a pressure wait that resolved. */
export function pressureOutcome(kind: "critical" | "queue", level: PressureLevel | "timeout", args: unknown[]): string {
  const json = argsJson(args.length === 1 ? args[0] : args);
  if (kind === "critical") return level === "timeout" ? `pressure: still critical, relaunch with: ${json}` : `pressure: ${level}, relaunch with: ${json}`;
  return level === "timeout" ? `pressure: queued launches waited too long, relaunch one at a time with: ${json}` : `pressure: ${level}, a run ended; relaunch the queued launches one at a time with: ${json}`;
}

const num = (v: unknown, digits: number): string => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits).replace(/\.0+$/, "") : "unknown");

/** The `foreman doctor` line: INFO only, an unknown probe prints `unknown`. */
export function pressureDoctorLine(p: PressureState): string {
  const h = p.host;
  return `INFO pressure: ${p.level} (${p.reasons.join(", ") || "none"}) load5/core=${num(h.loadPerCore, 2)} load1/core=${num(h.load1PerCore, 2)} freeMem=${typeof h.freeMemMB === "number" && Number.isFinite(h.freeMemMB) ? `${num(h.freeMemMB, 0)}MB` : "unknown"} freeDisk=${typeof h.freeDiskGB === "number" && Number.isFinite(h.freeDiskGB) ? `${num(h.freeDiskGB, 1)}GB` : "unknown"}`;
}

/** The `/foreman status` pressure line. */
export function pressureStatusLine(p: PressureState, now: number = Date.now()): string {
  const at = Date.parse(p.at);
  const age = Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : "unknown";
  return `pressure: ${p.level} (${p.reasons.join(", ") || "none"}) sampled ${age}s ago`;
}
