// Crash restart of a Pi session in its pane: what the adapter (paneresume.ts) and the shell hook's command (`foreman pane-resume`,
// paneresume-cli.ts) share. Imports only `node:*`: the CLI runs from a managed install where the Pi package is not on the import path,
// so this module never imports a Pi package, livestate.ts or bg.ts (a test walks the import graph).
//
// The pane note `<agent dir>/pi-foreman/state/panes/<terminal>.json` says which session ran in a kept terminal. The adapter writes it at
// every tui start and deletes it on a normal quit. After a crash the terminal app recovers the pane with a login shell; the shell's
// first prompt runs `foreman pane-resume`, which reads the note and the session's live record and decides (`decideResume`).
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

export const HEARTBEAT_MS = 30_000;
/** A live file whose heartbeat is older than this is a dead or frozen session (three heartbeats). */
export const LIVE_DEAD_MS = 3 * HEARTBEAT_MS;
export const NOTE_MAX_AGE_MS = 14 * 24 * 3_600_000;
export const LOCK_STALE_MS = 2 * 60_000;
export const COUNTDOWN_MS = 5000;
export const HC_GET_TIMEOUT_MS = 3000;

export const IDENTITY_ENTRY_TYPE = "pi-foreman-identity";
export const TERMINAL_RE = /^[a-z0-9_-]{1,32}$/;
/** The session id names the lock file, so it must be a plain token. */
export const SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
/** Copies of `BG_NAME_RE` / `BG_VALUE_RE` in scripts/foreman_session.py (a test pins them equal). */
export const BG_NAME_RE = /^PI_BG_[A-Z0-9_]{1,60}$/;
export const BG_VALUE_RE = /^[A-Za-z0-9._:/@,=+ -]{0,200}$/;

type Env = Record<string, string | undefined>;

export const liveDir = (agentDir: string): string => path.join(agentDir, "pi-foreman", "state", "live");
export const panesDir = (agentDir: string): string => path.join(agentDir, "pi-foreman", "state", "panes");
export const notePath = (agentDir: string, terminal: string): string => path.join(panesDir(agentDir), `${terminal}.json`);

export interface PaneNote {
  v: 1;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  terminal: string;
  socket: string | null;
  createdMs: number;
  rootPid: number;
  writtenAt: number;
}

