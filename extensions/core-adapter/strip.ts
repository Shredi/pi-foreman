// Status strip (docs/herdr.md#status-strip): a timer in the main Pi session measures CPU, memory and disks, folds in the
// usage rows (Claude response headers and the usage scripts the user or an overlay names) and writes
// <agentDir>/pi-foreman/state/strip.json for `foreman radar --json`. One sampler per agent dir holds a lease; the others stand
// by. The pressure sampler and pressure.json are untouched; pressure.json is only read (level, free memory, load).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { STATUS_TIMEOUT_MS, MAX_STDOUT, MAX_STDERR, defaultStatusSpawner, resolveProgram, splitCommandLine } from "./extstatus.ts";
import type { StatusSpawner } from "./extstatus.ts";
import { limitsOf, pressurePath, readPressure, sampleSecondsOf } from "./pressure.ts";
import { realTimers } from "./prwatch.ts";
import type { Timers } from "./prwatch.ts";
import { dropLock, ownsLock, takeLock, withFileLock, writeAtomic } from "./statefile.ts";
import {
  SAMPLE_KEEP_MS, STRIP_VERSION, arrangeRows, claudeValues, cpuPercent, diskDoc, diskPathOf, memDoc, parseClaudeHeaders, parseSourceOutput,
  pushHistory, quotaDoc, recordSample, samplesOf, stripConfigOf, toneLoad, usedOf,
} from "./strip-model.ts";
import type { ClaudeWindow, CpuTimes, DiskDoc, MemDoc, QuotaDoc, QuotaValue, Sample, SourceRow, SourceSetting, StatFs, Tone } from "./strip-model.ts";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const stateDir = (agentDir: string): string => path.join(agentDir, "pi-foreman", "state");
export const stripPath = (agentDir: string): string => path.join(stateDir(agentDir), "strip.json");
export const stripLeasePath = (agentDir: string): string => path.join(stateDir(agentDir), "strip.lease");
export const stripClaudePath = (agentDir: string): string => path.join(stateDir(agentDir), "strip-claude.json");

export const CLAUDE_WRITE_EVERY_MS = 30_000;
export const CLAUDE_LOCK_WAIT_MS = 200;
const RESET_TOLERANCE_MS = 60_000;
const MAX_CLAUDE_WINDOWS = 16;
const DEFAULTS = { maxLoadPerCore: 1.5, minFreeMemMB: 1024, minFreeDiskGB: 5 };
const MB = 1024 * 1024;

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
};

// ---- Claude usage note --------------------------------------------------------------------------------------------

type ClaudeFile = Record<string, ClaudeWindow & { at: number }>;

function readClaudeFile(file: string): ClaudeFile {
  const j = readJson(file);
  const out: ClaudeFile = {};
  if (!isObj(j) || !isObj(j.windows)) return out;
  for (const [w, v] of Object.entries(j.windows).slice(0, MAX_CLAUDE_WINDOWS)) {
    if (!isObj(v) || usedOf(v.used) === null || !isNum(v.resetsAt) || v.resetsAt <= 0) continue;
    out[w] = { used: v.used as number, resetsAt: v.resetsAt, at: isNum(v.at) ? v.at : 0 };
  }
  return out;
}

export type ClaudeOutcome = "off" | "none" | "throttled" | "locked" | "written" | "error";

/** The `after_provider_response` hook: notes the usage windows of a response in strip-claude.json. Reads headers and writes one file; never a message or prompt text. */
export class ClaudeUsageHook {
  private last = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  record(agentDir: string, config: unknown, headers: unknown): ClaudeOutcome {
    const cfg = stripConfigOf(config);
    if (!cfg.enabled || !cfg.claude) return "off";
    const seen = parseClaudeHeaders(headers);
    const names = Object.keys(seen);
    if (names.length === 0) return "none";
    const now = this.now();
    if (this.last > 0 && now - this.last < CLAUDE_WRITE_EVERY_MS) return "throttled";
    const file = stripClaudePath(agentDir);
    try {
      withFileLock(`${file}.lock`, () => {
        const windows = readClaudeFile(file);
        for (const w of names) windows[w] = { ...seen[w], at: Math.round(now / 1000) };
        writeAtomic(file, { windows });
      }, CLAUDE_LOCK_WAIT_MS);
    } catch (err) {
      return ((err as Error)?.message ?? "").startsWith("locked:") ? "locked" : "error";
    }
    this.last = now;
    return "written";
  }
}

