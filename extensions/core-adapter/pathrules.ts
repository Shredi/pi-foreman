// R41 path rules (ledger item 5): the default allow of the path tools (read, write, edit, grep, find, ls, foreman_move, foreman_copy),
// computed at runtime from the session's roots. Floors (secret paths) run before this; a path outside every root is no allow and
// falls through to the review (`undefined`). Rule names are `path-<read|write>-<class>`.
import * as fs from "node:fs";
import * as path from "node:path";
import { longForm } from "./pathnorm.ts";

/** The roots of one session, resolved by index.ts at call time. All paths absolute. */
export interface GateRoots {
  /** The worktree (workspace top) the call runs in. */
  worktree: string;
  /** The session's live scratch dirs (a child: its own `$FOREMAN_SCRATCH`). */
  scratch: string[];
  /** The OS temp dirs (real spelling) and `/tmp`. */
  tmp: string[];
  /** `<tmp>/pi-foreman-scratch`: other sessions' scratch dirs live below it and are never a tmp default. */
  scratchBase?: string;
  /** Owned roots (agent dir state, handoffs, sibling worktrees); `*` stands for one path segment. Reads only. */
  owned: string[];
  /** The Pi install root, the global npm root and the bundled package roots (reads only). */
  install: string[];
  /** The registered round-parent `.workflow` dirs of this session (reads only). */
  roundFlow: string[];
  /** The session's own handoff dirs: `plan.md` and `result.md` may be written, the dir read. */
  handoffs: string[];
  /** Handoff dirs of sessions this session opened (its id is in the dir's `parent` file): `ruling*.md` and `brief*.md` may be written there. */
  openedHandoffs?: string[];
  child: boolean;
  role: string;
  /** `gate.tmpAccess` (default true): writes (and for the owner reads) under the OS temp dirs. */
  tmpAccess: boolean;
  /** The Pi agent dir (settings.json, pi-foreman/state); the self-modification rules read it. */
  agentDir?: string;
  /** The dir of the session's own Pi session file (moving it, or an ancestor up to `<agentDir>/sessions`, is a self-modification ask). */
  sessionDir?: string;
  /** Work folders of the user file (permconfig.ts), each as written and in its real spelling. Foreman only; a child gets none. Reads in them are allowed; writes relax only in `auto` ones (`workFolderOf`). */
  workFolders?: { path: string; mode: "auto" | "read" }[];
  /** The pi-foreman package root; `install` holds only the roots below it. A work folder never relaxes writes under it. */
  pkgRoot?: string;
  /** Injectable for tests: realpath of an existing path, null when it does not exist. */
  realpath?: (p: string) => string | null;
}

export type PathVerdict = { allow: true; rule: string } | undefined;

const px = (platform: string): typeof path.posix => (platform === "win32" ? path.win32 : path.posix);

/** A win32 path segment that is `name` (`.git`) as Windows spells it: trailing dots and spaces dropped, or the 8.3 short name `git~N`. */
const winAlias = (s: string, name: string): boolean => {
  const bare = s.replace(/[. ]+$/, "").toLowerCase();
  return bare === name || new RegExp(`^${name.slice(1)}~\\d+$`).test(bare);
};
const parts = (platform: string, p: string, base?: string): string[] => px(platform).resolve(...(base ? [base, p] : [p])).split(/[\\/]+/).filter(Boolean).map((s) => (platform === "win32" ? s.toLowerCase() : s));

/** `p` at or below `root` (`*` segments of the root match any one segment). Lexical. */
export function under(platform: string, root: string, p: string, base?: string): boolean {
  const rs = parts(platform, root, base);
  const ps = parts(platform, p, base);
  if (rs.length === 0 || ps.length < rs.length) return false;
  return rs.every((s, i) => s === "*" || s === ps[i]);
}

