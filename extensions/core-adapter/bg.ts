// `foreman_bg` (ledger item 5) and the optional background-tasks add-on (item 6).
//
// `foreman_bg {command, note}` runs one shell command detached (own process group on POSIX, see bgSpawnFlags for win32; stdout and stderr to
// `<stateDir>/scratch/<session>/wait-<id>.log`, or `wait-<id>-<token>.log` with a run token when the plain name already exists, e.g. after a reload) and registers a `pid` wait for it, so the foreman ends its turn and is
// woken when the process is gone. The call is guarded exactly like a foreground `bash` call with the same command:
// index.ts routes `foreman_bg` through the same tool_call guards (overlay, shell write guard, destructive guard and the config-change check)
// and the gate treats it as a shell tool (`SHELL_TOOLS` in gate.ts).
// This file only spawns; it never decides.
//
// The add-on package `pi-background-tasks` is never imported or required. It is detected by its tool `bg_run` (or its
// package directory); while present, `foreman_bg` refuses with a pointer to `bg_run`, and `/foreman waits` also lists
// its running tasks from `<cwd>/.pi/tasks/<session>-<pid>/<task-id>.json`.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getShellConfig as piGetShellConfig } from "@earendil-works/pi-coding-agent";
import { msysEnv } from "./env.ts";

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
    command: { type: "string", description: "The shell command to run in the background (detached on POSIX, not detached on win32; same guards as a bash call). On win32 it runs in the bash tool's shell (Git Bash, `bash -c`), so write POSIX syntax; cmd.exe only when no bash is found." },
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

/**
 * The log path of a new run: `bgLogPath`, or when that file exists (the wait id sequence restarts on a session reload while an older run
 * may still write its log) a name with a time+random token, so a new run never truncates or interleaves with an earlier run's log.
 */
export function freshBgLogPath(stateDir: string, sessionId: string, waitId: string): string {
  const base = bgLogPath(stateDir, sessionId, waitId);
  if (!fs.existsSync(base)) return base;
  return path.join(path.dirname(base), `wait-${safeSegment(waitId)}-${Date.now().toString(36)}${randomBytes(4).toString("hex")}.log`);
}

/**
 * The shell that runs the command: bash (else sh) on POSIX; on Windows the bash tool's shell, Pi's `getShellConfig(shellPath)`
 * (Git Bash, `-c`), so the guards' bash reading matches what runs. Only when that throws (no bash found) or wants the command on
 * stdin (legacy WSL bash) it is `cmd /d /s /c`: with `/s /c`, cmd strips the first and the last quote of its command line, so the
 * command is wrapped in one more pair of quotes (what Node's `shell: true` does on win32); without them a quoted `node -e "..."`
 * loses its quotes and cmd parses `<`, `>`, `&` inside it as redirections. The arguments go verbatim (no MSVCRT re-quoting).
 * Known limit: the cmd.exe fallback runs the command under cmd.exe while the guards classify it as bash (docs/safety.md).
 */
export type ShellConfigFn = (shellPath?: string) => { shell: string; args: string[]; commandTransport?: string };

