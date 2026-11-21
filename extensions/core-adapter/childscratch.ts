// Programmatic child scratch (retro-harvest item 5). Every single-child launch gets its own dir
// `<worktree root>/.foreman/scratch/<sessionId>/<launchId>` (mode 0700; the root is `close.worktreeDir`, worktreeroot.ts sessionScratchRoot), or
// `<os.tmpdir()>/pi-foreman-scratch/<sessionId>/<launchId>` when the session has no usable worktree root (no git top, a root inside a git work tree, the
// npm root still resolving, or any failure making the folders: from then on the session uses the temp folder). Lanes under the temp folder from older
// runs are still removed and swept; nothing is migrated. A session start removes session lanes under `.foreman/scratch` older than 7 days. Named in a short prompt
// block and, through the launch binding (usage.ts), as the child's env FOREMAN_SCRATCH. The child
// keeps copies, mutation checks and temp files there instead of in the repo or `.workflow/`.
// The launching session removes the dir when the run ends (`child_scratch {bytes, files}` trace,
// then fs.rmSync after a realpath check that it lies under the root this module created and not
// in or around the repo) and sweeps its session root at shutdown; `ceremony.childScratch.keep`
// keeps them. Harness code only: no model turn and no guard sees the removal.
//
// Each launch also gets a kept output dir `<agentDir>/pi-foreman/child-out/<session>/<launch>` (env FOREMAN_OUT, binding `out`): a second
// scratch-like write root that is not removed at run end; the foreman's next session start sweeps folders older than 7 days (`sweepKept`).
//
// What the guards allow inside a scratch dir (never outside it):
//   - timeoutallow.ts: a command that only copies into, makes, removes inside or cds into a live
//     scratch dir of the asking role, or whose write path lies inside one, composes as `child-scratch`.
//     POSIX shell forms only, like `tmp-scratch`; a path from the write/edit tools works everywhere.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { get } from "./config.ts";
import { workspaceOf } from "./python.ts";
import { shellWords } from "./sedread.ts";
import { BINDING_NS } from "./usage.ts";
import type { LaunchBinding } from "./usage.ts";

export const SCRATCH_ENV = "FOREMAN_SCRATCH";
export const SCRATCH_DIR_NAME = "pi-foreman-scratch";
export const OUT_ENV = "FOREMAN_OUT";
const KEPT_DAYS = 7;

export interface ScratchFs {
  platform?: string;
  tmpdir?: () => string;
  uid?: () => number | null;
  /** The session's worktree-side scratch base (`<root>/.foreman/scratch`): lanes strictly inside it may be removed too. */
  wtBase?: string | null;
}

/** A session's worktree-side scratch location: `base` is `<root>/.foreman/scratch`; `failed` once making it failed (the session then uses the temp folder). */
export interface ScratchWt {
  root: string;
  base: string;
  failed: boolean;
}

export const FOREMAN_DIR_NAME = ".foreman";

/** `<root>/.foreman/scratch`. */
export const wtScratchBase = (root: string): string => path.join(root, FOREMAN_DIR_NAME, "scratch");

const realNative = (p: string): string | null => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
};

const safeId = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "x";

/** `<realpath(os.tmpdir())>/pi-foreman-scratch`, or null when the temp dir does not resolve. */
export function scratchRoot(deps: ScratchFs = {}): string | null {
  const tmp = realNative(path.resolve((deps.tmpdir ?? os.tmpdir)()));
  return tmp ? path.join(tmp, SCRATCH_DIR_NAME) : null;
}

/** `rel` from `parent` is strictly below it (not equal, not outside, same drive). */
function strictlyInside(parent: string, child: string, platform: string): boolean {
  const p = platform === "win32" ? path.win32 : path.posix;
  const fold = (x: string): string => (platform === "win32" || platform === "darwin" ? x.toLowerCase() : x);
  const rel = p.relative(fold(p.resolve(parent)), fold(p.resolve(child)));
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + p.sep) && !p.isAbsolute(rel);
}

/** A real directory (not a symlink), owned by this user on POSIX. */
function ownDir(p: string, deps: ScratchFs): boolean {
  try {
    const st = fs.lstatSync(p);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    const uid = deps.uid ? deps.uid() : typeof process.getuid === "function" ? process.getuid() : null;
    return uid === null || (deps.platform ?? process.platform) === "win32" || st.uid === uid;
  } catch {
    return false;
  }
}

