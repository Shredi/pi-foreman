// Pure parts of the status strip (docs/herdr.md#status-strip): CPU delta, memory and disk numbers, tones, usage pace and
// forecast, sample spacing, Claude header and usage-source parsing, hide/order. No file, timer or process here; strip.ts
// drives them. Everything a usage script or a response header supplies is untrusted display data.
import { get } from "./config.ts";
import { cleanLabel } from "./extstatus.ts";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const STRIP_VERSION = 1;
export const DEFAULT_STRIP_SECONDS = 10;
export const MIN_STRIP_SECONDS = 5;
export const DEFAULT_SPARKLINE = 12;
export const DEFAULT_SOURCE_SECONDS = 300;
export const MIN_SOURCE_SECONDS = 60;
export const MAX_SOURCES = 8;
export const MAX_ROWS_PER_SOURCE = 8;
export const MAX_SAMPLES = 200;
export const SAMPLE_KEEP_MS = 7 * 24 * 3600_000;
export const LABEL_MAX = 24;
export const ID_RE = /^[a-z0-9._-]{1,40}$/;
const SOURCE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const HOUR_MS = 3600_000;
export const WEEK_MS = 7 * 24 * HOUR_MS;

export type Tone = "neutral" | "amber" | "red";
export type QuotaTone = "neutral" | "green" | "amber" | "red";
/** A usage sample: unix seconds and the used fraction. */
export type Sample = [number, number];

export interface SourceSetting {
  name: string;
  command: string;
  seconds: number;
}
export interface StripConfig {
  enabled: boolean;
  cpu: boolean;
  memory: boolean;
  level: boolean;
  /** null = the session's workspace; [] = no disk lines. */
  disks: string[] | null;
  sampleSeconds: number;
  sparkline: number;
  claude: boolean;
  sources: SourceSetting[];
  hide: string[];
  order: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);

/** The `sidebar.strip.*` settings with their defaults; a wrong type falls back to the default. */
export function stripConfigOf(config: unknown): StripConfig {
  const flag = (k: string): boolean => get(config, `sidebar.strip.${k}`) !== false;
  const secs = get(config, "sidebar.strip.sampleSeconds");
  const spark = get(config, "sidebar.strip.sparkline");
  const disks = get(config, "sidebar.strip.disks");
  const sources: SourceSetting[] = [];
  const raw = get(config, "sidebar.strip.quotas.sources");
  if (isObj(raw)) {
    for (const [name, v] of Object.entries(raw)) {
      if (sources.length >= MAX_SOURCES) break;
      if (!SOURCE_NAME_RE.test(name) || !isObj(v) || typeof v.command !== "string" || !v.command.trim()) continue;
      const s = v.seconds;
      sources.push({ name, command: v.command, seconds: isNum(s) && Number.isInteger(s) && s >= MIN_SOURCE_SECONDS ? s : DEFAULT_SOURCE_SECONDS });
    }
  }
  return {
    enabled: flag("enabled"),
    cpu: flag("cpu"),
    memory: flag("memory"),
    level: flag("level"),
    disks: Array.isArray(disks) ? strings(disks) : null,
    sampleSeconds: isNum(secs) && Number.isInteger(secs) && secs >= MIN_STRIP_SECONDS ? secs : DEFAULT_STRIP_SECONDS,
    sparkline: isNum(spark) && Number.isInteger(spark) && spark >= 2 && spark <= 120 ? spark : DEFAULT_SPARKLINE,
    claude: get(config, "sidebar.strip.quotas.claude") !== false,
    sources,
    hide: strings(get(config, "sidebar.strip.quotas.hide")),
    order: strings(get(config, "sidebar.strip.quotas.order")),
  };
}

// ---- CPU, memory, disks -------------------------------------------------------------------------------------------

export interface CpuTimes {
  times: { user: number; nice: number; sys: number; idle: number; irq: number };
}

const totalOf = (c: CpuTimes["times"]): number => c.user + c.nice + c.sys + c.idle + c.irq;

/** Busy share (0..100, rounded) over all cores between two `os.cpus()` snapshots; null without a base or a change. */
export function cpuPercent(prev: CpuTimes[] | null, cur: CpuTimes[]): number | null {
  if (!prev || prev.length === 0 || prev.length !== cur.length) return null;
  let total = 0;
  let idle = 0;
  for (let i = 0; i < cur.length; i++) {
    total += totalOf(cur[i].times) - totalOf(prev[i].times);
    idle += cur[i].times.idle - prev[i].times.idle;
  }
  if (!(total > 0)) return null;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - idle / total))));
}

