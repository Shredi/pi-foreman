// R41 path rules (ledger item 5): the default allow of the path tools (read, write, edit, grep, find, ls, foreman_move, foreman_copy),
// computed at runtime from the session's roots. Floors (secret paths) run before this; a path outside every root is no allow and
// falls through to the review (`undefined`). Rule names are `path-<read|write>-<class>`.
import * as fs from "node:fs";
import * as path from "node:path";

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
  child: boolean;
  role: string;
  /** `gate.tmpAccess` (default true): writes (and for the owner reads) under the OS temp dirs. */
  tmpAccess: boolean;
  /** The Pi agent dir (settings.json, pi-foreman/state); the self-modification rules read it. */
  agentDir?: string;
  /** The dir of the session's own Pi session file (moving it, or an ancestor up to `<agentDir>/sessions`, is a self-modification ask). */
  sessionDir?: string;
  /** Injectable for tests: realpath of an existing path, null when it does not exist. */
  realpath?: (p: string) => string | null;
}

export type PathVerdict = { allow: true; rule: string } | undefined;

const px = (platform: string): typeof path.posix => (platform === "win32" ? path.win32 : path.posix);
const parts = (platform: string, p: string): string[] => px(platform).resolve(p).split(/[\\/]+/).filter(Boolean).map((s) => (platform === "win32" ? s.toLowerCase() : s));

/** `p` at or below `root` (`*` segments of the root match any one segment). Lexical. */
export function under(platform: string, root: string, p: string): boolean {
  const rs = parts(platform, root);
  const ps = parts(platform, p);
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
  const x = px(platform);
  const tail: string[] = [];
  let e = abs;
  for (;;) {
    const r = real(e);
    if (r !== null) return x.join(r, ...tail);
    const d = x.dirname(e);
    if (d === e) return abs;
    tail.unshift(x.basename(e));
    e = d;
  }
}

/** The absolute form of a path word, or null (empty, `~`, NUL, a drive-relative `C:x`). */
export function resolveWord(platform: string, cwd: string, w: unknown): string | null {
  if (typeof w !== "string" || !w || w.includes("\0") || w.startsWith("~")) return null;
  if (platform === "win32" && /^[A-Za-z]:(?![\\/])/.test(w)) return null;
  return px(platform).resolve(cwd, w);
}

type Dir = "read" | "write";

/** The class of root `abs` lies in for `dir`, or null. The real spelling must stay inside the same root (no symlink out). */
function classOf(r: GateRoots, platform: string, abs: string, dir: Dir): string | null {
  const real = r.realpath ?? (platform === process.platform ? realDefault : () => null);
  const ra = realSpelling(platform, abs, real);
  const inside = (root: string): boolean => {
    if (!under(platform, root, abs)) return false;
    if (ra === abs) return true;
    return under(platform, root, ra) || (!root.includes("*") && under(platform, real(root) ?? root, ra));
  };
  const gitFree = (root: string): boolean => !px(platform).relative(root, abs).split(/[\\/]/).includes(".git");
  const noWrite = dir === "write";
  if (inside(r.worktree) && (!noWrite || gitFree(r.worktree))) return "worktree";
  if (r.scratch.some((d) => inside(d) && (!noWrite || gitFree(d)))) return "scratch";
  if (dir === "read" && r.roundFlow.some(inside)) return "round-workflow";
  if (dir === "read" && r.install.some(inside)) return "install";
  if (dir === "read" && r.handoffs.some(inside)) return "handoff";
  if (dir === "write") {
    const base = px(platform).basename(abs);
    if (r.handoffs.some((h) => px(platform).dirname(abs) === px(platform).resolve(h) && inside(h)) && (base === "plan.md" || base === "result.md")) return "handoff";
  }
  if (r.child) return null;
  if (r.tmpAccess && r.tmp.some(inside) && !(r.scratchBase && inside(r.scratchBase))) return "tmp";
  if (dir === "read" && r.owned.some(inside)) return "owned";
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
