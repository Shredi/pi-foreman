// Adapter side of the crash restart of a Pi session in its pane (design: paneresume-core.ts; the shell hook runs `foreman pane-resume`).
//
//  - pane note: at every tui start in a kept terminal (live record `hcTerminal`) the note `state/panes/<terminal>.json` is written; a normal quit
//    (`session_shutdown` reason `quit`, no SIGHUP/SIGTERM before it) deletes it; notes of sessions idle for 14 days are swept at each start.
//  - signal flag: a SIGHUP/SIGTERM that Pi handles keeps the note and ends the live record with `endedBy: "signal"`.
//  - 10 s after the start: the restart message (when the command restarted this session) and the child runs and bg tasks that a boot left running.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readAllOwnAddonTasks } from "./bg.ts";
import type { AddonTask } from "./bg.ts";
import { NOTE_MAX_AGE_MS, SESSION_ID_RE, TERMINAL_RE, deleteNote, hcGet, notePath, panesDir, pidAlive, readLiveRecord, readNoteRaw, writeNote } from "./paneresume-core.ts";

type Env = Record<string, string | undefined>;
type Signal = "SIGHUP" | "SIGTERM";
const SIGNALS: Signal[] = ["SIGHUP", "SIGTERM"];

export const HC_GET_TIMEOUT_MS = 10_000;
export const SCAN_DELAY_MS = 10_000;
export const RESTART_MESSAGE_TYPE = "pi-foreman-restart";

/**
 * The signal state of the process. Pi loads this module fresh on every /reload, so the install guard, the listener functions and the flag live in
 * one process-global slot (as selfwarm.ts and owned.ts do for theirs): a later module instance finds the installed listeners and adds none, and
 * `session_shutdown` in a newer instance reads the same flag.
 *
 * `persistent` is the set of SIGHUP/SIGTERM listeners present when this module is first loaded in the process. Pi (installed 0.x, checked against
 * dist/main.js and dist/modes/interactive/interactive-mode.js) loads extensions in createAgentSessionServices(), before createAgentSessionRuntime()
 * and before `InteractiveMode.init()` registers its own handlers with `process.prependListener` (registerSignalHandlers), so at this point the
 * listeners are the ones that stay for the whole process (signal-exit's, loaded through Pi's settings manager), not Pi's. Later, a listener that is
 * neither ours nor in `persistent` is Pi's (also one Pi registers again later with a new function): Pi handles the signal and ends with
 * `session_shutdown` (reason `quit`) before it exits.
 */
interface Slot {
  installed: boolean;
  ours: Partial<Record<Signal, () => void>>;
  persistent: Record<Signal, Function[]>;
  signalled: boolean;
}
const SLOT = Symbol.for("pi-foreman.paneresume");
const slot = (): Slot => {
  const g = globalThis as unknown as Record<symbol, Slot | undefined>;
  return (g[SLOT] ??= { installed: false, ours: {}, persistent: { SIGHUP: process.listeners("SIGHUP"), SIGTERM: process.listeners("SIGTERM") }, signalled: false });
};
slot(); // at module load: record `persistent` before Pi's init() runs

/** `LiveInit.endedBy`: "signal" once a signal that Pi handles has arrived. */
export const signalEnded = (): "signal" | undefined => (slot().signalled ? "signal" : undefined);

function onSignal(sig: Signal): void {
  const s = slot();
  const own = s.ours[sig];
  const others = process.listeners(sig).filter((l) => l !== own && !s.persistent[sig].includes(l));
  if (others.length > 0) {
    s.signalled = true; // Pi handles it: dispose, session_shutdown, exit
    return;
  }
  // Pi removed its handlers (a normal quit is in progress) and the signal is for the process: leave signal-exit alone again so it ends a hanging quit
  for (const g of SIGNALS) {
    const fn = s.ours[g];
    if (fn) process.off(g, fn);
  }
  s.ours = {};
  s.installed = false;
  process.kill(process.pid, sig);
}

