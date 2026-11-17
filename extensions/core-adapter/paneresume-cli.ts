// `foreman pane-resume --shell-pid <pid>` (bin/foreman): run by the shell hook at a prompt when a pane note exists for the terminal. It decides
// (paneresume-core.ts `decideResume`) whether Pi ran in this pane and crashed, and if so restarts the session after a countdown. This module
// tree imports only `node:*` and pi-foreman modules without a Pi package: never livestate.ts, bg.ts or paneresume.ts.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { piAgentDir } from "./env.ts";
import { shimScript } from "./pi-shim.mjs";
import { COUNTDOWN_MS, HC_GET_TIMEOUT_MS, TERMINAL_RE, buildSpawnEnv, decideResume, deleteNote, dropLock, hcGet, pidAlive, readLiveRecord, readLiveStartedMs, readNoteRaw, readResumeSetting, readSessionFile, takeLock, validateNote } from "./paneresume-core.ts";
import type { Decision, LaunchKeys, PaneNote } from "./paneresume-core.ts";

export const USAGE = "usage: foreman pane-resume --shell-pid <pid>";
/** Exit code for "kept, check again at the next prompt": the hook removes its marker on it. */
export const RECHECK_EXIT = 75;

type Env = Record<string, string | undefined>;
type Key = "enter" | "cancel" | "timeout";

interface InStream {
  isTTY?: boolean;
  setRawMode?: (on: boolean) => unknown;
  resume: () => unknown;
  pause: () => unknown;
  on: (ev: "data", cb: (chunk: Buffer | string) => void) => unknown;
  off: (ev: "data", cb: (chunk: Buffer | string) => void) => unknown;
}

/** What `child_process.spawn` returns, as far as this command uses it. */
export interface PiChild {
  on(ev: "spawn", cb: () => void): unknown;
  on(ev: "error", cb: (err: Error) => void): unknown;
  on(ev: "exit", cb: (code: number | null, signal: string | null) => void): unknown;
}

/** A process, as far as the Git Bash rule reads it: its parent pid and the image paths of the process and of its parent. */
export interface ProcInfo {
  parentPid: number;
  image: string;
  parentImage: string;
}

export interface PaneResumeDeps {
  env: Env;
  agentDir: string;
  platform: string;
  now: () => number;
  uptimeS: () => number;
  stdin: InStream;
  stdoutIsTty: boolean;
  out: (line: string) => void;
  hcGet: typeof hcGet;
  pidAlive: (pid: number) => boolean;
  countdownMs: number;
  spawnPi: (args: string[], o: { cwd: string; env: Record<string, string> }) => PiChild;
  /** win32 only: the start time (ms since the epoch) of a live process, or null when it cannot be read. */
  procStartMs?: (pid: number) => number | null;
  /** win32 only: parent pid and image paths of a process, or null when they cannot be read. */
  procParent?: (pid: number) => ProcInfo | null;
}

/** What `resolvePi` found: the JS entry of an npm-style `pi.cmd` shim, or a `pi.exe`. */
export type PiResolved = { kind: "shim"; entry: string } | { kind: "exe"; file: string };

/** win32: `pi` on the PATH of `env`, directory by directory: a `pi.cmd` shim (its JS entry must exist), else a `pi.exe`. Null when there is none. */
export function resolvePi(env: Env, exists: (f: string) => boolean = fs.existsSync, readShim: (cmd: string, dir: string) => string | null = shimScript): PiResolved | null {
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path");
  for (const raw of (key ? (env[key] ?? "") : "").split(";")) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    const cmd = path.win32.join(dir, "pi.cmd");
    if (exists(cmd)) {
      let entry: string | null = null;
      try {
        entry = readShim(cmd, dir);
      } catch {
        entry = null;
      }
      if (entry && exists(entry)) return { kind: "shim", entry };
    }
    const exe = path.win32.join(dir, "pi.exe");
    if (exists(exe)) return { kind: "exe", file: exe };
  }
  return null;
}

/** The program and argv that start Pi without a shell: posix `pi`; win32 the Node of this process on a shim's JS entry, or `pi.exe`. Throws when win32 found no Pi. */
export function piCommand(resolved: PiResolved | null, args: string[], platform: string): { program: string; argv: string[] } {
  if (platform !== "win32") return { program: "pi", argv: args };
  if (!resolved) throw new Error("pi was not found on PATH");
  return resolved.kind === "shim" ? { program: process.execPath, argv: [resolved.entry, ...args] } : { program: resolved.file, argv: args };
}

const norm = (p: string): string => p.replace(/\\/g, "/").toLowerCase();
const real = (p: string): string => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
};