// ---- the sampler --------------------------------------------------------------------------------------------------

export interface StripDeps {
  agentDir: string;
  /** The path the disk default shows (the session's working directory, as the pressure sampler checks). */
  diskPath: () => string;
  /** The workspace a usage program must lie outside of. */
  workspace: () => string;
  cwd: () => string;
  sessionId: () => string;
  config: () => unknown;
  env: NodeJS.ProcessEnv;
  platform: string;
  trace: (rec: Record<string, unknown>) => void;
  cpus?: () => CpuTimes[];
  totalmem?: () => number;
  freemem?: () => number;
  statfs?: (p: string) => StatFs;
  now?: () => number;
  timers?: Timers;
  spawner?: StatusSpawner;
}

interface SourceState {
  lastRun: number;
  running: boolean;
  rows: SourceRow[] | null;
  failures: number;
}

export interface StripDoc {
  version: 1;
  at: string;
  sampleSeconds: number;
  cpu?: { pct?: number; history: number[]; tone: Tone };
  mem?: MemDoc;
  level?: { level: string; reasons: string[] };
  disks?: DiskDoc[];
  quotas?: QuotaDoc[];
  samples: Record<string, Sample[]>;
}

export class StripSampler {
  private readonly d: StripDeps;
  private readonly timers: Timers;
  private readonly spawner: StatusSpawner;
  private readonly now: () => number;
  private timer: unknown = null;
  private started = false;
  private stopped = false;
  private token: string | null = null;
  private prevCpu: CpuTimes[] | null = null;
  private history: number[] = [];
  private samples: Record<string, Sample[]> = {};
  private resets = new Map<string, number>();
  private readonly sources = new Map<string, SourceState>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(d: StripDeps) {
    this.d = d;
    this.timers = d.timers ?? realTimers;
    this.spawner = d.spawner ?? defaultStatusSpawner;
    this.now = d.now ?? Date.now;
  }

  /** True while this sampler holds the lease. */
  holdsLease(): boolean {
    return this.token !== null;
  }

  start(): void {
    if (this.started || this.stopped || !stripConfigOf(this.d.config()).enabled) return;
    this.started = true;
    process.once("exit", this.onExit);
    this.arm(0);
  }

  /** Last resort when the process ends without `session_shutdown`: gives the lease back synchronously. */
  private readonly onExit = (): void => {
    if (this.token) dropLock(stripLeasePath(this.d.agentDir), this.token);
    this.token = null;
  };

  /** Stops the timer and gives the lease back; a script still running is left to its own timeout and its result is dropped. */
  stop(): Promise<void> {
    this.stopped = true;
    this.timers.clear(this.timer);
    this.timer = null;
    process.removeListener("exit", this.onExit);
    if (this.token) dropLock(stripLeasePath(this.d.agentDir), this.token);
    this.token = null;
    return Promise.resolve();
  }

  /** Resolves when no script run is in flight (tests). */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  private arm(ms: number): void {
    this.timers.clear(this.timer);
    this.timer = this.timers.set(() => {
      this.tick();
      if (!this.stopped) this.arm(stripConfigOf(this.d.config()).sampleSeconds * 1000);
    }, ms);
  }

  /** One measurement round; never throws. */
  tick(): void {
    if (this.stopped) return;
    try {
      this.round();
    } catch {
      // a failing probe or file never reaches the session
    }
  }

  private lease(cfg: { sampleSeconds: number }, now: number): boolean {
    const lock = stripLeasePath(this.d.agentDir);
    if (this.token) {
      if (!ownsLock(lock, this.token)) {
        this.token = null;
        return false;
      }
      try {
        fs.utimesSync(lock, now / 1000, now / 1000);
      } catch {
        // renewed next tick
      }
      return true;
    }
    const token = takeLock(lock, now, 3 * cfg.sampleSeconds * 1000);
    if (!token) return false;
    this.token = token;
    this.prevCpu = null;
    this.load(cfg.sampleSeconds, now);
    return true;
  }

