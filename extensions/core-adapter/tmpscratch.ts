// Deterministic allow for a child's scratch copy under /tmp (label `tmp-scratch`): a child that copies the
// workspace aside (`cp -r /app /tmp/x`) or makes a scratch dir (`mkdir -p /tmp/x`) otherwise goes to the
// model review and, headless, is denied. Only one simple command is handled, nothing chained:
//   cp [-r|-R|-a|-p, also combined] <src>... <dest>     mkdir [-p] <dest>...
// Every destination must be an absolute path under /tmp/ (no `..`, not /tmp itself) whose deepest
// existing ancestor really lies inside /tmp (a symlink planted in /tmp cannot lead out). Sources may
// be anything readable. No rm in any form: `rm -rf /tmp/...` stays reviewed. POSIX only; on Windows
// it never matches. Words are parsed by sedread.ts `shellWords` (bare words and plain quotes only).
import * as fs from "node:fs";
import * as path from "node:path";
import { shellWords } from "./sedread.ts";

const SHELL_SYNTAX = /[;&|<>`$()\n\r]/;
const CP_FLAGS = /^-[rRap]+$/;

export interface TmpScratchDeps {
  platform?: string;
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

/** True when the whole `command` is one `cp`/`mkdir` call that writes only under /tmp/ (see the header). */
export function isTmpScratch(command: string, deps: TmpScratchDeps = {}): boolean {
  if ((deps.platform ?? process.platform) === "win32") return false;
  if (SHELL_SYNTAX.test(command)) return false;
  const w = shellWords(command.trim());
  if (!w || w.length < 2) return false;
  const [prog, ...args] = w;
  let k = 0;
  if (prog === "cp") {
    while (k < args.length && args[k].startsWith("-")) if (!CP_FLAGS.test(args[k++])) return false;
    const ops = args.slice(k);
    if (ops.length < 2 || ops.some((o) => !o || o.startsWith("-"))) return false;
    return tmpDest(ops[ops.length - 1], deps);
  }
  if (prog === "mkdir") {
    while (k < args.length && args[k].startsWith("-")) if (args[k++] !== "-p") return false;
    const ops = args.slice(k);
    return ops.length > 0 && ops.every((o) => !o.startsWith("-") && tmpDest(o, deps));
  }
  return false;
}
