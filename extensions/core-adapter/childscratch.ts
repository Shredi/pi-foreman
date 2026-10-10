// Programmatic child scratch (retro-harvest item 5). Every single-child launch gets its own dir
// `<os.tmpdir()>/pi-foreman-scratch/<sessionId>/<launchId>` (mode 0700), named in a short prompt
// block and, through the launch binding (usage.ts), as the child's env FOREMAN_SCRATCH. The child
// keeps copies, mutation checks and temp files there instead of in the repo or `.workflow/`.
// The launching session removes the dir when the run ends (`child_scratch {bytes, files}` trace,
// then fs.rmSync after a realpath check that it lies under the root this module created and not
// in or around the repo) and sweeps its session root at shutdown; `ceremony.childScratch.keep`
// keeps them. Harness code only: no model turn and no guard sees the removal.
//
// What the guards allow inside a scratch dir (never outside it):
//   - permoverlay.ts: a child may cd into its own dir (`$FOREMAN_SCRATCH` is expanded);
//   - shell_write_guard.py: a planner child (confined) may write into its own dir;
//   - the review link (review.ts, timeoutallow.ts): a forwarded child ask whose command only
//     copies into, makes, removes inside or cds into a live scratch dir of the asking role, or
//     whose write path lies inside one, is allowed without the model (label `child-scratch`).
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

export interface ScratchFs {
  platform?: string;
  tmpdir?: () => string;
  uid?: () => number | null;
}

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

/** Create the launch's scratch dir; null when anything is off (the launch then has none). */
export function createScratch(sessionId: string, launchId: string, deps: ScratchFs = {}): string | null {
  const root = scratchRoot(deps);
  if (!root || !mkdirOwn(root, deps)) return null;
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
  const root = scratchRoot(deps);
  const realRoot = root ? realNative(root) : null;
  const abs = path.resolve(dir);
  try {
    const st = fs.lstatSync(abs);
    if (!st.isDirectory() || st.isSymbolicLink()) return { removed: false, reason: "not_dir" };
  } catch {
    return { removed: false, reason: "missing" };
  }
  const real = realNative(abs);
  if (!realRoot || !real || !strictlyInside(realRoot, real, platform) || !strictlyInside(realRoot, abs, platform)) return { removed: false, reason: "outside_root" };
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

/** The session's root (`<root>/<sessionId>`), for the shutdown sweep. */
export function sessionScratchDir(sessionId: string, deps: ScratchFs = {}): string | null {
  const root = scratchRoot(deps);
  return root ? path.join(root, safeId(sessionId)) : null;
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

  take(launchId: string): { dir: string; role: string } | undefined {
    const e = this.launches.get(launchId);
    this.launches.delete(launchId);
    return e;
  }

  /** Live scratch dirs, of one role when given (a forwarded ask names only its role). */
  live(role?: string | null): string[] {
    return [...this.launches.values()].filter((e) => !role || e.role === role || e.role === "*").map((e) => e.dir);
  }
}

// ------------------------------------------------------------- deterministic allow

/**
 * Replace `$FOREMAN_SCRATCH` / `${FOREMAN_SCRATCH}` outside single quotes by `dir`; null when the
 * dir holds a character the shell would read (then nothing is resolved and the caller refuses).
 */
export function expandScratchVar(command: string, dir: string): string | null {
  if (/[\s'"\\$`*?[\]{}()<>|;&!#~]/.test(dir)) return null;
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
      const m = /^\$(?:\{FOREMAN_SCRATCH\}|FOREMAN_SCRATCH(?![A-Za-z0-9_]))/.exec(command.slice(i));
      if (m) {
        out += dir;
        i += m[0].length - 1;
        continue;
      }
    }
    out += c;
  }
  return out;
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

const CMD_SYNTAX = /[|<>`$()\n\r]/;

/**
 * True when every `&&`/`;` unit of `command` is a scratch operation inside `dirs` (cp/mkdir/rm
 * with every destination or operand strictly inside, cd into one) or passes `unitOk`, and at
 * least one unit is a scratch operation. POSIX only. `$FOREMAN_SCRATCH` is resolved per dir.
 */
export function scratchCommandAllowed(command: string, dirs: string[], unitOk: (unit: string) => boolean, platform: string = process.platform): boolean {
  if (platform === "win32" || !dirs.length) return false;
  for (const d of dirs) {
    const text = expandScratchVar(command, d);
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
    while (k < args.length && args[k].startsWith("-")) if (!/^-[rRapf]+$/.test(args[k++])) return false;
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
}

const keepOf = (h: ScratchHost): boolean => get(h.config.config, "ceremony.childScratch.keep") === true;
const reposOf = (h: ScratchHost): string[] => [h.cwd, workspaceOf(h.cwd).root];

/** At a single-child launch: create the dir, put it into the binding and the task, record it. */
export function launchScratch(h: ScratchHost, input: Record<string, unknown>, b: LaunchBinding, deps: ScratchFs = {}): void {
  const dir = createScratch(h.id, b.launchId, deps);
  if (!dir) {
    h.trace?.emit({ event: "child_scratch", role: b.role, action: "unavailable" });
    return;
  }
  b.scratch = dir;
  h.scratch.add(b.launchId, dir, b.role);
  if (typeof input.task === "string") input.task = `${input.task}\n\n${scratchPromptBlock(dir)}`;
}

/**
 * Explorer run end: write the full report to `<scratch>/<session>/brief-<run>/explorer-brief.md`
 * and register that dir as a live scratch dir of every role (role "*"), so a builder or reviewer
 * reads it with the read tool without an ask (review link: child-scratch). The session sweep
 * removes it at shutdown. Returns the file path, or null when anything is off.
 */
export function storeBrief(h: ScratchHost, runId: string, text: string, deps: ScratchFs = {}): string | null {
  const id = `brief-${safeId(runId)}`;
  const dir = createScratch(h.id, id, deps);
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
  const r = removeScratch(e.dir, reposOf(h), deps);
  h.trace?.emit({ event: "child_scratch", role: e.role, bytes: st.bytes, files: st.files, action: r.removed === true ? "removed" : r.reason === "missing" ? "gone" : `refused_${r.reason}` });
}

/** Session shutdown: remove the session's whole scratch root unless kept. */
export function sweepScratch(h: ScratchHost, deps: ScratchFs = {}): void {
  if (keepOf(h)) return;
  const dir = sessionScratchDir(h.id, deps);
  if (dir) removeScratch(dir, reposOf(h), deps);
}