export function realDefault(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** The real spelling of `abs`: its deepest existing ancestor through realpath, the rest appended. */
export function realSpelling(platform: string, abs: string, real: (p: string) => string | null): string {
  return longForm(platform, abs, real);
}

/** The absolute form of a path word, or null (empty, `~`, NUL, a drive-relative `C:x`). */
export function resolveWord(platform: string, cwd: string, w: unknown): string | null {
  if (typeof w !== "string" || !w || w.includes("\0") || w.startsWith("~")) return null;
  if (platform === "win32" && /^[A-Za-z]:(?![\\/])/.test(w)) return null;
  return px(platform).resolve(cwd, w);
}

type Dir = "read" | "write";

/** The parent's notes to a session it opened: `ruling*.md`, `brief*.md` (a plain file name, no separator). */
const HANDOFF_NOTE = /^(?:ruling|brief)[A-Za-z0-9._-]*\.md$/;

/**
 * `abs` lies inside `root` (`*` segments match one segment): lexical on the given spelling, then the real spelling must stay inside the same root
 * (no symlink out). Relative roots resolve against `base`. win32: a root and a path may spell one dir differently (8.3 `RUNNER~1`, case, a drive-less `/tmp`),
 * so long forms count too.
 */
export function rootHolds(root: string, abs: string, platform: string, realpath?: (p: string) => string | null, base?: string): boolean {
  const real = realpath ?? (platform === process.platform ? realDefault : () => null);
  const ra = realSpelling(platform, abs, real);
  const win = platform === "win32";
  const longRoot = (r: string): string => realSpelling(platform, base ? px(platform).resolve(base, r) : px(platform).resolve(r), real);
  if (!under(platform, root, abs, base)) return win && !root.includes("*") && under(platform, longRoot(root), ra, base);
  if (ra === abs) return true;
  return under(platform, root, ra, base) || (!root.includes("*") && under(platform, real(root) ?? root, ra, base)) || (win && !root.includes("*") && under(platform, longRoot(root), ra, base));
}

/**
 * Protected places inside a work folder, in either spelling of `abs`: a `.git` segment, a `.pi` segment outside its `scratch` and `tasks` subtrees
 * (selfmod.ts), the Pi agent dir, any install root and the package root. One predicate for path tools and, through `extraWriteGuard`, the shell.
 */
export function folderProtected(r: GateRoots, platform: string, abs: string): boolean {
  const real = r.realpath ?? (platform === process.platform ? realDefault : () => null);
  // `.git` and `.pi` match case-insensitively on every platform: a `.GIT` on Linux is a distinct dir, but the protection must not be weaker there.
  // The `scratch`/`tasks` exception stays per platform (folded only where the file system folds), so `.pi/SCRATCH` on Linux is still protected.
  // win32: a trailing dot or space, or the 8.3 short name of `name` (`GIT~1`, `PI~1`). Any other `~N` (the CI temp base `RUNNER~1`) is no alias of it.
  const named = (s: string, name: string): boolean => s.toLowerCase() === name || (platform === "win32" && winAlias(s, name));
  const fold = (s: string): string => (platform === "win32" || platform === "darwin" ? s.toLowerCase() : s);
  for (const p of new Set([abs, realSpelling(platform, abs, real)])) {
    const segs = p.split(/[\\/]+/).filter(Boolean);
    if (segs.some((s) => named(s, ".git"))) return true;
    if (segs.some((s, i) => named(s, ".pi") && !(i + 1 < segs.length && ["scratch", "tasks"].includes(fold(segs[i + 1]))))) return true;
    const guarded = [r.agentDir, r.pkgRoot, ...r.install].filter((x): x is string => !!x);
    if (guarded.some((g) => [g, real(g)].some((x) => !!x && rootHolds(x, p, platform, r.realpath, r.worktree)))) return true;
  }
  return false;
}

/** The innermost work folder `abs` lies in, or undefined when none does or `abs` is a protected place. The only entry point for write relaxation. */
export function workFolderOf(r: GateRoots, platform: string, abs: string): { path: string; mode: "auto" | "read" } | undefined {
  let best: { path: string; mode: "auto" | "read" } | undefined;
  for (const f of r.workFolders ?? []) {
    if (!rootHolds(f.path, abs, platform, r.realpath, r.worktree)) continue;
    if (!best || px(platform).resolve(f.path).length > px(platform).resolve(best.path).length) best = f;
  }
  return best && !folderProtected(r, platform, abs) ? best : undefined;
}

/** The class of root `abs` lies in for `dir`, or null. The real spelling must stay inside the same root (no symlink out). */
function classOf(r: GateRoots, platform: string, abs: string, dir: Dir): string | null {
  const real = r.realpath ?? (platform === process.platform ? realDefault : () => null);
  const ra = realSpelling(platform, abs, real);
  const win = platform === "win32";
  // win32: a root and a path may spell one dir differently (8.3 `RUNNER~1`, case, a drive-less `/tmp`): resolve both against the worktree and compare long forms too
  const longRoot = (root: string): string => realSpelling(platform, px(platform).resolve(r.worktree, root), real);
  const inside = (root: string): boolean => rootHolds(root, abs, platform, r.realpath, r.worktree);
  const gitFree = (root: string): boolean => !px(platform).relative(root, abs).split(/[\\/]/).includes(".git");
  const noWrite = dir === "write";
  if (inside(r.worktree) && (!noWrite || gitFree(r.worktree))) return "worktree";
  if (r.scratch.some((d) => inside(d) && (!noWrite || gitFree(d)))) return "scratch";
  if (dir === "read" && r.roundFlow.some(inside)) return "round-workflow";
  if (dir === "read" && r.install.some(inside)) return "install";
  if (dir === "read" && r.handoffs.some(inside)) return "handoff";
  if (dir === "write") {
    const base = win ? px(platform).basename(abs).toLowerCase() : px(platform).basename(abs);
    // win32: the directory may be spelled short (`RUNNER~1`) or in another case, so its long form counts too
    const sameDir = (h: string, d: string): boolean => under(platform, d, h, r.worktree) && under(platform, h, d, r.worktree);
    const dirs = win ? [px(platform).dirname(abs), px(platform).dirname(ra)] : [px(platform).dirname(abs)];
    if (r.handoffs.some((h) => dirs.some((d) => sameDir(h, d) || (win && !h.includes("*") && sameDir(longRoot(h), d))) && inside(h)) && (base === "plan.md" || base === "result.md")) return "handoff";
    if (!r.child && HANDOFF_NOTE.test(base) && (r.openedHandoffs ?? []).some((h) => dirs.some((d) => sameDir(h, d) || (win && !h.includes("*") && sameDir(longRoot(h), d))) && inside(h))) return "handoff-ruling";
  }
  if (r.child) return null;
  if (r.tmpAccess && r.tmp.some(inside) && !(r.scratchBase && inside(r.scratchBase))) return "tmp";
  if (dir === "read" && r.owned.some(inside)) return "owned";
  if (dir === "read" && (r.workFolders ?? []).some((f) => inside(f.path))) return "owned";
  return null;
}

const GLOBBED = (w: unknown): boolean => typeof w === "string" && (px("posix").isAbsolute(w) || /^[A-Za-z]:|^[\\/]|^~/.test(w) || w.split(/[\\/]/).includes(".."));

/** The path operations of a path tool call: [path word, direction]; null when the input names none this module understands. */
export function opsOf(tool: string, inp: Record<string, unknown>): Array<[unknown, Dir]> | null {
  const p = inp.path ?? inp.file_path ?? inp.filePath;
  switch (tool) {
    case "read":
      return p === undefined ? null : [[p, "read"]];
    case "write":
    case "edit":
      return p === undefined ? null : [[p, "write"]];
    case "ls":
      return [[p ?? ".", "read"]];
    case "grep":
    case "find":
      // a glob that is absolute or climbs out names files beyond the path root: no default
      if (GLOBBED(inp.glob) || (tool === "find" && GLOBBED(inp.pattern))) return null;
      return [[p ?? ".", "read"]];
    case "foreman_move":
      return [[inp.src, "write"], [inp.dst, "write"]];
    case "foreman_copy":
      return [[inp.src, "read"], [inp.dst, "write"]];
    default:
      return null;
  }
}

export const PATH_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "write", "edit", "grep", "find", "ls", "foreman_move", "foreman_copy"]);

