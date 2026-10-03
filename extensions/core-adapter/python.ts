// Find a Python >= 3.9 for the core scripts (design §7 "Python resolution").
import * as path from "node:path";
import type { Spawner } from "./spawn.ts";

export interface PythonCandidate {
  command: string;
  args: string[];
  source: string;
}

export interface PythonInfo {
  /** Absolute interpreter path (sys.executable); used for every later run. */
  executable: string;
  version: [number, number];
  source: string;
}

export type PythonResolution =
  | { ok: true; info: PythonInfo; rejected: string[] }
  | { ok: false; rejected: string[] };

export const MIN_VERSION: [number, number] = [3, 9];
export const PROBE_CODE = "import sys;print('%d.%d' % sys.version_info[:2]);print(sys.executable)";
const PROBE_TIMEOUT_MS = 10_000;

export interface CandidateInput {
  configPath?: string | null;
  envPath?: string | null;
  platform: string;
}

/** python.path -> PI_FOREMAN_PYTHON -> Windows `py -3`, `python` / Unix `python3`, `python`. */
export function pythonCandidates(input: CandidateInput): PythonCandidate[] {
  const out: PythonCandidate[] = [];
  if (input.configPath && input.configPath.trim()) out.push({ command: input.configPath.trim(), args: [], source: "python.path" });
  if (input.envPath && input.envPath.trim()) out.push({ command: input.envPath.trim(), args: [], source: "PI_FOREMAN_PYTHON" });
  if (input.platform === "win32") {
    out.push({ command: "py", args: ["-3"], source: "py -3" });
    out.push({ command: "python", args: [], source: "python" });
  } else {
    out.push({ command: "python3", args: [], source: "python3" });
    out.push({ command: "python", args: [], source: "python" });
  }
  return out;
}

/**
 * The Microsoft Store alias stub lives directly in `...\Microsoft\WindowsApps\`.
 * A real Store install lives in a package subdirectory below it and is accepted.
 */
export function isStoreAliasStub(file: string, platform: string): boolean {
  if (platform !== "win32" || !file) return false;
  const parent = path.win32.basename(path.win32.dirname(file));
  return parent.toLowerCase() === "windowsapps";
}

export function parseProbe(stdout: string): { version: [number, number]; executable: string } | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const m = /^(\d+)\.(\d+)$/.exec(lines[0] ?? "");
  if (!m) return null;
  return { version: [Number(m[1]), Number(m[2])], executable: lines[1] ?? "" };
}

export function versionOk(v: [number, number]): boolean {
  return v[0] > MIN_VERSION[0] || (v[0] === MIN_VERSION[0] && v[1] >= MIN_VERSION[1]);
}

export async function resolvePython(input: CandidateInput & { spawner: Spawner; env?: Record<string, string> }): Promise<PythonResolution> {
  const rejected: string[] = [];
  for (const c of pythonCandidates(input)) {
    const label = `${c.source} (${[c.command, ...c.args].join(" ")})`;
    if (isStoreAliasStub(c.command, input.platform)) {
      rejected.push(`${label}: Windows Store alias stub`);
      continue;
    }
    const r = await input.spawner(c.command, [...c.args, "-E", "-c", PROBE_CODE], { timeoutMs: PROBE_TIMEOUT_MS, env: input.env });
    if (r.error || r.timedOut || r.code !== 0) {
      const why = r.error ? r.error.message : r.timedOut ? "timed out" : `exit ${r.code}`;
      rejected.push(`${label}: ${why}`);
      continue;
    }
    const probe = parseProbe(r.stdout);
    if (!probe) {
      rejected.push(`${label}: unreadable version output`);
      continue;
    }
    if (!versionOk(probe.version)) {
      rejected.push(`${label}: Python ${probe.version.join(".")} is older than 3.9`);
      continue;
    }
    const executable = probe.executable || c.command;
    if (isStoreAliasStub(executable, input.platform)) {
      rejected.push(`${label}: Windows Store alias stub`);
      continue;
    }
    return { ok: true, info: { executable, version: probe.version, source: c.source }, rejected };
  }
  return { ok: false, rejected };
}

/** One resolution per session id. */
export class PythonCache {
  private readonly bySession = new Map<string, Promise<PythonResolution>>();
  get(sessionId: string, resolve: () => Promise<PythonResolution>): Promise<PythonResolution> {
    let hit = this.bySession.get(sessionId);
    if (!hit) {
      hit = resolve();
      this.bySession.set(sessionId, hit);
    }
    return hit;
  }
  drop(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

export const NO_PYTHON_FIX =
  "Install Python 3.9+ or set python.path / PI_FOREMAN_PYTHON; run /foreman doctor.";