/**
 * win32: whether the shell is the Git Bash shell that the hc terminal's root program (`hcPid`, the `bin\bash.exe` launcher) started: the
 * shell's parent is `hcPid`, the parent's image ends in `\bin\bash.exe`, the shell's in `\usr\bin\bash.exe`, both under the same Git root.
 */
export function isGitBashLauncherChild(hcPid: number, info: ProcInfo | null): boolean {
  if (!info || info.parentPid !== hcPid) return false;
  const parent = norm(real(info.parentImage));
  const shell = norm(real(info.image));
  if (!parent.endsWith("/bin/bash.exe") || !shell.endsWith("/usr/bin/bash.exe")) return false;
  return parent.slice(0, -"/bin/bash.exe".length) === shell.slice(0, -"/usr/bin/bash.exe".length);
}

function psRun(cmd: string): string | null {
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8", timeout: 5000, windowsHide: true });
  return r.status === 0 && typeof r.stdout === "string" ? r.stdout.trim() : null;
}

function realProcStartMs(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const out = psRun(`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`);
  const ms = out ? Date.parse(out) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function realProcParent(pid: number): ProcInfo | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const out = psRun(`$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; $q = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p.ParentProcessId); ConvertTo-Json -Compress @{ parentPid = [int]$p.ParentProcessId; image = [string]$p.ExecutablePath; parentImage = [string]$q.ExecutablePath }`);
  try {
    const o = JSON.parse(out ?? "") as Record<string, unknown>;
    return typeof o.parentPid === "number" && typeof o.image === "string" && typeof o.parentImage === "string" ? { parentPid: o.parentPid, image: o.image, parentImage: o.parentImage } : null;
  } catch {
    return null;
  }
}

const clean = (s: string, max = 80): string => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, max);

function defaults(): PaneResumeDeps {
  return {
    env: process.env,
    agentDir: "",
    platform: process.platform,
    now: () => Date.now(),
    uptimeS: () => os.uptime(),
    stdin: process.stdin as unknown as InStream,
    stdoutIsTty: process.stdout.isTTY === true,
    out: (line) => void process.stdout.write(`${line}\n`),
    hcGet,
    pidAlive,
    countdownMs: COUNTDOWN_MS,
    spawnPi: (args, o) => {
      const c = piCommand(process.platform === "win32" ? resolvePi(o.env) : null, args, process.platform);
      return spawn(c.program, c.argv, { cwd: o.cwd, env: o.env, stdio: "inherit" });
    },
    procStartMs: realProcStartMs,
    procParent: realProcParent,
  };
}

function countdown(stdin: InStream, ms: number): Promise<Key> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (k: Key): void => {
      clearTimeout(timer);
      stdin.off("data", onData);
      // raw mode off and stdin released before Pi starts: Pi gets every key
      stdin.setRawMode?.(false);
      stdin.pause();
      resolve(k);
    };
    const onData = (chunk: Buffer | string): void => {
      const first = typeof chunk === "string" ? chunk.charCodeAt(0) : chunk[0];
      finish(first === 13 || first === 10 ? "enter" : "cancel");
    };
    timer = setTimeout(() => finish("timeout"), ms);
    stdin.setRawMode?.(true);
    stdin.on("data", onData);
    stdin.resume();
  });
}

function runPi(d: PaneResumeDeps, note: PaneNote, env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ignore = (): void => {};
    process.on("SIGINT", ignore); // Ctrl+C belongs to Pi while it runs
    const end = (code: number): void => {
      process.off("SIGINT", ignore);
      dropLock(d.agentDir, note.sessionId);
      resolve(code);
    };
    let child: PiChild;
    try {
      child = d.spawnPi(["--session", note.sessionFile], { cwd: note.cwd, env });
    } catch (err) {
      d.out(`pi-foreman: could not start pi: ${clean((err as Error).message, 200)}`);
      d.out(`pi-foreman: resume by hand: pi --session ${note.sessionId}`);
      return end(1);
    }
    child.on("spawn", () => deleteNote(d.agentDir, note.terminal)); // Pi writes a fresh note at its start
    child.on("error", (err) => {
      d.out(`pi-foreman: could not start pi: ${clean(err.message, 200)}`);
      d.out(`pi-foreman: resume by hand: pi --session ${note.sessionId}`);
      end(1);
    });
    child.on("exit", (code, signal) => end(code ?? (signal && os.constants.signals[signal as keyof typeof os.constants.signals] ? 128 + os.constants.signals[signal as keyof typeof os.constants.signals] : 1)));
  });
}

const handLine = (name: string | null, id: string): string => `pi-foreman: Pi session${name ? ` "${clean(name)}"` : ""} ended without a clean quit and is not restarted. Resume by hand: pi --session ${id}`;