/** The default allow of a path tool call, or undefined (review decides). */
export function pathDecide(tool: string, input: unknown, cwd: string, roots: GateRoots, platform: string = process.platform): PathVerdict {
  const inp = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const ops = opsOf(tool, inp);
  if (!ops) return undefined;
  let rule: string | undefined;
  for (const [w, dir] of ops) {
    const abs = resolveWord(platform, cwd, w);
    if (!abs) return undefined;
    const cls = classOf(roots, platform, abs, dir);
    if (!cls) return undefined;
    rule ??= `path-${dir}-${cls}`;
  }
  return rule ? { allow: true, rule } : undefined;
}

/** True when every path operation of a path tool call lies in one and the same `auto` work folder, outside every protected place (the mode step's relaxation). */
export function inOneAutoFolder(tool: string, input: unknown, cwd: string, roots: GateRoots, platform: string = process.platform): boolean {
  const ops = opsOf(tool, (input && typeof input === "object" ? input : {}) as Record<string, unknown>);
  if (!ops || ops.length === 0 || roots.child) return false;
  let folder: string | undefined;
  for (const [w] of ops) {
    const abs = resolveWord(platform, cwd, w);
    const f = abs ? workFolderOf(roots, platform, abs) : undefined;
    if (!f || f.mode !== "auto" || (folder !== undefined && folder !== f.path)) return false;
    folder = f.path;
  }
  return true;
}