/** Once per process (the guard is in the slot, so a fresh module instance after /reload adds none). */
function installSignalListeners(): void {
  const s = slot();
  if (s.installed) return;
  s.installed = true;
  for (const sig of SIGNALS) {
    const fn = (): void => onSignal(sig);
    s.ours[sig] = fn;
    process.on(sig, fn);
  }
}

/** Notes whose session's live heartbeat (else the note's `writtenAt`, else the file's mtime) is older than 14 days are deleted. */
export function sweepNotes(agentDir: string, now: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(panesDir(agentDir));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(panesDir(agentDir), name);
    let last: number | null = null;
    try {
      const d = JSON.parse(fs.readFileSync(file, "utf8")) as { sessionId?: unknown; writtenAt?: unknown };
      const id = typeof d.sessionId === "string" ? d.sessionId : "";
      last = (SESSION_ID_RE.test(id) ? readLiveRecord(agentDir, id)?.heartbeatMs : null) ?? (typeof d.writtenAt === "number" ? d.writtenAt : null);
    } catch {
      // unreadable: judged by the file's age below
    }
    try {
      last ??= fs.statSync(file).mtimeMs;
      if (now - last > NOTE_MAX_AGE_MS) fs.unlinkSync(file);
    } catch {
      // gone meanwhile
    }
  }
}

/** A running bg task that is not running any more: it started before this boot (`ageSeconds` > uptime) or its own pid is gone; without a pid, by age alone. */
export function taskEndedCheck(uptimeS: () => number = () => os.uptime(), alive: (pid: number) => boolean = pidAlive): (task: AddonTask) => boolean {
  return (t) => t.ageSeconds > uptimeS() || (typeof t.pid === "number" && !alive(t.pid));
}

/** The session's dead bg tasks: `readAllOwnAddonTasks` output (uncapped) filtered by `taskEndedCheck`. */
export function deadTasks(cwd: string, sessionId: string, ended: (task: AddonTask) => boolean = taskEndedCheck()): AddonTask[] {
  try {
    return readAllOwnAddonTasks(cwd, sessionId).filter(ended);
  } catch {
    return [];
  }
}

/** pi-subagents' scope id (`resolveTempScopeId`, src/shared/types.js): a test pins this copy against the package. */
export function subagentsScopeId(env: Env = process.env): string {
  if (typeof process.getuid === "function") return `uid-${process.getuid()}`;
  const seg = (v: string): string => v.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
  for (const k of ["USERNAME", "USER", "LOGNAME"]) if (env[k]) return `user-${seg(env[k] as string)}`;
  try {
    const u = os.userInfo().username;
    if (u) return `user-${seg(u)}`;
  } catch {
    // fall through to the home directory
  }
  const home = env.USERPROFILE ?? env.HOME;
  return home ? `home-${seg(home)}` : "shared";
}

/** The folder of pi-subagents' async run directories (`PI_SUBAGENTS_TEMP_ROOT`, else `<tmp>/pi-subagents-<scope>`), mirrored from the package (its resolver is not exported). */
export function subagentsRunsDir(env: Env = process.env, tmp: string = os.tmpdir()): string {
  const root = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  return path.join(root ? path.resolve(root) : path.join(tmp, `pi-subagents-${subagentsScopeId(env)}`), "async-subagent-runs");
}

export interface DeadRun {
  id: string;
  agent: string | null;
}

/**
 * This session's pi-subagents runs still `queued` or `running` whose start predates this boot (a run the package keeps because its pid is
 * unknown), and whether any status file of the session exists at all. Runs the package failed meanwhile read `failed` and are skipped.
 */