export function shellFor(command: string, platform: string = process.platform, opts: { getShellConfig?: ShellConfigFn; shellPath?: string } = {}): { file: string; args: string[]; verbatim: boolean } {
  if (platform === "win32") {
    try {
      const cfg = (opts.getShellConfig ?? piGetShellConfig)(opts.shellPath || undefined);
      if (cfg.commandTransport !== "stdin") return { file: cfg.shell, args: [...cfg.args, command], verbatim: false };
    } catch {
      // no bash found: cmd.exe below
    }
    return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${command}"`], verbatim: true };
  }
  return { file: fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh", args: ["-c", command], verbatim: false };
}

/**
 * The spawn flags of a foreman_bg run. POSIX: detached (own process group, so wait.ts kills `-pid`). win32: not detached, as
 * node's `detached` there is DETACHED_PROCESS: cmd.exe then has no console, a console grandchild it starts (node, npm) gets a new
 * console whose std handles replace the inherited log handle, and its output never reaches the log (CI ids 32, 33, 39; cmd's own
 * builtins still did). Without it cmd shares the parent's console (or, when the parent has none, a new one hidden by windowsHide)
 * and passes the log handle on. Windows ends no child when its parent exits, and wait.ts kills the plain pid on win32, so the run
 * still outlives the session; the trade-off: a console close or Ctrl+C event of the parent's console now reaches the run as well.
 */
export function bgSpawnFlags(platform: string = process.platform): { detached: boolean; windowsHide: boolean } {
  return { detached: platform !== "win32", windowsHide: true };
}

/** Spawn `command` detached (bgSpawnFlags) with stdout and stderr appended to `logPath`; the pid, or why not. */
export function spawnDetached(command: string, cwd: string, logPath: string, platform: string = process.platform, opts: { getShellConfig?: ShellConfigFn; shellPath?: string; config?: unknown; env?: NodeJS.ProcessEnv } = {}): { pid: number } | { error: string } {
  let fd: number | null = null;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    // win32: node's "a" opens the handle with FILE_APPEND_DATA only; the MSYS runtime of Git Bash takes such a handle as not writable, so a bash builtin
    // (`echo`) printed nothing (CI) while a native grandchild (node) still wrote. "w" grants write access; the log name is fresh per run (freshBgLogPath: `wait-<id>-<token>.log` when `wait-<id>.log` exists), so "w" never truncates an earlier run's log; nothing to keep.
    fd = fs.openSync(logPath, platform === "win32" ? "w" : "a", 0o600);
    const sh = shellFor(command, platform, opts);
    // the log fd stays open until spawn has returned (the child holds its own duplicate by then); `finally` closes ours
    const child = spawn(sh.file, sh.args, { cwd, ...bgSpawnFlags(platform), stdio: ["ignore", fd, fd], env: { ...(opts.env ?? process.env), ...msysEnv(platform, opts.config) }, windowsVerbatimArguments: sh.verbatim });
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

/** Pi's `shellPath` setting: the project's `.pi/settings.json` over the agent dir's `settings.json`; undefined when unset. */
export function shellPathSetting(agentDir: string, cwd: string): string | undefined {
  for (const f of [path.join(cwd, ".pi", "settings.json"), path.join(agentDir, "settings.json")]) {
    try {
      const v = (JSON.parse(fs.readFileSync(f, "utf8")) as { shellPath?: unknown }).shellPath;
      if (typeof v === "string" && v.trim()) return v.trim();
    } catch {
      // absent or unreadable: next
    }
  }
  return undefined;
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

/** Whether an executable `name` is on `pathEnv` (win32: also the `.cmd`/`.exe`/`.ps1` shims npm writes). */
export function onPath(name: string, pathEnv: string | undefined, platform: string = process.platform): boolean {
  const exts = platform === "win32" ? ["", ".cmd", ".exe", ".ps1", ".bat"] : [""];
  for (const dir of (pathEnv ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean)) {
    for (const ext of exts) {
      if (fs.existsSync(path.join(dir, name + ext))) return true;
    }
  }
  return false;
}

/**
 * Doctor INFO lines for the optional pi-quiver and pi-memory add-ons: present or absent, and for pi-memory whether `qmd`
 * (needed only by `memory_search`) is on PATH. Never a WARN or FAIL.
 */
export function optionalAddonsDoctor(dirs: { agentDir: string; cwd: string }, toolNames: readonly string[], env: NodeJS.ProcessEnv, platform: string = process.platform): string[] {
  const has = (pkg: string): boolean => [path.join(dirs.agentDir, "npm", "node_modules", pkg), path.join(dirs.cwd, ".pi", "npm", "node_modules", pkg)].some((d) => fs.existsSync(path.join(d, "package.json")));
  const out: string[] = [];
  out.push(`INFO quiver: ${has("pi-quiver") || toolNames.includes("doc_to_md") ? "present" : "absent"}`);
  const memory = has("pi-memory") || toolNames.includes("memory_write");
  out.push(`INFO memory: ${memory ? "present" : "absent"}`);
  if (memory && !onPath("qmd", env.PATH ?? env.Path, platform)) out.push("INFO memory: qmd not on PATH, memory_search is unavailable (the other memory tools work; install with: npm i -g @tobilu/qmd)");
  return out;
}

/** Installed add-on package directory (agent npm root first, then the project's), or null. */
export function addonPackageDir(dirs: { agentDir: string; cwd: string }): string | null {
  const candidates = [path.join(dirs.agentDir, "npm", "node_modules", ADDON_PACKAGE), path.join(dirs.cwd, ".pi", "npm", "node_modules", ADDON_PACKAGE)];
  return candidates.find((d) => fs.existsSync(path.join(d, "package.json"))) ?? null;
}

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_PACKAGE_OLD = "@mariozechner/pi-coding-agent";

type Ver = [number, number, number];
function parseVer(v: string): Ver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const cmp = (a: Ver, b: Ver): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** One comparator against `v`; null when the comparator is not understood. */
function matchComparator(v: Ver, c: string): boolean | null {
  if (c === "*" || c === "x" || c === "X" || c === "") return true;
  const m = /^(\^|~|>=|<=|>|<|=)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?$/.exec(c);
  if (!m) return null;
  const op = m[1] ?? "";
  const parts = [m[2], m[3], m[4]].map((p) => (p === undefined || /^[xX*]$/.test(p) ? null : Number(p)));
  const given = parts.findIndex((p) => p === null);
  const n = given === -1 ? 3 : given; // how many leading numbers are fixed
  const lo: Ver = [parts[0] ?? 0, n > 1 ? (parts[1] ?? 0) : 0, n > 2 ? (parts[2] ?? 0) : 0];
  const bump = (i: number): Ver => (i === 0 ? [lo[0] + 1, 0, 0] : i === 1 ? [lo[0], lo[1] + 1, 0] : [lo[0], lo[1], lo[2] + 1]);
  if (op === "" || op === "=") return n === 0 ? true : cmp(v, lo) >= 0 && cmp(v, bump(n - 1)) < 0;
  if (op === ">=") return cmp(v, lo) >= 0;
  if (op === ">") return n === 3 ? cmp(v, lo) > 0 : cmp(v, bump(n - 1)) >= 0;
  if (op === "<") return cmp(v, lo) < 0;
  if (op === "<=") return n === 3 ? cmp(v, lo) <= 0 : cmp(v, bump(n - 1)) < 0;
  if (op === "~") return cmp(v, lo) >= 0 && cmp(v, bump(n >= 2 ? 1 : 0)) < 0;
  // caret: the first non-zero fixed part may not change
  const first = lo[0] !== 0 || n === 1 ? 0 : lo[1] !== 0 || n === 2 ? 1 : 2;
  return cmp(v, lo) >= 0 && cmp(v, bump(Math.min(first, Math.max(0, n - 1)))) < 0;
}

/** Whether `version` satisfies an npm range (`||`, space-joined comparators, ^ ~ >= > <= < =, x-ranges); null when unparseable. */
export function rangeAllows(range: string, version: string): boolean | null {
  const v = parseVer(version);
  if (!v) return null;
  let any = false;
  for (const set of range.split("||")) {
    const comps = set.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, "$1").split(/\s+/).filter(Boolean);
    if (comps.includes("-")) return null; // hyphen ranges: not checked
    let all = true;
    for (const c of comps.length ? comps : ["*"]) {
      const r = matchComparator(v, c);
      if (r === null) return null;
      all &&= r;
    }
    any ||= all;
  }
  return any;
}

/**
 * Doctor info line: the add-on's declared peer range for Pi against the running Pi version. Never a FAIL;
 * null when the add-on package is not installed.
 */
export function addonPeerRangeLine(dirs: { agentDir: string; cwd: string }, piVersion: string | null): string | null {
  const dir = addonPackageDir(dirs);
  if (!dir) return null;
  let peers: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { peerDependencies?: unknown };
    if (pkg.peerDependencies && typeof pkg.peerDependencies === "object") peers = pkg.peerDependencies as Record<string, unknown>;
  } catch {
    return `INFO ${ADDON_PACKAGE}: package.json unreadable, peer range for ${PI_PACKAGE} not checked`;
  }
  const range = [peers[PI_PACKAGE], peers[PI_PACKAGE_OLD]].find((r): r is string => typeof r === "string");
  const head = `INFO ${ADDON_PACKAGE} peer range for ${PI_PACKAGE}:`;
  if (!range) return `${head} none declared`;
  const r = oneLine(range, 120);
  if (!piVersion) return `${head} ${r}; running Pi version unknown`;
  const fits = rangeAllows(range, piVersion);
  if (fits === null) return `${head} ${r}; running Pi ${piVersion} (range not checked)`;
  if (fits) return `${head} ${r}; running Pi ${piVersion} is inside it`;
  return `${head} ${r}; running Pi ${piVersion} is outside it (npm may warn on install; check for a newer ${ADDON_PACKAGE})`;
}

export const ATTRIBUTION_WARNING = "Anthropic attribution refuses non-OAuth Anthropic credential; subscription OAuth token is required";

/**
 * Kind of the `anthropic` credential Pi would use: the stored auth.json entry first (its `type`), then the
 * environment (ANTHROPIC_OAUTH_TOKEN before the key variables). Reads only the type; never returns a secret.
 */
export function anthropicCredentialKind(agentDir: string, env: NodeJS.ProcessEnv): "oauth" | "api_key" | "none" {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8")) as Record<string, unknown>;
    const entry = auth?.anthropic as { type?: unknown } | undefined;
    if (entry && typeof entry === "object") return entry.type === "oauth" ? "oauth" : "api_key";
  } catch {
    // no or unreadable auth store: the environment decides
  }
  if (env.ANTHROPIC_OAUTH_TOKEN?.trim()) return "oauth";
  if (env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim()) return "api_key";
  return "none";
}