/** `history` plus `value`, the newest `cap` kept. */
export function pushHistory(history: number[], value: number, cap: number): number[] {
  return [...history, value].slice(-cap);
}

export interface MemDoc {
  pct: number;
  usedMB: number;
  totalMB: number;
  tone: Tone;
}

/** Memory used from the total and the available memory (MB); null when the total is not positive. */
export function memDoc(totalMB: number, freeMB: number, minFreeMB: number): MemDoc | null {
  if (!isNum(totalMB) || totalMB <= 0 || !isNum(freeMB)) return null;
  const free = Math.max(0, Math.min(totalMB, freeMB));
  return { pct: Math.round((100 * (totalMB - free)) / totalMB), usedMB: Math.round(totalMB - free), totalMB: Math.round(totalMB), tone: toneFree(free, minFreeMB) };
}

/** CPU tone from the 1-minute load per core: amber over the limit, red over twice the limit, neutral without a load. */
export function toneLoad(load1PerCore: unknown, max: number): Tone {
  if (!isNum(load1PerCore) || !isNum(max) || max <= 0) return "neutral";
  return load1PerCore > 2 * max ? "red" : load1PerCore > max ? "amber" : "neutral";
}

/** Memory and disk tone: free below the minimum is amber, below half the minimum red. */
export function toneFree(free: number, min: number): Tone {
  if (!isNum(min) || min <= 0) return "neutral";
  return free < min / 2 ? "red" : free < min ? "amber" : "neutral";
}

export interface StatFs {
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
}
export interface DiskDoc {
  label: string;
  usedPct?: number;
  freeGB?: number;
  tone?: Tone;
  missing?: true;
  /** The default disk (the measuring session's folder): drawn as "Disk" without a path. */
  auto?: true;
}

/**
 * A drive path (`C:`, `c:`, `C:\`, `C:/`) probes its root on Windows (`C:\`) and the WSL drive mount (`/mnt/c`) on every
 * other platform; everything else is kept.
 */
export function diskPathOf(raw: string, platform: string): string {
  const m = /^([A-Za-z]):[\\/]?$/.exec(raw);
  if (!m) return raw;
  return platform === "win32" ? `${m[1]}:\\` : `/mnt/${m[1].toLowerCase()}`;
}

/** One disk line. A probe that throws or reports nothing gives `{label, missing: true}`: never an error. */
export function diskDoc(label: string, probe: () => StatFs, minFreeGB: number): DiskDoc {
  try {
    const st = probe();
    if (!isNum(st.bsize) || !isNum(st.blocks) || !isNum(st.bfree) || !isNum(st.bavail) || st.blocks <= 0 || st.bsize <= 0) return { label, missing: true };
    const used = Math.max(0, st.blocks - st.bfree);
    const denom = used + Math.max(0, st.bavail);
    const freeGB = (Math.max(0, st.bavail) * st.bsize) / 1024 ** 3;
    return { label, usedPct: denom > 0 ? Math.round((100 * used) / denom) : 0, freeGB: Math.round(freeGB * 10) / 10, tone: toneFree(freeGB, minFreeGB) };
  } catch {
    return { label, missing: true };
  }
}

// ---- time and periods ---------------------------------------------------------------------------------------------