export function readDeadRuns(runsDir: string, sessionFile: string | undefined, sessionId: string, bootMs: number): { dead: DeadRun[]; found: number } {
  const dead: DeadRun[] = [];
  let found = 0;
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(runsDir);
  } catch {
    return { dead, found };
  }
  for (const id of ids) {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(runsDir, id, "status.json"), "utf8")) as { sessionId?: unknown; state?: unknown; startedAt?: unknown; steps?: { agent?: unknown }[] };
      if (st.sessionId !== sessionId && (sessionFile === undefined || st.sessionId !== sessionFile)) continue;
      found++;
      if ((st.state === "running" || st.state === "queued") && typeof st.startedAt === "number" && st.startedAt < bootMs) {
        const agent = typeof st.steps?.[0]?.agent === "string" ? (st.steps[0].agent as string) : null;
        dead.push({ id: id.slice(0, 40), agent: agent && agent.slice(0, 40) });
      }
    } catch {
      // a status being rewritten or foreign: skip
    }
  }
  return { dead, found };
}

/** Whether the session file holds a `subagent` tool call whose `async` argument is not `false` (pi-subagents runs async by default). */
export function launchedAsyncRuns(sessionFile: string | undefined): boolean {
  if (!sessionFile) return false;
  let text: string;
  try {
    text = fs.readFileSync(sessionFile, "utf8");
  } catch {
    return false;
  }
  for (const line of text.split("\n")) {
    if (!line.includes("subagent")) continue;
    try {
      const e = JSON.parse(line) as { message?: { content?: unknown } };
      const content = e.message?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content as { type?: unknown; name?: unknown; arguments?: { async?: unknown } }[]) {
        if (c && c.type === "toolCall" && c.name === "subagent" && c.arguments?.async !== false) return true;
      }
    } catch {
      // not JSON
    }
  }
  return false;
}

export interface PaneResumeInit {
  agentDir: string;
  sessionId: string;
  sessionFile: string | undefined;
  cwd: string;
  mode: string | undefined;
  platform: string;
  env: Env;
  /** Start reason of this session_start. */
  reason: string;
  /** The live record's `hcTerminal`. */
  hcTerminal: string | null;
  /** `sessions.hc.resume` of the merged config. */
  setting: string;
  /** The live record's heartbeat before this start overwrote it (a start without `PI_FOREMAN_RESUMED`), or null. */
  prevHeartbeatMs?: number | null;
  /** The restart message and the notice: a custom message that starts no turn. */
  send: (text: string) => void;
  trace: (r: Record<string, unknown>) => void;
  hcGet?: typeof hcGet;
  now?: () => number;
  uptimeS?: () => number;
  delayMs?: number;
  pidAlive?: (pid: number) => boolean;
  runsDir?: string;
}