  /** On taking the lease: the sparkline (when recent) and the forecast samples of the last strip.json. */
  private load(sampleSeconds: number, now: number): void {
    this.history = [];
    this.samples = {};
    this.resets = new Map();
    const j = readJson(stripPath(this.d.agentDir));
    if (!isObj(j) || j.version !== STRIP_VERSION) return;
    const at = typeof j.at === "string" ? Date.parse(j.at) : NaN;
    const spark = stripConfigOf(this.d.config()).sparkline;
    if (isObj(j.cpu) && Array.isArray(j.cpu.history) && Number.isFinite(at) && now - at <= spark * sampleSeconds * 1000) {
      this.history = j.cpu.history.filter((x): x is number => isNum(x) && x >= 0 && x <= 100).slice(-spark);
    }
    this.samples = samplesOf(j.samples);
    if (Array.isArray(j.quotas)) {
      for (const q of j.quotas) {
        const t = isObj(q) && typeof q.resetsAt === "string" ? Date.parse(q.resetsAt) : NaN;
        if (isObj(q) && typeof q.key === "string" && Number.isFinite(t)) this.resets.set(q.key, t);
      }
    }
  }

  private round(): void {
    const config = this.d.config();
    const cfg = stripConfigOf(config);
    if (!cfg.enabled) return;
    const now = this.now();
    if (!this.lease(cfg, now)) return;
    const limits = { ...DEFAULTS, ...limitsOf(config) };
    const pressure = readPressure(pressurePath(this.d.agentDir), sampleSecondsOf(config), now);
    const fresh = !(pressure.reasons.length === 1 && (pressure.reasons[0] === "missing" || pressure.reasons[0] === "stale"));
    const host = fresh ? pressure.host : {};
    const doc: StripDoc = { version: STRIP_VERSION, at: iso(now), sampleSeconds: cfg.sampleSeconds, samples: {} };

    if (cfg.cpu) {
      const cur = (this.d.cpus ?? (() => os.cpus() as CpuTimes[]))();
      const pct = cpuPercent(this.prevCpu, cur);
      this.prevCpu = cur;
      if (pct !== null) this.history = pushHistory(this.history, pct, cfg.sparkline);
      else this.history = this.history.slice(-cfg.sparkline);
      doc.cpu = { ...(pct !== null ? { pct } : {}), history: this.history, tone: toneLoad(host.load1PerCore, limits.maxLoadPerCore) };
    }
    if (cfg.memory) {
      const totalMB = (this.d.totalmem ?? os.totalmem)() / MB;
      const freeMB = isNum(host.freeMemMB) ? host.freeMemMB : (this.d.freemem ?? os.freemem)() / MB;
      const mem = memDoc(totalMB, freeMB, limits.minFreeMemMB);
      if (mem) doc.mem = mem;
    }
    if (cfg.level) {
      const high = pressure.level !== "ok" && fresh;
      doc.level = { level: fresh ? pressure.level : "ok", reasons: high ? pressure.reasons : [] };
    }
    const disks = cfg.disks === null ? [this.d.diskPath()] : cfg.disks;
    if (disks.length > 0) {
      const statfs = this.d.statfs ?? ((p: string) => fs.statfsSync(p) as StatFs);
      doc.disks = disks.map((label) => {
        const d = diskDoc(label, () => statfs(diskPathOf(label, this.d.platform)), limits.minFreeDiskGB);
        return cfg.disks === null ? { ...d, auto: true as const } : d;
      });
    }
    const quotas = this.quotas(cfg, now);
    if (quotas.length > 0) doc.quotas = quotas;
    doc.samples = this.samples;
    try {
      writeAtomic(stripPath(this.d.agentDir), doc);
    } catch {
      // a reader holding the file (Windows): skipped, retried next tick
    }
  }

  // ---- usage rows ----