/** A reset or start time (ISO text, or unix seconds or milliseconds as number or numeric text) in ms; null when unusable. */
export function parseTime(v: unknown): number | null {
  let n: number | null = null;
  if (isNum(v)) n = v;
  else if (typeof v === "string" && v.trim() !== "") {
    const t = v.trim();
    n = /^\d+(\.\d+)?$/.test(t) ? Number(t) : Date.parse(t);
  }
  if (n === null || !Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

/** The period length in ms from a source's `period` and `periodStart` and the reset time (ms); null = no marker. */
export function periodOf(period: unknown, periodStart: unknown, resetsAt: number | null): number | null {
  if (resetsAt === null) return null;
  if (period === "5h") return 5 * HOUR_MS;
  if (period === "day") return 24 * HOUR_MS;
  if (period === "7d") return WEEK_MS;
  if (period === "month") {
    const d = new Date(resetsAt);
    d.setUTCMonth(d.getUTCMonth() - 1);
    const ms = resetsAt - d.getTime();
    return ms > 0 ? ms : null;
  }
  if (isNum(period) && period > 0) return Math.round(period * 1000);
  const start = parseTime(periodStart);
  if (start !== null && start < resetsAt) return resetsAt - start;
  return null;
}

/** Minimum spacing of kept samples: a 200th of the period, one hour without a period. */
export const sampleSpacingMs = (periodMs: number | null): number => (periodMs && periodMs > 0 ? periodMs / MAX_SAMPLES : HOUR_MS);

/** The samples with `used` at `atSec` added when enough time has passed since the last kept one; the newest 200 are kept. */
export function recordSample(samples: Sample[], atSec: number, used: number, periodMs: number | null): Sample[] {
  const last = samples[samples.length - 1];
  if (last && (atSec - last[0]) * 1000 < sampleSpacingMs(periodMs)) return samples;
  return [...samples, [atSec, Math.round(used * 10000) / 10000] as Sample].slice(-MAX_SAMPLES);
}

/** Share of the period passed (0..1), or null without a reset or a period. */
export function paceOf(now: number, resetsAt: number | null, periodMs: number | null): number | null {
  if (resetsAt === null || periodMs === null || periodMs <= 0) return null;
  return Math.max(0, Math.min(1, (now - (resetsAt - periodMs)) / periodMs));
}

/**
 * True when the recent rate would use the limit up before the reset: the slope over the last seventh of the period
 * (at least 2 points spanning at least half that window, the current value counted as the newest point).
 */
export function forecastRed(samples: Sample[], used: number, now: number, resetsAt: number, periodMs: number): boolean {
  const window = periodMs / 7;
  const points = samples.filter((s) => s[0] * 1000 >= now - window).map((s) => [s[0] * 1000, s[1]] as [number, number]);
  const last = points[points.length - 1];
  if (!last || now > last[0]) points.push([now, used]);
  if (points.length < 2) return false;
  const first = points[0];
  const span = points[points.length - 1][0] - first[0];
  if (span < window / 2) return false;
  const slope = (used - first[1]) / span;
  if (!(slope > 0)) return false;
  return used + slope * Math.max(0, resetsAt - now) >= 1;
}

/** Usage tone: red at 100 % or when the forecast runs out, amber more than 10 points ahead of pace, else green; no marker = neutral. */
export function quotaTone(used: number, pace: number | null, forecast: boolean): QuotaTone {
  if (used >= 1) return "red";
  if (pace === null) return "neutral";
  if (forecast) return "red";
  return used - pace > 0.1 ? "amber" : "green";
}

export interface QuotaValue {
  key: string;
  label: string;
  /** null = no usable value (shown as a dash). */
  used: number | null;
  /** ms */
  resetsAt: number | null;
  periodMs: number | null;
}
export interface QuotaDoc {
  key: string;
  label: string;
  used: number | null;
  pace?: number;
  resetsAt?: string;
  tone: QuotaTone;
}

const isoSec = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The row of one value: a dash row when it has no value or its reset has passed. */
export function quotaDoc(v: QuotaValue, now: number, samples: Sample[]): QuotaDoc {
  if (v.used === null || (v.resetsAt !== null && v.resetsAt <= now)) return { key: v.key, label: v.label, used: null, tone: "neutral" };
  const pace = paceOf(now, v.resetsAt, v.periodMs);
  const red = pace !== null && v.resetsAt !== null && v.periodMs !== null && forecastRed(samples, v.used, now, v.resetsAt, v.periodMs);
  const doc: QuotaDoc = { key: v.key, label: v.label, used: Math.round(v.used * 10000) / 10000, tone: quotaTone(v.used, pace, red) };
  if (pace !== null) doc.pace = Math.round(pace * 10000) / 10000;
  if (v.resetsAt !== null) doc.resetsAt = isoSec(v.resetsAt);
  return doc;
}

/** A used fraction: 0..2 is taken (above 1 is an overrun), anything else is a likely unit mistake. */
export const usedOf = (v: unknown): number | null => (isNum(v) && v >= 0 && v <= 2 ? v : null);

// ---- Claude response headers --------------------------------------------------------------------------------------

export interface ClaudeWindow {
  used: number;
  /** unix seconds */
  resetsAt: number;
}
const HEADER_RE = /^anthropic-ratelimit-unified-([a-z0-9._-]{1,40})-utilization$/;

/**
 * The windows a response carries: a window needs both `-utilization` and `-reset` headers, a name inside the id rule,
 * and a used fraction in 0..2. `overage` is the extra-usage report, not a window. Header names are case-insensitive.
 */
export function parseClaudeHeaders(headers: unknown): Record<string, ClaudeWindow> {
  const out: Record<string, ClaudeWindow> = {};
  if (!isObj(headers)) return out;
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  for (const name of Object.keys(lower)) {
    const m = HEADER_RE.exec(name);
    if (!m || m[1] === "overage") continue;
    const w = m[1];
    const raw = lower[name];
    const used = usedOf(typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw);
    const reset = parseTime(lower[`anthropic-ratelimit-unified-${w}-reset`]);
    if (used === null || reset === null) continue;
    out[w] = { used, resetsAt: Math.round(reset / 1000) };
  }
  return out;
}

/** Readable name of a Claude window: the known ids by name, a variant of 5h or 7d by its suffix, any other id after "Claude". */
export function claudeLabel(w: string): string {
  if (w === "5h") return "Claude 5h";
  if (w === "7d") return "Claude week";
  if (w === "7d_oi") return "Fable week";
  const m = /^(7d|5h)[_-](.+)$/.exec(w);
  if (m) return m[1] === "7d" ? `Week (${m[2]})` : `5h (${m[2]})`;
  return `Claude ${w}`;
}

/** Rows of the Claude windows: 5h and 7d first, any other window by its id (a 7d marker only for `7d…`), each with a readable name. */
export function claudeValues(windows: Record<string, { used: number | null; resetsAt: number }>): QuotaValue[] {
  const names = Object.keys(windows).filter((w) => ID_RE.test(w)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return names.map((w) => {
    const v = windows[w];
    const resetsAt = isNum(v.resetsAt) && v.resetsAt > 0 ? v.resetsAt * 1000 : null;
    const periodMs = w === "5h" ? 5 * HOUR_MS : w.startsWith("7d") ? WEEK_MS : null;
    return { key: `claude:${w}`, label: claudeLabel(w), used: usedOf(v.used), resetsAt, periodMs: resetsAt === null ? null : periodMs };
  });
}
const rank = (w: string): number => (w === "5h" ? 0 : w === "7d" ? 1 : 2);

// ---- usage sources ------------------------------------------------------------------------------------------------

export interface SourceRow {
  id: string;
  label: string;
  used: number | null;
  resetsAt: number | null;
  periodMs: number | null;
}

/** Rows of a usage script's stdout, or null when the output as a whole is bad (not a JSON array). A bad row is dropped, an unusable `used` gives a dash. */
export function parseSourceOutput(stdout: string): SourceRow[] | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(v)) return null;
  const rows: SourceRow[] = [];
  for (const e of v) {
    if (rows.length >= MAX_ROWS_PER_SOURCE) break;
    if (!isObj(e) || typeof e.id !== "string" || !ID_RE.test(e.id) || rows.some((r) => r.id === e.id)) continue;
    const label = typeof e.label === "string" ? cleanLabel(e.label, LABEL_MAX) : "";
    const resetsAt = parseTime(e.resetsAt);
    rows.push({ id: e.id, label: label || e.id, used: usedOf(e.used), resetsAt, periodMs: periodOf(e.period, e.periodStart, resetsAt) });
  }
  return rows;
}

/** Rows with the keys in `order` first (in that order), the rest in their given order; keys in `hide` removed. */
export function arrangeRows<T extends { key: string }>(rows: T[], hide: string[], order: string[]): T[] {
  const shown = rows.filter((r) => !hide.includes(r.key));
  const first = order.flatMap((k) => shown.filter((r) => r.key === k));
  return [...first, ...shown.filter((r) => !order.includes(r.key))];
}

/** Samples of a stored `strip.json` that are well formed, bounded by 200 per row and 64 rows. */
export function samplesOf(v: unknown): Record<string, Sample[]> {
  const out: Record<string, Sample[]> = {};
  if (!isObj(v)) return out;
  for (const [key, list] of Object.entries(v).slice(0, 64)) {
    if (!Array.isArray(list) || key.length > 80) continue;
    const ok = list.filter((s): s is Sample => Array.isArray(s) && s.length === 2 && isNum(s[0]) && isNum(s[1]) && s[1] >= 0 && s[1] <= 2);
    out[key] = ok.slice(-MAX_SAMPLES);
  }
  return out;
}