function mkdirOwn(p: string, deps: ScratchFs): boolean {
  try {
    fs.mkdirSync(p, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
  }
  if (!ownDir(p, deps)) return false;
  try {
    if ((deps.platform ?? process.platform) !== "win32") fs.chmodSync(p, 0o700);
  } catch {
    return false;
  }
  return true;
}

/** The worktree root (plain mkdir only when missing, an existing one is never chmodded), then `.foreman` and `scratch` (own dirs, 0700, no symlink). */
function ensureWtBase(wt: ScratchWt, deps: ScratchFs): boolean {
  try {
    if (!fs.existsSync(wt.root)) fs.mkdirSync(wt.root, { recursive: true });
  } catch {
    return false;
  }
  return mkdirOwn(path.dirname(wt.base), deps) && mkdirOwn(wt.base, deps);
}

/**
 * Create the launch's scratch dir; null when anything is off (the launch then has none). With `wt` the dir lies under the worktree root; when that
 * cannot be made the session falls back to the temp folder for this and every later launch (`wt.failed`).
 */
export function createScratch(sessionId: string, launchId: string, deps: ScratchFs = {}, wt?: ScratchWt | null): string | null {
  if (wt && !wt.failed) {
    const dir = ensureWtBase(wt, deps) ? laneIn(wt.base, sessionId, launchId, deps) : null;
    if (dir) return dir;
    wt.failed = true;
  }
  const root = scratchRoot(deps);
  if (!root || !mkdirOwn(root, deps)) return null;
  return laneIn(root, sessionId, launchId, deps);
}

function laneIn(root: string, sessionId: string, launchId: string, deps: ScratchFs): string | null {
  const session = path.join(root, safeId(sessionId));
  if (!mkdirOwn(session, deps)) return null;
  const dir = path.join(session, safeId(launchId));
  try {
    fs.mkdirSync(dir, { mode: 0o700 }); // a fresh dir: an existing one is not reused
  } catch {
    return null;
  }
  const real = realNative(dir);
  const fold = (x: string): string => ((deps.platform ?? process.platform) === "win32" ? x.toLowerCase() : x);
  if (!ownDir(dir, deps) || real === null || fold(real) !== fold(dir)) return null;
  return dir;
}

/** Files and bytes below `dir` (symlinks are counted, never followed; at most 100000 entries). */
export function scratchStats(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length && seen < 100000) {
    const d = stack.pop()!;
    let names: string[] = [];
    try {
      names = fs.readdirSync(d);
    } catch {
      continue;
    }
    for (const n of names) {
      seen++;
      const p = path.join(d, n);
      try {
        const st = fs.lstatSync(p);
        if (st.isDirectory()) stack.push(p);
        else {
          files++;
          bytes += st.isFile() ? st.size : 0;
        }
      } catch {
        // gone meanwhile
      }
    }
  }
  return { bytes, files };
}

export type RemoveResult = { removed: true } | { removed: false; reason: "missing" | "not_dir" | "outside_root" | "repo" | "error" };

/**
 * Remove `dir` (recursive) only when it is a real directory strictly below the scratch root, and
 * neither inside nor around any of `repos`. Symlinks inside are removed, never followed.
 */
export function removeScratch(dir: string, repos: string[], deps: ScratchFs = {}): RemoveResult {
  const platform = deps.platform ?? process.platform;
  const roots = [scratchRoot(deps), deps.wtBase ?? null].map((r) => (r ? realNative(r) : null)).filter((r): r is string => !!r);
  const abs = path.resolve(dir);
  try {
    const st = fs.lstatSync(abs);
    if (!st.isDirectory() || st.isSymbolicLink()) return { removed: false, reason: "not_dir" };
  } catch {
    return { removed: false, reason: "missing" };
  }
  const real = realNative(abs);
  if (!real || !roots.some((root) => strictlyInside(root, real, platform) && strictlyInside(root, abs, platform))) return { removed: false, reason: "outside_root" };
  for (const r of repos) {
    const rr = realNative(r) ?? path.resolve(r);
    const fold = (x: string): string => (platform === "win32" || platform === "darwin" ? x.toLowerCase() : x);
    if (fold(rr) === fold(real) || strictlyInside(rr, real, platform) || strictlyInside(real, rr, platform)) return { removed: false, reason: "repo" };
  }
  try {
    fs.rmSync(real, { recursive: true, force: true, maxRetries: 2 });
    return { removed: true };
  } catch {
    return { removed: false, reason: "error" };
  }
}

