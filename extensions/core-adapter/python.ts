// Find a Python >= 3.9 for the core scripts (design §7 "Python resolution").
import * as fs from "node:fs";
import * as path from "node:path";
import { workspaceTop } from "./gitdrift.ts";
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
export const PROBE_CODE =
  "import sys;print('%d.%d' % sys.version_info[:2]);print(sys.executable);print(getattr(sys,'_base_executable','') or sys.executable);print(sys.prefix)";
const PROBE_TIMEOUT_MS = 10_000;

export interface CandidateInput {
  configPath?: string | null;
  envPath?: string | null;
  platform: string;
  /**
   * Session cwd. Interpreters inside its workspace (git top level, else the cwd itself) are
   * rejected: a child with write tools could replace them or their venv's site-packages, and
   * every guard runs on them (security review cycle 2, U7). Omitted = no workspace check.
   */
  cwd?: string | null;
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

export function parseProbe(stdout: string): { version: [number, number]; executable: string; base: string; prefix: string } | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const m = /^(\d+)\.(\d+)$/.exec(lines[0] ?? "");
  if (!m) return null;
  return { version: [Number(m[1]), Number(m[2])], executable: lines[1] ?? "", base: lines[2] ?? "", prefix: lines[3] ?? "" };
}

/**
 * Where an interpreter must not live: the git top level of `cwd`; outside a repo only a
 * `.venv`/`venv` directory below `cwd` (a cwd such as the home directory must not reject
 * every user-level install).
 */
export interface Workspace {
  root: string;
  venvOnly: boolean;
}

export function workspaceOf(cwd: string): Workspace {
  const top = workspaceTop(cwd);
  return top ? { root: top, venvOnly: false } : { root: path.resolve(cwd), venvOnly: true };
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function within(root: string, p: string, platform: string, venvOnly: boolean): boolean {
  const fold = platform === "win32" || platform === "darwin" ? (s: string) => s.toLowerCase() : (s: string) => s;
  const rel = path.relative(fold(root), fold(p));
  if (rel !== "" && (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || path.isAbsolute(rel))) return false;
  return !venvOnly || rel.split(/[\\/]/).some((c) => c === ".venv" || c === "venv");
}

/**
 * The first of `paths` (as given and with symlinks resolved) that lies inside `ws`, or null.
 * A venv's `bin/python` is often a symlink to a system interpreter, so the unresolved path and
 * `sys.prefix` (the venv root) count, not only the realpath.
 */
export function insideWorkspace(paths: string[], ws: Workspace, platform: string): string | null {
  const roots = [path.resolve(ws.root), real(ws.root)];
  for (const p of paths) {
    if (!p) continue;
    for (const q of [path.resolve(p), real(p)]) if (roots.some((r) => within(r, q, platform, ws.venvOnly))) return p;
  }
  return null;
}

/** Where a bare command name would be found on PATH (for the pre-probe check), or null. */
export function lookPath(command: string, pathVar: string | undefined, platform: string, pathext?: string): string | null {
  if (/[\\/]/.test(command)) return path.resolve(command);
  const exts = platform === "win32" ? ["", ...(pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const dir of (pathVar ?? "").split(platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const e of exts) {
      const f = path.join(dir, command + e);
      try {
        if (fs.statSync(f).isFile()) return f;
      } catch {
        // next
      }
    }
  }
  return null;
}

const WORKSPACE_WHY = "inside the workspace (a child could replace it); skipped";

export function versionOk(v: [number, number]): boolean {
  return v[0] > MIN_VERSION[0] || (v[0] === MIN_VERSION[0] && v[1] >= MIN_VERSION[1]);
}

export async function resolvePython(input: CandidateInput & { spawner: Spawner; env?: Record<string, string> }): Promise<PythonResolution> {
  const rejected: string[] = [];
  const workspace = input.cwd ? workspaceOf(input.cwd) : null;
  const pathEnv = input.env ?? process.env;
  const pathVar = Object.entries(pathEnv).find(([k]) => k.toUpperCase() === "PATH")?.[1];
  for (const c of pythonCandidates(input)) {
    const label = `${c.source} (${[c.command, ...c.args].join(" ")})`;
    if (isStoreAliasStub(c.command, input.platform)) {
      rejected.push(`${label}: Windows Store alias stub`);
      continue;
    }
    // Before the probe: probing would already run the workspace venv's site-packages.
    const found = workspace && c.args.length === 0 ? lookPath(c.command, pathVar, input.platform, pathEnv.PATHEXT) : null;
    if (workspace && found && insideWorkspace([found], workspace, input.platform)) {
      rejected.push(`${label}: ${found} is ${WORKSPACE_WHY}`);
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
    const hit = workspace ? insideWorkspace([executable, probe.base, probe.prefix], workspace, input.platform) : null;
    if (hit) {
      rejected.push(`${label}: ${hit} is ${WORKSPACE_WHY}`);
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
