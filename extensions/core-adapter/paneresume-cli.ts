// `foreman pane-resume --shell-pid <pid>` (bin/foreman): run by the shell hook at a prompt when a pane note exists for the terminal. It decides
// (paneresume-core.ts `decideResume`) whether Pi ran in this pane and crashed, and if so restarts the session after a countdown. This module
// tree imports only `node:*` and pi-foreman modules without a Pi package: never livestate.ts, bg.ts or paneresume.ts.
import * as fs from "node:fs";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { piAgentDir } from "./env.ts";
import { COUNTDOWN_MS, HC_GET_TIMEOUT_MS, TERMINAL_RE, buildSpawnEnv, decideResume, deleteNote, dropLock, hcGet, pidAlive, readLiveRecord, readNoteRaw, readResumeSetting, readSessionFile, takeLock, validateNote } from "./paneresume-core.ts";
import type { Decision, LaunchKeys, PaneNote } from "./paneresume-core.ts";

export const USAGE = "usage: foreman pane-resume --shell-pid <pid>";

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
    spawnPi: (args, o) => spawn("pi", args, { cwd: o.cwd, env: o.env, stdio: "inherit" }),
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

/** The command: 0 on every outcome the hook should ignore, Pi's exit code after a restart, 2 on a usage error. */
export async function runPaneResume(argv: string[], over: Partial<PaneResumeDeps> = {}): Promise<number> {
  const d = { ...defaults(), ...over };
  if (d.platform === "win32") {
    d.out("foreman pane-resume: not supported on Windows");
    return 0;
  }
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
  const check = validateNote(raw, agentDir, terminal);
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
  const decision: Decision = decideResume({ setting, note: check, tty, hc, socket: (d.env.HC_TERMINAL_SOCKET ?? "").trim() || null, shellPid, live, pidAlive: d.pidAlive, now, bootMs: now - d.uptimeS() * 1000, cwdIsDir, lock: () => (note ? takeLock(agentDir, note.sessionId, now) : false) });
  if (decision.action === "keep") return 0;
  if (decision.action === "clear") {
    deleteNote(agentDir, terminal);
    if (decision.print === "custom_dir" && check.ok === false && check.sessionFile) d.out(`pi-foreman: not restarted (custom session dir); resume by hand: pi --session ${clean(check.sessionFile, 400)}`);
    else if (decision.print === "hand" && note) d.out(handLine(readSessionFile(note.sessionFile, note.sessionId, agentDir).name, note.sessionId));
    return 0;
  }
  if (!note) return 0;
  const session = readSessionFile(note.sessionFile, note.sessionId, agentDir);
  d.out(`pi-foreman: Pi session "${clean(session.name ?? note.sessionId)}" ran here before a crash. Restarting in ${Math.round(d.countdownMs / 1000)} s (Enter: now, any other key: cancel).`);
  const key = await countdown(d.stdin, d.countdownMs);
  if (key === "cancel") {
    deleteNote(agentDir, terminal);
    dropLock(agentDir, note.sessionId);
    d.out(`pi-foreman: not restarted. Resume by hand: pi --session ${note.sessionId}`);
    return 0;
  }
  const launch: LaunchKeys | null = session.identity;
  return runPi(d, note, buildSpawnEnv(d.env, launch, live?.heartbeatMs ?? now));
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