/**
 * Doctor lines for the add-on's features: the effective PI_BG_FEATURES (when the add-on is present or the variable
 * is set), and a WARN when `attribution` is on while the anthropic credential is not OAuth. Never a FAIL.
 */
export function bgFeaturesDoctor(present: boolean, agentDir: string, env: NodeJS.ProcessEnv): string[] {
  const raw = env.PI_BG_FEATURES;
  if (!present && raw === undefined) return [];
  const features = (raw ?? "").split(/[\s,]+/).filter(Boolean);
  const out = [`INFO PI_BG_FEATURES: ${raw === undefined ? "unset (the add-on's defaults)" : oneLine(raw, 120) || "(empty)"}`];
  if (features.includes("attribution") && anthropicCredentialKind(agentDir, env) !== "oauth") {
    out.push(`WARN PI_BG_FEATURES has attribution but the anthropic credential is not OAuth: Pi shows "${ATTRIBUTION_WARNING}" — log in with the Anthropic subscription (/login anthropic) or drop attribution from PI_BG_FEATURES`);
  }
  return out;
}

export interface AddonTask {
  id: string;
  label: string;
  pid?: number;
  ageSeconds: number;
  tail: string[];
  /** The output file relative to the worktree (cwd), when it lies inside .pi/tasks. */
  log?: string;
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
        out.push({ id: oneLine(rec.id, 40), label, ...(typeof rec.pid === "number" ? { pid: rec.pid } : {}), ageSeconds: Math.max(0, Math.round((now - start) / 1000)), tail: inside ? lastLines(outFile) : [], ...(inside ? { log: path.relative(cwd, outFile!).split(path.sep).join("/") } : {}), start });
      } catch {
        // a record being rewritten or foreign: skip
      }
    }
  }
  return out.sort((a, b) => b.start - a.start).slice(0, MAX_ADDON_TASKS).map(({ start: _s, ...t }) => t);
}