/** The command: 0 on every outcome the hook should ignore, RECHECK_EXIT for a keep to decide again, Pi's exit code after a restart, 2 on a usage error. */
export async function runPaneResume(argv: string[], over: Partial<PaneResumeDeps> = {}): Promise<number> {
  const d = { ...defaults(), ...over };
  const at = argv.indexOf("--shell-pid");
  const shellPid = at >= 0 && /^\d{1,10}$/.test(argv[at + 1] ?? "") ? Number(argv[at + 1]) : NaN;
  if (argv.length !== 2 || !Number.isInteger(shellPid) || shellPid <= 0) {
    d.out(USAGE);
    return 2;
  }
  const terminal = (d.env.HC_TERMINAL_ID ?? "").trim();
  if (!TERMINAL_RE.test(terminal)) return 0; // no note path is built from anything else: the hook never deletes outside state/panes
  const agentDir = d.agentDir || piAgentDir(d.env, os.homedir());
  d.agentDir = agentDir;
  const raw = readNoteRaw(agentDir, terminal);
  if (raw === undefined) return 0;
  const check = validateNote(raw, agentDir, terminal, d.platform);
  const setting = readResumeSetting(agentDir);
  const tty = d.stdin.isTTY === true && d.stdoutIsTty;
  const note = check.ok ? check.note : null;
  const early = !check.ok || setting === "off" || !tty;
  const now = d.now();
  const live = note ? readLiveRecord(agentDir, note.sessionId) : null;
  let cwdIsDir = false;
  if (note) {
    try {
      cwdIsDir = fs.statSync(note.cwd).isDirectory();
    } catch {
      cwdIsDir = false;
    }
  }
  const hc = early ? "error" : await d.hcGet(terminal, HC_GET_TIMEOUT_MS, d.env);
  let socket = (d.env.HC_TERMINAL_SOCKET ?? "").trim() || null;
  let effectiveShellPid = shellPid;
  let alive = d.pidAlive;
  if (d.platform === "win32") {
    // named pipe names are case-insensitive (the spelling changed across a reboot): the note's spelling is used when only the case differs
    if (socket && note?.socket && socket.toLowerCase() === note.socket.toLowerCase()) socket = note.socket;
    // Git Bash: hc's root program is the bin\bash.exe launcher, the shell its child usr\bin\bash.exe
    if (hc !== "error" && hc.pid !== shellPid && isGitBashLauncherChild(hc.pid, (d.procParent ?? realProcParent)(shellPid))) effectiveShellPid = hc.pid;
    // a pid that the system handed out again: its process started after the session did
    const startOf = d.procStartMs ?? realProcStartMs;
    alive = (pid) => {
      if (!d.pidAlive(pid)) return false;
      const started = note ? readLiveStartedMs(agentDir, note.sessionId) : null;
      const began = started === null ? null : startOf(pid);
      return !(began !== null && started !== null && began > started + 2000);
    };
  }
  const decision: Decision = decideResume({ setting, note: check, tty, hc, socket, shellPid: effectiveShellPid, live, pidAlive: alive, now, bootMs: now - d.uptimeS() * 1000, cwdIsDir, lock: () => (note ? takeLock(agentDir, note.sessionId, now) : false) });
  if (decision.action === "keep") return decision.recheck ? RECHECK_EXIT : 0;
  if (decision.action === "clear") {
    deleteNote(agentDir, terminal);
    if (decision.print === "custom_dir" && check.ok === false && check.sessionFile) d.out(`pi-foreman: not restarted (custom session dir); resume by hand: pi --session ${clean(check.sessionFile, 400)}`);
    else if (decision.print === "hand" && note) d.out(handLine(readSessionFile(note.sessionFile, note.sessionId, agentDir).name, note.sessionId));
    return 0;
  }
  if (!note) return 0;
  const session = readSessionFile(note.sessionFile, note.sessionId, agentDir);
  for (const key of session.dropped) d.out(`pi-foreman: launch key ${clean(key)} is not valid any more and is not restored`);
  d.out(`pi-foreman: Pi session "${clean(session.name ?? note.sessionId)}" ran here before a crash. Restarting in ${Math.round(d.countdownMs / 1000)} s (Enter: now, any other key: cancel).`);
  const key = await countdown(d.stdin, d.countdownMs);
  if (key === "cancel") {
    deleteNote(agentDir, terminal);
    dropLock(agentDir, note.sessionId);
    d.out(`pi-foreman: not restarted. Resume by hand: pi --session ${note.sessionId}`);
    return 0;
  }
  const launch: LaunchKeys | null = session.identity;
  return runPi(d, note, buildSpawnEnv(d.env, launch, live?.heartbeatMs ?? now, d.platform));
}

const entry = process.argv[1];
if (entry) {
  let self = false;
  try {
    self = pathToFileURL(fs.realpathSync(entry)).href === import.meta.url;
  } catch {
    self = false;
  }
  if (self) process.exit(await runPaneResume(process.argv.slice(2)));
}
