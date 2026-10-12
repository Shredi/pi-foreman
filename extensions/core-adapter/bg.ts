// `foreman_bg` (ledger item 5) and the optional background-tasks add-on (item 6).
//
// `foreman_bg {command, note}` runs one shell command detached (own process group, stdout and stderr to
// `<stateDir>/scratch/<session>/wait-<id>.log`) and registers a `pid` wait for it, so the foreman ends its turn and is
// woken when the process is gone. The call is guarded exactly like a foreground `bash` call with the same command:
// index.ts routes `foreman_bg` through the same tool_call guards (overlay, shell write guard, destructive and git guard)
// and the permission system maps it to its bash rules (`shellTools.foreman_bg` in config/permissions.baseline.json).
// This file only spawns; it never decides.
//
// The add-on package `pi-background-tasks` is never imported or required. It is detected by its tool `bg_run` (or its
// package directory); while present, `foreman_bg` refuses with a pointer to `bg_run`, and `/foreman waits` also lists
// its running tasks from `<cwd>/.pi/tasks/<session>-<pid>/<task-id>.json`.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** One line, control characters dropped, capped (same rule as wait.ts oneLine; kept here to avoid an import cycle). */
function oneLine(v: unknown, max: number): string {
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() : "";
  return s.length > max ? s.slice(0, max) : s;
}

export const BG_TOOL = "foreman_bg";
/** Tool name of the optional add-on that marks it present. */
export const ADDON_RUN_TOOL = "bg_run";
export const ADDON_PACKAGE = "pi-background-tasks";
export const LOG_TAIL_LINES = 5;
const TAIL_BYTES = 8192;
const MAX_ADDON_TASKS = 20;

export const BG_PARAMS = {
  type: "object",
  properties: {
    command: { type: "string", description: "The shell command to run detached (same guards as a bash call)." },
    note: { type: "string", maxLength: 200, description: "Shown in the sidebar, `/foreman waits` and the wake message." },
  },
  required: ["command"],
  additionalProperties: false,
};

/** Segment safe for a file name. */
export const safeSegment = (v: string): string => v.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "_";

/** `<stateDir>/scratch/<session>`: where foreman_bg logs live. */
export const bgScratchDir = (stateDir: string, sessionId: string): string => path.join(stateDir, "scratch", safeSegment(sessionId));
export const bgLogPath = (stateDir: string, sessionId: string, waitId: string): string => path.join(bgScratchDir(stateDir, sessionId), `wait-${safeSegment(waitId)}.log`);

/** The shell that runs the command: bash (else sh) on POSIX, `cmd /c` on Windows. */
export function shellFor(command: string, platform: string = process.platform): { file: string; args: string[]; verbatim: boolean } {
  if (platform === "win32") return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command], verbatim: true };
  return { file: fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh", args: ["-c", command], verbatim: false };
}