/** The session's lane (`<base>/<sessionId>`) in the worktree base when `deps.wtBase` is set, else in the temp folder, for the shutdown sweep. */
export function sessionScratchDir(sessionId: string, deps: ScratchFs = {}): string | null {
  const root = deps.wtBase ?? scratchRoot(deps);
  return root ? path.join(root, safeId(sessionId)) : null;
}

/**
 * Session start: remove the session lanes (depth 1 below `base`) whose mtime is older than 7 days (the `sweepKept` rule), through `removeScratch`'s checks.
 * lstat only; nothing happens unless `.foreman` and `scratch` are real own dirs. Returns the number removed.
 */
export function sweepOldLanes(base: string, repos: string[], now: number = Date.now(), deps: ScratchFs = {}): number {
  if (!ownDir(path.dirname(base), deps) || !ownDir(base, deps)) return 0;
  const cutoff = now - KEPT_DAYS * 86400000;
  let removed = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return 0;
  }
  for (const n of names) {
    const lane = path.join(base, n);
    try {
      if (!ownDir(lane, deps) || fs.lstatSync(lane).mtimeMs >= cutoff) continue;
    } catch {
      continue;
    }
    if (removeScratch(lane, repos, { ...deps, wtBase: base }).removed === true) removed++;
  }
  return removed;
}

/** `<realpath(agentDir)>/pi-foreman/child-out`, the kept output folders' root, or null when the agent dir does not resolve. */
export function keptRoot(agentDir: string): string | null {
  const real = realNative(path.resolve(agentDir));
  return real ? path.join(real, "pi-foreman", "child-out") : null;
}

/** Create the launch's kept output dir `<agentDir>/pi-foreman/child-out/<session>/<launch>` (0700); null when anything is off. Never removed at run end. */
export function createKept(agentDir: string, sessionId: string, launchId: string, deps: ScratchFs = {}): string | null {
  const root = keptRoot(agentDir);
  if (!root) return null;
  try {
    fs.mkdirSync(path.dirname(root), { recursive: true });
  } catch {
    return null;
  }
  if (!mkdirOwn(root, deps)) return null;
  const session = path.join(root, safeId(sessionId));
  if (!mkdirOwn(session, deps)) return null;
  const dir = path.join(session, safeId(launchId));
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch {
    return null;
  }
  return ownDir(dir, deps) ? dir : null;
}

/**
 * Session start: remove the launch folders (depth 2 below `child-out`, any session) whose mtime is older than 7 days, then the session folders left
 * empty. lstat only, links are never followed (a link at depth 2 is not a directory and stays; a link inside an old folder goes as a link, its target
 * untouched); nothing outside `child-out` is looked at. Returns the number of launch folders removed.
 */
export function sweepKept(agentDir: string, now: number = Date.now(), deps: ScratchFs = {}): number {
  const root = keptRoot(agentDir);
  if (!root || !ownDir(root, deps)) return 0;
  const cutoff = now - KEPT_DAYS * 86400000;
  let removed = 0;
  const dirsIn = (d: string): string[] => {
    try {
      return fs.readdirSync(d).filter((n) => ownDir(path.join(d, n), deps));
    } catch {
      return [];
    }
  };
  for (const s of dirsIn(root)) {
    const session = path.join(root, s);
    for (const l of dirsIn(session)) {
      const launch = path.join(session, l);
      try {
        if (fs.lstatSync(launch).mtimeMs >= cutoff) continue;
        fs.rmSync(launch, { recursive: true, force: true, maxRetries: 2 });
        removed++;
      } catch {
        // left for the next start
      }
    }
    try {
      fs.rmdirSync(session); // only an empty one goes
    } catch {
      // not empty
    }
  }
  return removed;
}