/** Running add-on tasks of one Pi session only: the directories `<sessionId>-<pid>` under `<cwd>/.pi/tasks`; no log tails (`tail` is always empty). */
export function readOwnAddonTasks(cwd: string, sessionId: string, now: number = Date.now()): AddonTask[] {
  const root = path.join(cwd, ".pi", "tasks");
  const own = new RegExp(`^${sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+$`);
  const out: (AddonTask & { start: number })[] = [];
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && own.test(d.name)).map((d) => d.name);
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
        out.push({ id: oneLine(rec.id, 40), label: oneLine(rec.name ?? rec.description ?? rec.command, 80), ...(typeof rec.pid === "number" ? { pid: rec.pid } : {}), ageSeconds: Math.max(0, Math.round((now - start) / 1000)), tail: [], start });
      } catch {
        // a record being rewritten or foreign: skip
      }
    }
  }
  return out.sort((a, b) => b.start - a.start).slice(0, MAX_ADDON_TASKS).map(({ start: _s, ...t }) => t);
}

/** Ids of running bg_run tasks of this pi process (`<sessionId>-<pid>` dir) that notify and trigger on completion: only those can wake the session. */
export function wakingBgTaskIds(cwd: string, sessionId: string, pid: number = process.pid): string[] {
  const dir = path.join(cwd, ".pi", "tasks", `${sessionId}-${pid}`);
  const ids: string[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  for (const f of files) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Record<string, unknown>;
      if (rec.status !== "running" || typeof rec.id !== "string") continue;
      if (rec.notifyOnCompletion === false || rec.triggerOnCompletion === false) continue;
      ids.push(oneLine(rec.id, 40));
    } catch {
      // a record being rewritten or foreign: skip
    }
  }
  return ids;
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
    if (t.log) lines.push(`  log ${t.log}`);
  }
  return lines.length ? lines.join("\n") : "No active waits.";
}

export const ADDON_REFUSAL = `${BG_TOOL}: the optional ${ADDON_PACKAGE} add-on is installed, so background shell tasks belong to its ${ADDON_RUN_TOOL} tool (one owner for detached tasks, with status, logs and kill); use ${ADDON_RUN_TOOL} and foreman_wait for its pid.`;