/** Atomic (temp file, then rename); throws on a write error. */
export function writeNote(agentDir: string, note: PaneNote): void {
  const file = notePath(agentDir, note.terminal);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(note)}\n`, "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing to clean
    }
    throw err;
  }
}

/** The parsed note file: undefined when there is none, null when it is unreadable or not JSON. */
export function readNoteRaw(agentDir: string, terminal: string): unknown | null | undefined {
  let text: string;
  try {
    text = fs.readFileSync(notePath(agentDir, terminal), "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function deleteNote(agentDir: string, terminal: string): void {
  try {
    fs.unlinkSync(notePath(agentDir, terminal));
  } catch {
    // already gone
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The header id of a session file (first line `{"type":"session","id":...}`), or null. */
export function sessionHeaderId(file: string): string | null {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const first = buf.subarray(0, n).toString("utf8").split(/\r?\n/, 1)[0];
      const h = JSON.parse(first) as { type?: unknown; id?: unknown };
      return h.type === "session" ? str(h.id) : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export type NoteCheck = { ok: true; note: PaneNote } | { ok: false; reason: string; customDir?: true; sessionId?: string; sessionFile?: string };

/**
 * A note as read from disk, field by field, before any check of the decision: the session id is a plain token (it names the lock file),
 * `terminal` is the hook's terminal, `cwd` is absolute, and the session file is an absolute `.jsonl` under `<agent dir>/sessions` that
 * exists and whose header id is the note's session id. A file elsewhere (Pi's --session-dir) is `customDir`: it is not restarted.
 * On win32 the session folder prefix is compared without regard to case (drive letter and folder case).
 */
export function validateNote(raw: unknown, agentDir: string, terminal: string, platform: string = process.platform): NoteCheck {
  const d = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!d || d.v !== 1) return { ok: false, reason: "note_unreadable" };
  const sessionId = str(d.sessionId);
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return { ok: false, reason: "session_id_invalid" };
  if (d.terminal !== terminal) return { ok: false, reason: "terminal_mismatch" };
  const cwd = str(d.cwd);
  if (!cwd || !path.isAbsolute(cwd)) return { ok: false, reason: "cwd_not_absolute" };
  const sessionFile = str(d.sessionFile);
  if (!sessionFile || !path.isAbsolute(sessionFile) || !sessionFile.endsWith(".jsonl")) return { ok: false, reason: "session_file_invalid" };
  const sessions = path.resolve(agentDir, "sessions");
  const resolved = path.resolve(sessionFile);
  const prefix = sessions + path.sep;
  if (!(platform === "win32" ? resolved.toLowerCase().startsWith(prefix.toLowerCase()) : resolved.startsWith(prefix))) return { ok: false, reason: "custom_session_dir", customDir: true, sessionId, sessionFile: resolved };
  if (sessionHeaderId(resolved) !== sessionId) return { ok: false, reason: "session_file_mismatch", sessionId };
  const createdMs = num(d.createdMs);
  const rootPid = num(d.rootPid);
  const writtenAt = num(d.writtenAt);
  if (createdMs === null || rootPid === null || writtenAt === null) return { ok: false, reason: "note_fields_invalid" };
  const socket = d.socket === null || d.socket === undefined ? null : str(d.socket);
  if (d.socket !== null && d.socket !== undefined && socket === null) return { ok: false, reason: "note_fields_invalid" };
  return { ok: true, note: { v: 1, sessionId, sessionFile: resolved, cwd, terminal, socket, createdMs, rootPid, writtenAt } };
}

/** The fields of a session's live record that the decision reads. */
export interface LiveRecord {
  state: string;
  endedBy: string | null;
  hcTerminal: string | null;
  pid: number | null;
  heartbeatMs: number | null;
  cwd: string | null;
}

/** The live record of a session id (a plain token: it names the file), or null when it is missing, unreadable or the id is not a token. */
export function readLiveRecord(agentDir: string, sessionId: string): LiveRecord | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(liveDir(agentDir), `${sessionId}.json`), "utf8")) as Record<string, unknown>;
    if (!d || typeof d !== "object") return null;
    const hb = typeof d.heartbeatAt === "string" ? Date.parse(d.heartbeatAt) : NaN;
    return { state: typeof d.state === "string" ? d.state : "", endedBy: str(d.endedBy), hcTerminal: str(d.hcTerminal), pid: num(d.pid), heartbeatMs: Number.isFinite(hb) ? hb : null, cwd: str(d.cwd) };
  } catch {
    return null;
  }
}

/** The live record's `startedAt` in ms (a plain-token id), or null when it is missing or unreadable. */
export function readLiveStartedMs(agentDir: string, sessionId: string): number | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(liveDir(agentDir), `${sessionId}.json`), "utf8")) as Record<string, unknown>;
    const ms = d && typeof d.startedAt === "string" ? Date.parse(d.startedAt) : NaN;
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** The launch keys the identity entry carries beyond the opened-session ones (identity.ts), validated. */
export interface LaunchKeys {
  planPhase?: "1";
  bgEnv?: Record<string, string>;
}

export interface SessionRead {
  name: string | null;
  identity: LaunchKeys | null;
  dropped: string[];
}

/**
 * The newest session name and the newest identity entry that names `sessionId` in a session file; the launch keys of that entry are
 * validated one by one, an invalid one is dropped and listed in `dropped`.
 */
export function readSessionFile(file: string, sessionId: string, agentDir: string): SessionRead {
  let name: string | null = null;
  let entry: Record<string, unknown> | null = null;
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { name: null, identity: null, dropped: [] };
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: unknown; name?: unknown; customType?: unknown; data?: unknown };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "session_info") name = str(e.name) ?? name;
    else if (e.type === "custom" && e.customType === IDENTITY_ENTRY_TYPE && e.data && typeof e.data === "object") {
      const data = e.data as Record<string, unknown>;
      if (data.v === 1 && data.piSessionId === sessionId) entry = data;
    }
  }
  if (!entry) return { name, identity: null, dropped: [] };
  const identity: LaunchKeys = {};
  const dropped: string[] = [];
  // an older entry may carry a `permsProfile`: profiles are gone, the key is ignored
  if (entry.planPhase !== undefined) {
    if (entry.planPhase === "1") identity.planPhase = "1";
    else dropped.push("planPhase");
  }
  if (entry.bgEnv !== undefined) {
    const bg: Record<string, string> = {};
    const o = entry.bgEnv && typeof entry.bgEnv === "object" && !Array.isArray(entry.bgEnv) ? (entry.bgEnv as Record<string, unknown>) : null;
    if (!o) dropped.push("bgEnv");
    else {
      for (const [k, v] of Object.entries(o)) {
        if (BG_NAME_RE.test(k) && typeof v === "string" && BG_VALUE_RE.test(v)) bg[k] = v;
        else dropped.push(`bgEnv.${BG_NAME_RE.test(k) ? k : "name"}`);
      }
      if (Object.keys(bg).length) identity.bgEnv = bg;
    }
  }
  return { name: name ?? str(entry.sessionName), identity, dropped };
}

/** Variables of an opened session's launch that a recovered shell's env (the core's env) must not hand to the restarted Pi. */
const OPENED_KEYS = ["PI_FOREMAN_HANDOFF_DIR", "PI_FOREMAN_REMOTE_PARENT", "PI_FOREMAN_SESSION_MODEL", "PI_FOREMAN_PLAN_PHASE", "PI_FOREMAN_RESUMED"];
const OPENED_PREFIXES = ["PI_INTERCOM_", "PI_FOREMAN_PARENT_"];

/**
 * The env of the restarted Pi: the shell's env without the opened-session keys, then the identity entry's plan phase, and its
 * `PI_BG_*` only when it supplies them (a plain session keeps the shell's). `PI_FOREMAN_RESUMED` is the last heartbeat in ms.
 * On win32 the shell's own `PI_BG_SHELL` and `PI_BG_SHELL_PATH` stay when `PI_BG_*` is replaced (the identity never carries them there).
 */
export function buildSpawnEnv(base: Env, launch: LaunchKeys | null, heartbeatMs: number, platform: string = process.platform): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || OPENED_KEYS.includes(k) || OPENED_PREFIXES.some((p) => k.startsWith(p))) continue;
    env[k] = v;
  }
  if (launch?.planPhase) env.PI_FOREMAN_PLAN_PHASE = launch.planPhase;
  if (launch?.bgEnv) {
    for (const k of Object.keys(env)) if (k.startsWith("PI_BG_") && !(platform === "win32" && (k === "PI_BG_SHELL" || k === "PI_BG_SHELL_PATH"))) delete env[k];
    Object.assign(env, launch.bgEnv);
  }
  env.PI_FOREMAN_RESUMED = String(Math.round(heartbeatMs));
  return env;
}

export type Action = "resume" | "clear" | "keep";
export interface Decision {
  action: Action;
  reason: string;
  /** What a `clear` prints: the hand-resume line, or the custom-session-dir line. */
  print?: "hand" | "custom_dir";
  /** A `keep` the hook should decide again at the next prompt: Pi wrote `done` after a signal but is still draining input. */
  recheck?: boolean;
}

export interface ResumeInputs {
  /** `sessions.hc.resume` */
  setting: string;
  note: NoteCheck;
  tty: boolean;
  /** `hc get`: an error (not reachable, not JSON, no usable pid), or the terminal's `created_ms` and root program `pid`. */
  hc: "error" | { createdMs: number | null; pid: number };
  /** `HC_TERMINAL_SOCKET` of the hook's shell. */
  socket: string | null;
  shellPid: number;
  live: LiveRecord | null;
  pidAlive: (pid: number) => boolean;
  now: number;
  /** Start of the current boot (ms). */
  bootMs: number;
  cwdIsDir: boolean;
  /** Takes the session's lock; called only when every earlier row passed. */
  lock: () => boolean;
}

const clear = (reason: string, print?: Decision["print"]): Decision => ({ action: "clear", reason, ...(print ? { print } : {}) });
const keep = (reason: string): Decision => ({ action: "keep", reason });

/** The ten checks of the plan, in order; the first that fails decides. */
export function decideResume(i: ResumeInputs): Decision {
  if (i.note.ok === false) return clear(i.note.reason, i.note.customDir ? "custom_dir" : undefined);
  const note = i.note.note;
  if (i.setting === "off") return clear("setting_off"); // 1
  if (!i.tty) return keep("no_tty"); // 2
  if (i.hc === "error") return keep("hc_error"); // 3
  if (i.hc.createdMs !== note.createdMs || (i.socket ?? null) !== (note.socket ?? null)) return clear("terminal_reused");
  if (i.hc.pid !== i.shellPid) return keep("nested_shell"); // 4
  const live = i.live;
  if (!live) return clear("live_missing", "hand"); // 5
  if (live.hcTerminal !== note.terminal) return clear("live_other_terminal");
  if (live.state === "done" && live.endedBy !== "signal") return clear("normal_end"); // 6
  const beforeBoot = live.heartbeatMs === null || live.heartbeatMs < i.bootMs;
  const piGone = beforeBoot || live.pid === null || !i.pidAlive(live.pid);
  if (!piGone) return live.state === "done" ? { ...keep("pi_alive"), recheck: true } : keep("pi_alive"); // 7
  if (!beforeBoot && i.hc.pid === note.rootPid) return clear("lone_crash", "hand"); // 8
  if (live.heartbeatMs === null || i.now - live.heartbeatMs > NOTE_MAX_AGE_MS || !i.cwdIsDir) return clear("too_old_or_no_cwd", "hand"); // 9
  if (!i.lock()) return keep("locked"); // 10
  return { action: "resume", reason: "crash" };
}

/** `process.kill(pid, 0)`: EPERM means the process exists. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `hc get <terminal> --json`, without a shell; "error" on a failure, a timeout, or a reply without a usable pid. */
export function hcGet(terminal: string, timeoutMs: number, env: Env = process.env): Promise<"error" | { createdMs: number | null; pid: number }> {
  return new Promise((resolve) => {
    let done = false;
    const out: Buffer[] = [];
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (r: "error" | { createdMs: number | null; pid: number }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child?.kill();
      finish("error");
    }, timeoutMs);
    try {
      child = spawn(env.HC_BIN?.trim() || "hc", ["get", terminal, "--json"], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env: env as NodeJS.ProcessEnv });
    } catch {
      finish("error");
      return;
    }
    child.stdout?.on("data", (c: Buffer) => {
      if (out.reduce((n, b) => n + b.length, 0) < 1_000_000) out.push(c);
    });
    child.on("error", () => finish("error"));
    child.on("close", (code) => {
      if (code !== 0) return finish("error");
      try {
        const o = JSON.parse(Buffer.concat(out).toString("utf8")) as Record<string, unknown>;
        const pid = num(o.pid);
        finish(pid === null ? "error" : { createdMs: num(o.created_ms), pid });
      } catch {
        finish("error");
      }
    });
  });
}

/**
 * `sessions.hc.resume` from the user layers (L3 packages' config first, then `<agent dir>/foreman.json`, last wins; the project and session
 * layers cannot set it). Anything unreadable or not "off" reads as "auto".
 */
export function readResumeSetting(agentDir: string): "auto" | "off" {
  let value: unknown = "auto";
  const pick = (file: string): void => {
    try {
      const d = JSON.parse(fs.readFileSync(file, "utf8")) as { sessions?: { hc?: { resume?: unknown } } };
      const v = d?.sessions?.hc?.resume;
      if (v === "auto" || v === "off") value = v;
    } catch {
      // unreadable: the layer says nothing
    }
  };
  const nm = path.join(agentDir, "npm", "node_modules");
  let dirs: string[] = [];
  try {
    for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith("@")) {
        for (const s of fs.readdirSync(path.join(nm, e.name), { withFileTypes: true })) if (s.isDirectory()) dirs.push(path.join(nm, e.name, s.name));
      } else dirs.push(path.join(nm, e.name));
    }
  } catch {
    dirs = [];
  }
  for (const d of dirs.sort()) {
    try {
      const rel = (JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8")) as { pi?: { foreman?: { config?: unknown } } }).pi?.foreman?.config;
      if (typeof rel === "string") pick(path.join(d, rel));
    } catch {
      // not an overlay package
    }
  }
  pick(path.join(agentDir, "foreman.json"));
  return value === "off" ? "off" : "auto";
}

/** The session's lock `state/panes/<id>.lock`, created exclusively; one older than LOCK_STALE_MS is replaced. False when another run holds it. */
export function takeLock(agentDir: string, sessionId: string, now = Date.now()): boolean {
  if (!SESSION_ID_RE.test(sessionId)) return false;
  const file = path.join(panesDir(agentDir), `${sessionId}.lock`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.closeSync(fs.openSync(file, "wx"));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
      try {
        if (now - fs.statSync(file).mtimeMs <= LOCK_STALE_MS) return false;
        fs.unlinkSync(file);
      } catch {
        // gone meanwhile: try again
      }
    }
  }
  return false;
}

export function dropLock(agentDir: string, sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) return;
  try {
    fs.unlinkSync(path.join(panesDir(agentDir), `${sessionId}.lock`));
  } catch {
    // already gone
  }
}
