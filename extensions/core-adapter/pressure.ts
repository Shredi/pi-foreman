// Host pressure gate (R5 P1b): the reader of <agentDir>/pi-foreman/state/pressure.json, the sampler timer and the
// launch-gate decisions. The Python sampler (scripts/foreman_pressure.py) writes the file; the launch path only reads it.
//
//   ok        nothing changes.
//   high      fan-out width 1 (one launch of an assistant message runs, the rest wait for it) and no strong climb.
//   critical  a child launch is refused; a `pressure` wait wakes the foreman with the launch arguments when the level drops.
//
// A missing, unreadable or stale file (older than 3x resources.sampleSeconds) is "ok": a dead sampler never blocks work.
import * as fs from "node:fs";
import * as path from "node:path";
import { get } from "./config.ts";

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
  run: (args: string[]) => Promise<{ ok: boolean; text: string }>;
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

  stop(): void {
    if (this.handle === null) return;
    (this.d.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>)))(this.handle);
    this.handle = null;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const cfg = this.d.config();
      const args = ["sample", "--workspace", this.d.workspace, "--state", this.d.file, "--limits", JSON.stringify(limitsOf(cfg))];
      if (this.d.fixture) args.push("--fixture", this.d.fixture);
      const r = await this.d.run(args);
      if (!r.ok) this.fail("sampler_failed");
    } catch {
      this.fail("sampler_error");
    } finally {
      this.busy = false;
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

/** The text of a launch queued behind another under high pressure. */
export const queuedReason = (reasons: string[]): string =>
  `pressure high (${reasons.join(", ") || "unknown"}): child launches run one at a time; this launch is queued behind the one that runs; you will be woken when it can start (relaunch it then)`;

/** A call's launch arguments as JSON, for a wake message. */
export const argsJson = (args: unknown): string => JSON.stringify(args);

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
  return `INFO pressure: ${p.level} (${p.reasons.join(", ") || "none"}) load/core=${num(h.loadPerCore, 2)} freeMem=${typeof h.freeMemMB === "number" && Number.isFinite(h.freeMemMB) ? `${num(h.freeMemMB, 0)}MB` : "unknown"} freeDisk=${typeof h.freeDiskGB === "number" && Number.isFinite(h.freeDiskGB) ? `${num(h.freeDiskGB, 1)}GB` : "unknown"}`;
}

/** The `/foreman status` pressure line. */
export function pressureStatusLine(p: PressureState, now: number = Date.now()): string {
  const at = Date.parse(p.at);
  const age = Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : "unknown";
  return `pressure: ${p.level} (${p.reasons.join(", ") || "none"}) sampled ${age}s ago`;
}
