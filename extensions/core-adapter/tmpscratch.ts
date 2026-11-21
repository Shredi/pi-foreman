// A scratch destination under /tmp (effects.ts `tmp-scratch` write class): an absolute path under /tmp/ (no `..`, not /tmp itself) whose deepest
// existing ancestor really lies inside /tmp, so a symlink planted in /tmp cannot lead out. POSIX only; on Windows effects.ts never asks.
import * as fs from "node:fs";
import * as path from "node:path";

export interface TmpScratchDeps {
  /** realpath of an existing path, or null; injectable for tests. */
  realpath?: (p: string) => string | null;
  exists?: (p: string) => boolean;
}

const defaultRealpath = (p: string): string | null => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
};

/** True when `dest` is a normalized path under /tmp/ whose deepest existing ancestor resolves inside /tmp. */
export function tmpDest(dest: string, deps: TmpScratchDeps = {}): boolean {
  if (!dest.startsWith("/tmp/") || dest.split("/").includes("..")) return false;
  const norm = path.posix.normalize(dest).replace(/\/+$/, "");
  if (!norm.startsWith("/tmp/")) return false;
  const real = deps.realpath ?? defaultRealpath;
  // lstat: a dangling symlink counts as existing, so its failed realpath refuses it.
  const exists = deps.exists ?? ((p: string) => { try { fs.lstatSync(p); return true; } catch { return false; } });
  const tmp = real("/tmp");
  if (!tmp) return false;
  let p = norm;
  while (p !== "/tmp" && !exists(p)) p = path.posix.dirname(p);
  const r = real(p);
  if (r === null || !(r === tmp || r.startsWith(tmp.replace(/\/+$/, "") + "/"))) return false;
  if (p !== norm) return true;
  // The destination itself exists: it must not be a symlink (its realpath is its parent's plus its name).
  const parent = real(path.posix.dirname(norm));
  return parent !== null && r === `${parent.replace(/\/+$/, "")}/${path.posix.basename(norm)}`;
}