  private quotas(cfg: ReturnType<typeof stripConfigOf>, now: number): QuotaDoc[] {
    const values: QuotaValue[] = [];
    if (cfg.claude) values.push(...claudeValues(readClaudeFile(stripClaudePath(this.d.agentDir))));
    for (const src of cfg.sources) {
      this.runSource(src, now);
      values.push(...this.sourceValues(src));
    }
    const docs: QuotaDoc[] = [];
    const seen = new Set<string>();
    for (const v of values) {
      if (seen.has(v.key)) continue;
      seen.add(v.key);
      let list = this.samples[v.key] ?? [];
      if (v.resetsAt !== null) {
        const before = this.resets.get(v.key);
        if (before !== undefined && Math.abs(before - v.resetsAt) > RESET_TOLERANCE_MS) list = [];
        this.resets.set(v.key, v.resetsAt);
      }
      if (v.used !== null && (v.resetsAt === null || v.resetsAt > now)) list = recordSample(list, Math.round(now / 1000), v.used, v.periodMs);
      this.samples[v.key] = list;
      docs.push(quotaDoc(v, now, list));
    }
    for (const [key, list] of Object.entries(this.samples)) {
      const last = list[list.length - 1];
      if (!seen.has(key) && (!last || now - last[0] * 1000 > SAMPLE_KEEP_MS)) delete this.samples[key];
    }
    return arrangeRows(docs, cfg.hide, cfg.order);
  }

  private sourceValues(src: SourceSetting): QuotaValue[] {
    const st = this.sources.get(src.name);
    if (!st || !st.rows || st.rows.length === 0) return [{ key: `${src.name}:*`, label: src.name, used: null, resetsAt: null, periodMs: null }];
    const dash = st.failures >= 2;
    return st.rows.map((r) => ({ key: `${src.name}:${r.id}`, label: r.label, used: dash ? null : r.used, resetsAt: dash ? null : r.resetsAt, periodMs: dash ? null : r.periodMs }));
  }

  private runSource(src: SourceSetting, now: number): void {
    let st = this.sources.get(src.name);
    if (!st) this.sources.set(src.name, (st = { lastRun: 0, running: false, rows: null, failures: 0 }));
    if (st.running || (st.lastRun > 0 && now - st.lastRun < src.seconds * 1000)) return;
    st.running = true;
    st.lastRun = now;
    const state = st;
    const p = this.exec(src)
      .then((rows) => {
        if (this.stopped) return;
        if (rows) {
          state.rows = rows;
          state.failures = 0;
        } else {
          state.failures += 1;
        }
      })
      .catch(() => {
        if (!this.stopped) state.failures += 1;
      })
      .finally(() => {
        state.running = false;
        this.inflight.delete(p);
      });
    this.inflight.add(p);
  }

  /** The rows a source printed, or null for a failed run (a trace line says why; no output text is kept). */
  private async exec(src: SourceSetting): Promise<SourceRow[] | null> {
    const argv = splitCommandLine(src.command);
    const program = argv ? resolveProgram(argv[0], { workspace: this.d.workspace(), env: this.d.env, platform: this.d.platform }) : null;
    if (!argv || !program) return this.fail(src, "program_missing");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.d.env)) if (typeof v === "string") env[k] = v;
    env.PI_FOREMAN_SESSION_ID = this.d.sessionId();
    const r = await this.spawner(program, argv.slice(1), { cwd: this.d.cwd(), env, timeoutMs: STATUS_TIMEOUT_MS, maxStdout: MAX_STDOUT, maxStderr: MAX_STDERR });
    if (r.timedOut) return this.fail(src, "timeout");
    if (r.error || r.code !== 0) return this.fail(src, "failed");
    if (r.overflow || r.stdout.length > MAX_STDOUT) return this.fail(src, "bad_output");
    const rows = parseSourceOutput(r.stdout);
    return rows ?? this.fail(src, "bad_output");
  }

  private fail(src: SourceSetting, outcome: string): null {
    try {
      this.d.trace({ event: "strip_source", source: src.name, outcome });
    } catch {
      // tracing is best effort
    }
    return null;
  }
}