const clock = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export class PaneResume {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly now: () => number;
  private readonly uptimeS: () => number;
  private readonly resumedMs: number | null;

  /** Null outside a tui session on a POSIX host. Reads and removes `PI_FOREMAN_RESUMED` from the env (children never inherit it). */
  static start(init: PaneResumeInit): PaneResume | null {
    const raw = init.env.PI_FOREMAN_RESUMED;
    delete init.env.PI_FOREMAN_RESUMED;
    if (init.mode !== "tui" || init.platform === "win32" || init.env.PI_SUBAGENT_CHILD === "1") return null;
    const p = new PaneResume(init, raw !== undefined && /^\d{1,16}$/.test(raw.trim()) ? Number(raw.trim()) : null);
    p.begin();
    return p;
  }

  private readonly i: PaneResumeInit;

  private constructor(i: PaneResumeInit, resumedMs: number | null) {
    this.i = i;
    this.now = i.now ?? (() => Date.now());
    this.uptimeS = i.uptimeS ?? (() => os.uptime());
    this.resumedMs = resumedMs;
  }

  private begin(): void {
    const i = this.i;
    sweepNotes(i.agentDir, this.now());
    const terminal = i.hcTerminal && TERMINAL_RE.test(i.hcTerminal) ? i.hcTerminal : null;
    if (terminal) {
      if (i.setting === "off") deleteNote(i.agentDir, terminal);
      else {
        installSignalListeners();
        void this.writeNote(terminal);
      }
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scan();
    }, i.delayMs ?? SCAN_DELAY_MS);
    this.timer.unref?.();
  }

  private async writeNote(terminal: string): Promise<void> {
    const i = this.i;
    try {
      if (!i.sessionFile) return i.trace({ event: "pane_note_skipped", reason: "no_session_file" });
      const hc = await (i.hcGet ?? hcGet)(terminal, HC_GET_TIMEOUT_MS, i.env);
      if (this.stopped) return;
      if (hc === "error" || hc.createdMs === null) return i.trace({ event: "pane_note_skipped", reason: hc === "error" ? "hc_get_failed" : "no_created_ms" });
      writeNote(i.agentDir, { v: 1, sessionId: i.sessionId, sessionFile: i.sessionFile, cwd: i.cwd, terminal, socket: i.env.HC_TERMINAL_SOCKET?.trim() || null, createdMs: hc.createdMs, rootPid: hc.pid, writtenAt: this.now() });
    } catch (err) {
      i.trace({ event: "pane_note_skipped", reason: "write_failed", error: String((err as Error).message).slice(0, 200) });
    }
  }

  /** session_shutdown: both timers go for every reason; only a normal quit deletes this session's note. */
  stop(reason: string | undefined): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const i = this.i;
    const terminal = i.hcTerminal && TERMINAL_RE.test(i.hcTerminal) ? i.hcTerminal : null;
    if (reason !== "quit" || !terminal || slot().signalled) return;
    const raw = readNoteRaw(i.agentDir, terminal) as { sessionId?: unknown } | null | undefined;
    if (raw && typeof raw === "object" && raw.sessionId === i.sessionId) deleteNote(i.agentDir, terminal);
  }

  /** The message text for the child runs and bg tasks a boot left behind, or null when there is nothing to say. */
  private gone(): string[] {
    const i = this.i;
    const lines: string[] = [];
    const bootMs = this.now() - this.uptimeS() * 1000;
    const prev = this.resumedMs ?? i.prevHeartbeatMs ?? null;
    if (i.reason === "startup" || i.reason === "resume") {
      const { dead, found } = readDeadRuns(i.runsDir ?? subagentsRunsDir(i.env), i.sessionFile, i.sessionId, bootMs);
      if (dead.length) lines.push(`Child runs that a restart of the machine left unfinished (pi-subagents still lists them as running): ${dead.map((r) => (r.agent ? `${r.agent} ${r.id}` : r.id)).join(", ")}.`);
      else if (found === 0 && prev !== null && prev < bootMs && launchedAsyncRuns(i.sessionFile)) lines.push("Child runs from before the reboot cannot be listed: their records were cleared; check the ledger for runs still needed.");
      const tasks = deadTasks(i.cwd, i.sessionId, taskEndedCheck(this.uptimeS, i.pidAlive ?? pidAlive));
      if (tasks.length) lines.push(`Background tasks that are no longer running: ${tasks.map((t) => `${t.id}${t.label ? ` (${t.label})` : ""}`).join(", ")}.`);
    }
    return lines;
  }

  private scan(): void {
    const i = this.i;
    try {
      const lines = this.gone();
      if (this.resumedMs === null && lines.length === 0) return;
      const head = this.resumedMs === null ? "pi-foreman notice:" : `pi-foreman: this session was restarted after a crash (last sign of life ${clock(this.resumedMs)}).`;
      const tail = this.resumedMs === null ? "" : " Waits (foreman_wait) are lost; relaunch what is still needed.";
      i.send([head, ...lines].join(" ") + tail);
    } catch (err) {
      i.trace({ event: "pane_message_failed", error: String((err as Error).message).slice(0, 200) });
    }
  }
}

export { notePath };