/** Spawn `command` detached with stdout and stderr appended to `logPath`; the pid, or why not. */
export function spawnDetached(command: string, cwd: string, logPath: string, platform: string = process.platform): { pid: number } | { error: string } {
  let fd: number | null = null;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    fd = fs.openSync(logPath, "a", 0o600);
    const sh = shellFor(command, platform);
    const child = spawn(sh.file, sh.args, { cwd, detached: true, stdio: ["ignore", fd, fd], env: process.env, windowsHide: true, windowsVerbatimArguments: sh.verbatim });
    child.on("error", () => undefined);
    child.unref();
    if (!child.pid) return { error: `${BG_TOOL}: could not start ${sh.file}.` };
    return { pid: child.pid };
  } catch (err) {
    return { error: `${BG_TOOL}: could not start the command (${oneLine((err as Error).message, 160)}).` };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Last `n` non-empty lines of a file (reads at most its final 8 KiB); [] when unreadable. */
export function lastLines(file: string, n: number = LOG_TAIL_LINES): string[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8").split(/\r?\n/).map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").trimEnd()).filter((l) => l.trim() !== "").slice(-n).map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l));
  } catch {
    return [];
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Whether the add-on is present: its tool is registered, or its package directory is installed. Never imports it. */
export function addonPresent(toolNames: readonly string[], dirs: { agentDir: string; cwd: string }): boolean {
  if (toolNames.includes(ADDON_RUN_TOOL)) return true;
  const candidates = [path.join(dirs.agentDir, "npm", "node_modules", ADDON_PACKAGE), path.join(dirs.cwd, ".pi", "npm", "node_modules", ADDON_PACKAGE)];
  return candidates.some((d) => fs.existsSync(path.join(d, "package.json")));
}

export interface AddonTask {
  id: string;
  label: string;
  pid?: number;
  ageSeconds: number;
  tail: string[];
}

/** Running add-on tasks (status running) of the records under `<cwd>/.pi/tasks/<session>-<pid>/`, newest first; unreadable records are skipped. */
export function readAddonTasks(cwd: string, now: number = Date.now()): AddonTask[] {
  const root = path.join(cwd, ".pi", "tasks");
  const out: (AddonTask & { start: number })[] = [];
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(root, dir, f), "utf8")) as Record<string, unknown>;
        if (rec.status !== "running" || typeof rec.id !== "string") continue;
        const start = typeof rec.startTime === "number" && Number.isFinite(rec.startTime) ? rec.startTime : now;
        const label = oneLine(rec.name ?? rec.description ?? rec.command, 80);
        // The log path comes from the record: read it only when it stays inside .pi/tasks.
        const outFile = typeof rec.outputPath === "string" ? path.resolve(cwd, rec.outputPath) : null;
        const inside = outFile !== null && path.relative(root, outFile) !== "" && !path.relative(root, outFile).startsWith("..") && !path.isAbsolute(path.relative(root, outFile));
        out.push({ id: oneLine(rec.id, 40), label, ...(typeof rec.pid === "number" ? { pid: rec.pid } : {}), ageSeconds: Math.max(0, Math.round((now - start) / 1000)), tail: inside ? lastLines(outFile) : [], start });
      } catch {
        // a record being rewritten or foreign: skip
      }
    }
  }
  return out.sort((a, b) => b.start - a.start).slice(0, MAX_ADDON_TASKS).map(({ start: _s, ...t }) => t);
}

export interface WaitRow {
  id: string;
  kind: string;
  note: string;
  ageSeconds: number;
  leftSeconds: number;
  log?: string;
}

/** The `/foreman waits` text: every wait with its last 5 log lines, then the add-on's running tasks. */
export function formatWaits(waits: readonly WaitRow[], addon: readonly AddonTask[], tail: (file: string) => string[] = lastLines): string {
  const lines: string[] = [];
  for (const w of waits) {
    lines.push(`${w.id} ${w.kind}${w.note ? ` "${w.note}"` : ""}: ${w.ageSeconds}s waited, times out in ${w.leftSeconds}s${w.log ? `, log ${w.log}` : ""}`);
    if (w.log) for (const l of tail(w.log)) lines.push(`  | ${l}`);
  }
  for (const t of addon) {
    lines.push(`${ADDON_RUN_TOOL} ${t.id}${t.label ? ` "${t.label}"` : ""}: running ${t.ageSeconds}s${t.pid ? `, pid ${t.pid}` : ""}`);
    for (const l of t.tail) lines.push(`  | ${l}`);
  }
  return lines.length ? lines.join("\n") : "No active waits.";
}

export const ADDON_REFUSAL = `${BG_TOOL}: the optional ${ADDON_PACKAGE} add-on is installed, so background shell tasks belong to its ${ADDON_RUN_TOOL} tool (one owner for detached tasks, with status, logs and kill); use ${ADDON_RUN_TOOL} and foreman_wait for its pid.`;