export function scratchPromptBlock(dir: string): string {
  return `[pi-foreman scratch] Your scratch dir: ${dir} (env $${SCRATCH_ENV}). Put copies, mutation checks and temp files there, never in the repo or .workflow/. The harness deletes it when you finish; use the literal path for rm -r.`;
}

/** The pi-foreman launch id bound into a subagent call's input (usage.ts bindLaunch), or null. */
export function boundLaunchId(input: unknown): string | null {
  const b = input && typeof input === "object" ? (input as { extensionBindings?: Record<string, unknown> }).extensionBindings : undefined;
  const ns = b && typeof b === "object" ? (b as Record<string, unknown>)[BINDING_NS] : undefined;
  const id = ns && typeof ns === "object" ? (ns as { launchId?: unknown }).launchId : undefined;
  return typeof id === "string" && id ? id : null;
}

/** Per-session bookkeeping: launch id -> dir and role, run id -> launch id, run ends seen early. */
export class ChildScratch {
  private launches = new Map<string, { dir: string; role: string }>();
  private runs = new Map<string, string>();
  private ended: string[] = [];
  /** Launches whose dir was taken at a run end: a resume of that launch makes the dir again at the same path. */
  private finished = new Map<string, { dir: string; role: string }>();

  add(launchId: string, dir: string, role: string): void {
    this.launches.set(launchId, { dir, role });
  }

  /** The launch's tool result: the launch id to finish now (no run started, or it already ended), else null. */
  onLaunched(launchId: string | null, runId: string | null): string | null {
    if (!launchId || !this.launches.has(launchId)) return null;
    if (!runId || this.ended.includes(runId)) return launchId;
    this.runs.set(runId, launchId);
    return null;
  }

  /** A run end: the launch id to finish, else null (the run end is remembered for a late tool result). */
  onRunEnd(runId: string): string | null {
    const id = this.runs.get(runId);
    if (id) {
      this.runs.delete(runId);
      return id;
    }
    this.ended.push(runId);
    if (this.ended.length > 200) this.ended.shift();
    return null;
  }

  has(launchId: string): boolean {
    return this.launches.has(launchId);
  }

  /** The scratch dir of a live run, else undefined. */
  dirOfRun(runId: string): string | undefined {
    const id = this.runs.get(runId);
    return id ? this.launches.get(id)?.dir : undefined;
  }

  take(launchId: string): { dir: string; role: string } | undefined {
    const e = this.launches.get(launchId);
    this.launches.delete(launchId);
    if (e) {
      this.finished.set(launchId, e);
      if (this.finished.size > 200) this.finished.delete(this.finished.keys().next().value as string);
    }
    return e;
  }

  /** The dir and role of a launch that was finished (removed or kept) earlier, else undefined. */
  finishedLaunch(launchId: string): { dir: string; role: string } | undefined {
    return this.finished.get(launchId);
  }

  /** Live scratch dirs, of one role when given (a forwarded ask names only its role). */
  live(role?: string | null): string[] {
    return [...this.launches.values()].filter((e) => !role || e.role === role || e.role === "*").map((e) => e.dir);
  }
}

// ------------------------------------------------------------- deterministic allow

