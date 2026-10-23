// Presence gate (docs/cache.md): is the owner at the keyboard? Probes the seconds since the last input event
// (darwin ioreg HIDIdleTime, Windows and WSL powershell GetLastInputInfo, Linux xprintidle, or the
// `presence.command` override). Every probe is a detached child with a short timeout and never runs inside the
// synchronous `cache_warming_decision` hook: a background timer refreshes the cached sample shortly before a warm is due
// and the hook and the self-warm read the cache. A failed, timed-out or missing probe is `unknown`, which counts as present.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { Timers } from "./prwatch.ts";

export type PresenceOutcome = "present" | "away" | "unknown";
export interface PresenceSample {
  outcome: PresenceOutcome;
  idleSeconds: number | null;
  at: number;
}
export interface PresenceConfig {
  enabled: boolean;
  awayAfterMinutes: number;
  command: string | null;
}

/** Runs one probe command; resolves with its stdout, or null on a spawn error, a non-zero exit or the timeout. */
export type RunProbe = (cmd: string, args: string[], timeoutMs: number, shell: boolean) => Promise<string | null>;

export const PROBE_TIMEOUT_MS = 2000;
export const PROBE_TIMEOUT_WIN_MS = 5000;
/** The sample is refreshed at most this often. */
export const PROBE_MIN_GAP_MS = 60_000;
/** The background probe runs this long before a warm is due. */
export const PROBE_LEAD_MS = 60_000;

const PS_SCRIPT =
  "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class Idle { [StructLayout(LayoutKind.Sequential)] struct LII { public uint cbSize; public uint dwTime; } [DllImport(\"user32.dll\")] static extern bool GetLastInputInfo(ref LII p); public static double Seconds() { LII i = new LII(); i.cbSize = (uint)Marshal.SizeOf(i); if (!GetLastInputInfo(ref i)) return -1; return ((uint)Environment.TickCount - i.dwTime) / 1000.0; } }'; [Idle]::Seconds()";

const firstNumber = (out: string | null): number | null => {
  const m = out ? /-?\d+(?:\.\d+)?/.exec(out) : null;
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** `ioreg -c IOHIDSystem` output: HIDIdleTime is nanoseconds. */
export function parseIoreg(out: string | null): number | null {
  const m = out ? /"HIDIdleTime"\s*=\s*(\d+)/.exec(out) : null;
  return m ? Number(m[1]) / 1e9 : null;
}

export interface ProbeEnv {
  platform: string;
  /** Linux running under WSL (`/proc/version` mentions "microsoft"). */
  wsl: boolean;
  run: RunProbe;
}

/** Seconds since the last input, or null (unknown). */
export async function probeIdleSeconds(env: ProbeEnv, command: string | null): Promise<number | null> {
  try {
    if (command) return firstNumber(await env.run(command, [], PROBE_TIMEOUT_MS, true));
    if (env.platform === "darwin") return parseIoreg(await env.run("ioreg", ["-c", "IOHIDSystem"], PROBE_TIMEOUT_MS, false));
    if (env.platform === "win32" || env.wsl) {
      const exe = env.platform === "win32" ? "powershell" : "powershell.exe";
      return firstNumber(await env.run(exe, ["-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT], PROBE_TIMEOUT_WIN_MS, false));
    }
    if (env.platform === "linux") {
      const ms = firstNumber(await env.run("xprintidle", [], PROBE_TIMEOUT_MS, false));
      return ms === null ? null : ms / 1000;
    }
  } catch {
    // unknown
  }
  return null;
}

/** Detached child with a hard timeout; never throws. */
export const runProbe: RunProbe = (cmd, args, timeoutMs, shell) =>
  new Promise((resolve) => {
    let done = false;
    let out = "";
    const finish = (v: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child: ReturnType<typeof spawn> | undefined;
    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        // already gone
      }
      finish(null);
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    try {
      child = spawn(cmd, args, { detached: true, shell, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      child.unref();
      child.stdout?.on("data", (d: Buffer) => {
        out += d.toString();
      });
      child.on("error", () => finish(null));
      child.on("close", (code) => finish(code === 0 ? out : null));
    } catch {
      finish(null);
    }
  });

export function isWsl(platform: string): boolean {
  if (platform !== "linux") return false;
  try {
    return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

export interface PresenceDeps {
  now(): number;
  timers?: Timers;
  config(): PresenceConfig;
  /** Replaces the platform probe (tests); resolves seconds since the last input or null. */
  probe?: (command: string | null) => Promise<number | null>;
  trace(r: Record<string, unknown>): void;
}

const realTimers: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class Presence {
  private deps: PresenceDeps;
  private timers: Timers;
  private timer: unknown = null;
  private last: PresenceSample | null = null;
  private inflight: Promise<void> | null = null;
  private tracedOutcome: PresenceOutcome | null = null;

  constructor(deps: PresenceDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? realTimers;
  }

  /** The cached sample; never probes. */
  sample(): PresenceSample | null {
    return this.last;
  }

  /** True when the cached sample says away (disabled, unknown and unsampled all count as present). */
  away(): boolean {
    return this.deps.config().enabled && this.last?.outcome === "away";
  }

  /** Re-probe unless the sample is younger than a minute; resolves once the sample is current. */
  refresh(): Promise<void> {
    const cfg = this.deps.config();
    if (!cfg.enabled) return Promise.resolve();
    if (this.last && this.deps.now() - this.last.at < PROBE_MIN_GAP_MS) return Promise.resolve();
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      let idle: number | null = null;
      try {
        idle = await (this.deps.probe ? this.deps.probe(cfg.command) : probeIdleSeconds({ platform: process.platform, wsl: isWsl(process.platform), run: runProbe }, cfg.command));
      } catch {
        idle = null;
      }
      const outcome: PresenceOutcome = idle === null ? "unknown" : idle >= cfg.awayAfterMinutes * 60 ? "away" : "present";
      this.last = { outcome, idleSeconds: idle === null ? null : Math.round(idle), at: this.deps.now() };
      if (outcome !== this.tracedOutcome) {
        this.tracedOutcome = outcome;
        this.deps.trace({ event: "presence", outcome, idleSeconds: this.last.idleSeconds });
      }
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** One background probe `PROBE_LEAD_MS` before `dueAt` (absolute ms); replaces an earlier arm. */
  armBefore(dueAt: number): void {
    this.disarm();
    if (!this.deps.config().enabled) return;
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.refresh();
    }, Math.max(0, dueAt - PROBE_LEAD_MS - this.deps.now()));
  }

  disarm(): void {
    this.timers.clear(this.timer);
    this.timer = null;
  }
}