/** `dir0` as a shell word value (win32: the forward-slash spelling), or null when it holds a character the shell would read. */
function shellSafeDir(dir0: string, platform: string): string | null {
  let dir = dir0;
  if (platform === "win32") {
    dir = dir0.replace(/\\/g, "/");
    if (!/^[A-Za-z]:\//.test(dir) || /(^|[^A-Za-z0-9])~/.test(dir) || /[\s'"\\$`*?[\]{}()<>|;&!#]/.test(dir)) return null;
  } else if (/[\s'"\\$`*?[\]{}()<>|;&!#~]/.test(dir)) return null;
  return dir;
}

/**
 * Replace `$FOREMAN_SCRATCH` / `${FOREMAN_SCRATCH}` outside single quotes by `dir`; null when the
 * dir holds a character the shell would read (then nothing is resolved and the caller refuses).
 * win32: the dir is a native drive path (`C:\Users\RUNNER~1\...\scratch`); bash keeps a variable's value as is, so it is put in
 * as the forward-slash spelling of the same path (`C:/Users/RUNNER~1/.../scratch`), and a `~` inside a name (an 8.3 short name,
 * after a letter or digit) is literal. Not a drive path, or any other shell character, is null as on POSIX.
 */
export function expandScratchVar(command: string, dir0: string, platform: string = process.platform): string | null {
  return substVar(command, SCRATCH_ENV, dir0, platform)?.text ?? null;
}

/**
 * `command` with `$FOREMAN_OUT` / `${FOREMAN_OUT}` read as the child's kept output dir `dir`, for the guards only (the shell sees the variable).
 * Unchanged when the line holds an apostrophe, or when any mention of the name is not a plain reference (an assignment, `export`, `env FOREMAN_OUT=`,
 * `${FOREMAN_OUT:-x}`, `\$FOREMAN_OUT`): the variable may then not hold `dir`, and the call stays unresolved as before.
 * Without an apostrophe the quote tracker and bash agree on every executed `$FOREMAN_OUT`.
 */
export function expandOutVar(command: string, dir: string, platform: string = process.platform): string {
  // the text pass cannot track quotes as bash does (nested quoting in `$(...)`, backticks, `${u:-"..."}`, heredoc bodies, comments): any apostrophe leaves the line unresolved
  if (command.includes("'")) return command;
  const r = substVar(command, OUT_ENV, dir, platform);
  const mentions = command.match(/(?<![A-Za-z0-9_])FOREMAN_OUT(?![A-Za-z0-9_])/g)?.length ?? 0;
  return r && r.hits === mentions ? r.text : command;
}

function substVar(command: string, name: string, dir0: string, platform: string): { text: string; hits: number } | null {
  const dir = shellSafeDir(dir0, platform);
  if (dir === null) return null;
  const ref = new RegExp(`^\\$(?:\\{${name}\\}|${name}(?![A-Za-z0-9_]))`);
  let hits = 0;
  let out = "";
  let single = false;
  let double = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "\\" && !single) {
      out += command.slice(i, i + 2);
      i++;
      continue;
    }
    if (c === "'" && !double) single = !single;
    else if (c === '"' && !single) double = !double;
    if (c === "$" && !single) {
      const m = ref.exec(command.slice(i));
      if (m) {
        out += dir;
        hits++;
        i += m[0].length - 1;
        continue;
      }
    }
    out += c;
  }
  return { text: out, hits };
}

/** `p` (absolute, normalized) lies strictly inside one of `dirs`, its deepest existing ancestor included (no symlink out). */
export function insideScratch(p: string, dirs: string[], platform: string = process.platform): boolean {
  const px = platform === "win32" ? path.win32 : path.posix;
  if (!px.isAbsolute(p) || p.split(/[\\/]/).includes("..")) return false;
  // Glob characters never name a scratch path: bash could expand them (e.g. `.?` to `..`).
  if (/[*?[\]{}]/.test(p)) return false;
  const norm = px.normalize(p);
  for (const d of dirs) {
    if (!strictlyInside(d, norm, platform)) continue;
    let cur = norm;
    let exists = false;
    while (!exists && strictlyInside(d, cur, platform)) {
      try {
        fs.lstatSync(cur);
        exists = true;
      } catch {
        cur = px.dirname(cur);
      }
    }
    const real = realNative(cur);
    if (!real) continue;
    const realD = realNative(d) ?? d;
    if (cur === norm) {
      // the path itself exists: it must not be a symlink, and it lies below the real dir
      const parent = realNative(px.dirname(norm));
      if (parent && strictlyInside(realD, real, platform) && real === px.join(parent, px.basename(norm))) return true;
      continue;
    }
    if (real === realD || strictlyInside(realD, real, platform)) return true;
  }
  return false;
}

/**
 * `node|python|python3 <script> [args]` where the script and every path-shaped argument lie inside
 * `dirs`: the child runs code it wrote into its own scratch dir (harness-friction row 25). No
 * interpreter option before the script (`-e`, `-c`, `-m` run other code), no option value naming a path outside.
 */
export function scratchScriptRun(words: string[], dirs: string[], platform: string = process.platform): boolean {
  const [prog, script, ...rest] = words;
  if (!prog || !/^(node|python|python3)$/.test(prog) || !script || script.startsWith("-") || !insideScratch(script, dirs, platform)) return false;
  return rest.every((a) => {
    const v = a.startsWith("-") && a.includes("=") ? a.slice(a.indexOf("=") + 1) : a;
    return !/[\\/~]|^\./.test(v) || (!!v && insideScratch(v, dirs, platform));
  });
}

const CMD_SYNTAX = /[|<>`$()\n\r]/;

/**
 * True when every `&&`/`;` unit of `command` is a scratch operation inside `dirs` (cp/mkdir/rm
 * with every destination or operand strictly inside, cd into one) or passes `unitOk`, and at
 * least one unit is a scratch operation. POSIX only. `$FOREMAN_SCRATCH` is resolved per dir.
 */
export function scratchCommandAllowed(command: string, dirs: string[], unitOk: (unit: string) => boolean, platform: string = process.platform): boolean {
  if (platform === "win32" || !dirs.length) return false;
  for (const d of dirs) {
    const text = expandScratchVar(command, d, platform);
    if (text === null || CMD_SYNTAX.test(text) || /(^|[^&])&([^&]|$)/.test(text)) continue;
    const units = text.split(/&&|;/).map((u) => u.trim());
    if (units.some((u) => !u)) continue;
    let ops = 0;
    let ok = true;
    for (const u of units) {
      if (scratchUnit(u, dirs, platform)) ops++;
      else if (!unitOk(u)) {
        ok = false;
        break;
      }
    }
    if (ok && ops > 0) return true;
  }
  return false;
}

function scratchUnit(unit: string, dirs: string[], platform: string): boolean {
  const w = shellWords(unit);
  if (!w || w.length < 2) return false;
  const [prog, ...args] = w;
  let k = 0;
  const inside = (o: string): boolean => !!o && !o.startsWith("-") && insideScratch(o, dirs, platform);
  if (prog === "cp") {
    while (k < args.length && args[k].startsWith("-")) if (!/^-[Rapf]+$/.test(args[k++])) return false;
    const ops = args.slice(k);
    return ops.length >= 2 && ops.every((o) => !!o && !o.startsWith("-")) && inside(ops[ops.length - 1]);
  }
  if (prog === "mkdir") {
    while (k < args.length && args[k].startsWith("-")) if (args[k++] !== "-p") return false;
    const ops = args.slice(k);
    return ops.length > 0 && ops.every(inside);
  }
  if (prog === "rm") {
    while (k < args.length && args[k].startsWith("-") && args[k] !== "--") if (!/^-[rRf]+$/.test(args[k++])) return false;
    if (args[k] === "--") k++;
    const ops = args.slice(k);
    return ops.length > 0 && ops.every((o) => !!o && insideScratch(o, dirs, platform));
  }
  if (prog === "cd") return args.length === 1 && (inside(args[0]) || dirs.some((d) => d === args[0]));
  if (prog === "node" || prog === "python" || prog === "python3") return scratchScriptRun(w, dirs, platform);
  return false;
}

// ------------------------------------------------------------------- wiring (index.ts)

/** The slice of a Session the wiring below reads. */
export interface ScratchHost {
  id: string;
  cwd: string;
  config: { config: unknown };
  trace?: { emit(rec: Record<string, unknown>): void } | null;
  scratch: ChildScratch;
  /** The Pi agent dir; without it a launch gets no kept output dir. */
  agentDir?: string;
  /** The worktree-side scratch location (`<root>/.foreman/scratch`), null/absent: the temp folder. */
  scratchWt?: ScratchWt | null;
  /** Set once `child_scratch_root` is traced (the first launch that creates a lane). */
  scratchRootTraced?: boolean;
}

const depsOf = (h: ScratchHost, deps: ScratchFs): ScratchFs => (h.scratchWt ? { ...deps, wtBase: h.scratchWt.base } : deps);

const keepOf = (h: ScratchHost): boolean => get(h.config.config, "ceremony.childScratch.keep") === true;
const reposOf = (h: ScratchHost): string[] => [h.cwd, workspaceOf(h.cwd).root];

/** At a single-child launch: create the dir, put it into the binding and the task, record it. */
export function launchScratch(h: ScratchHost, input: Record<string, unknown>, b: LaunchBinding, deps: ScratchFs = {}): void {
  const dir = createScratch(h.id, b.launchId, deps, h.scratchWt);
  if (!dir) {
    h.trace?.emit({ event: "child_scratch", role: b.role, action: "unavailable" });
    return;
  }
  if (!h.scratchRootTraced) {
    h.scratchRootTraced = true;
    h.trace?.emit({ event: "child_scratch_root", source: h.scratchWt && !h.scratchWt.failed ? "worktree" : "tmp" });
  }
  b.scratch = dir;
  h.scratch.add(b.launchId, dir, b.role);
  const out = h.agentDir ? createKept(h.agentDir, h.id, b.launchId, deps) : null;
  if (out) b.out = out;
  const keep = out ? ` Logs and results that must outlive the run go to ${out} (env $${OUT_ENV}); the harness keeps it for 7 days.` : "";
  if (typeof input.task === "string") input.task = `${input.task}\n\n${scratchPromptBlock(dir)}${keep}`;
}

/**
 * A resume of a launch whose scratch dir the first run's end removed: the resumed child keeps the first launch's env
 * (`FOREMAN_SCRATCH`), so the dir is made again at that path and registered, to be removed when the resumed run ends.
 * Returns the launch id when the dir exists afterwards, else null.
 */
export function resumeScratch(h: ScratchHost, launchId: string, deps: ScratchFs = {}): string | null {
  const e = h.scratch.finishedLaunch(launchId);
  if (!e) return h.scratch.has(launchId) ? launchId : null;
  if (!fs.existsSync(e.dir)) {
    try {
      fs.mkdirSync(e.dir, { mode: 0o700 });
    } catch {
      h.trace?.emit({ event: "child_scratch", role: e.role, action: "unavailable" });
      return null;
    }
    if (!ownDir(e.dir, deps)) return null;
  }
  h.scratch.add(launchId, e.dir, e.role);
  return launchId;
}

/**
 * Explorer run end: write the full report to `<scratch>/<session>/brief-<run>/explorer-brief.md`
 * and register that dir as a live scratch dir of every role (role "*"), so a builder or reviewer
 * reads it with the read tool without an ask (review link: child-scratch). The session sweep
 * removes it at shutdown. Returns the file path, or null when anything is off.
 */
export function storeBrief(h: ScratchHost, runId: string, text: string, deps: ScratchFs = {}): string | null {
  const id = `brief-${safeId(runId)}`;
  const dir = createScratch(h.id, id, deps, h.scratchWt);
  if (!dir) return null;
  const file = path.join(dir, "explorer-brief.md");
  try {
    fs.writeFileSync(file, text, { mode: 0o600 });
  } catch {
    return null;
  }
  h.scratch.add(id, dir, "*");
  return file;
}

/** The run ended (or never started): trace `child_scratch {bytes, files}`, then remove unless kept. */
export function finishScratch(h: ScratchHost, launchId: string | null, deps: ScratchFs = {}): void {
  const e = launchId ? h.scratch.take(launchId) : undefined;
  if (!e) return;
  const st = scratchStats(e.dir);
  if (keepOf(h)) {
    h.trace?.emit({ event: "child_scratch", role: e.role, bytes: st.bytes, files: st.files, action: "kept" });
    return;
  }
  const r = removeScratch(e.dir, reposOf(h), depsOf(h, deps));
  h.trace?.emit({ event: "child_scratch", role: e.role, bytes: st.bytes, files: st.files, action: r.removed === true ? "removed" : r.reason === "missing" ? "gone" : `refused_${r.reason}` });
}

/** Session shutdown: remove the session's lane in the worktree base and in the temp folder (older runs) unless kept. */
export function sweepScratch(h: ScratchHost, deps: ScratchFs = {}): void {
  if (keepOf(h)) return;
  const d = depsOf(h, deps);
  for (const dir of [sessionScratchDir(h.id, d), h.scratchWt ? sessionScratchDir(h.id, deps) : null]) if (dir) removeScratch(dir, reposOf(h), d);
}

/** Session start (foreman): remove worktree-side session lanes older than 7 days. */
export function sweepOldScratch(h: ScratchHost, now: number = Date.now(), deps: ScratchFs = {}): number {
  return h.scratchWt ? sweepOldLanes(h.scratchWt.base, reposOf(h), now, deps) : 0;
}
